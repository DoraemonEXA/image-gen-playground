import { config, isMultiUser } from './config';
import { database } from './database';
import { cleanGarbage, deleteHistory } from './history';
import { setImmediate as yieldToServer } from 'node:timers/promises';

export const RETENTION_BATCH_SIZE = 100;
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * RETENTION_INTERVAL_MS;

export function retentionDays(value = process.env.IMAGE_RETENTION_DAYS): number {
    if (value === undefined) return 0;
    if (!/^\d+$/.test(value)) throw new Error('Invalid IMAGE_RETENTION_DAYS: use 0 or a positive whole number');
    const days = Number(value);
    if (!Number.isSafeInteger(days * DAY_MS)) throw new Error('Invalid IMAGE_RETENTION_DAYS: value is too large');
    return days;
}

/** Selection and tombstoning share a transaction; the existing deletion path preserves accounting. */
export function expireHistoryBatch(cutoff: number): number {
    if (!isMultiUser()) return 0;
    return database()
        .transaction(() => {
            const rows = database()
                .prepare(
                    'SELECT id,user_id FROM generations WHERE deleted=0 AND active=0 AND created<? ORDER BY created,id LIMIT ?'
                )
                .all(cutoff, RETENTION_BATCH_SIZE) as Array<{ id: string; user_id: string }>;
            const owners = new Map<string, string[]>();
            for (const row of rows) owners.set(row.user_id, [...(owners.get(row.user_id) ?? []), row.id]);
            for (const [owner, ids] of owners) deleteHistory(owner, ids, false);
            return rows.length;
        })
        .immediate();
}

export async function runRetention(now = Date.now()) {
    if (!isMultiUser()) return 0;
    const days = retentionDays();
    if (!days) return 0;
    const cutoff = now - days * DAY_MS;
    let total = 0;
    let count: number;
    do {
        count = expireHistoryBatch(cutoff);
        total += count;
        await yieldToServer();
    } while (count === RETENTION_BATCH_SIZE);
    const garbage = { removed: 0, failed: 0 };
    let after = '';
    while (true) {
        const batch = cleanGarbage({ after, limit: RETENTION_BATCH_SIZE });
        garbage.removed += batch.removed;
        garbage.failed += batch.failed;
        if (!batch.next) break;
        after = batch.next;
        await yieldToServer();
    }
    if (total || garbage.removed || garbage.failed)
        console.info('Image retention sweep', { expired: total, ...garbage });
    return total;
}

// Persist across development module reloads. Production runs one process per private data volume.
const runtime = globalThis as typeof globalThis & {
    playgroundRetention?: { directory: string; timer: ReturnType<typeof setTimeout>; running: boolean };
};

export function startRetentionWorker() {
    if (!isMultiUser() || !retentionDays()) return;
    const directory = config().dataDir;
    if (runtime.playgroundRetention) {
        if (runtime.playgroundRetention.directory !== directory) throw new Error('Retention data directory changed');
        return;
    }
    const tick = async () => {
        const worker = runtime.playgroundRetention!;
        if (worker.running) return;
        worker.running = true;
        try {
            await runRetention();
        } catch (error) {
            console.error('Image retention sweep failed:', error instanceof Error ? error.name : 'Unknown error');
        } finally {
            worker.running = false;
            worker.timer = setTimeout(tick, RETENTION_INTERVAL_MS);
            worker.timer.unref();
        }
    };
    const timer = setTimeout(tick, 0);
    timer.unref();
    runtime.playgroundRetention = { directory, timer, running: false };
}
