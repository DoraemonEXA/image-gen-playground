import type { HistoryMetadata } from '../../app/page';
import { AppError, assert, config } from './config';
import { database } from './database';
import fs from 'node:fs';
import path from 'node:path';

export type ServerHistory = HistoryMetadata & { id: string; state: string; accounting: string };
export function imagePath(userId: string, generationId: string, filename: string) {
    // Only server-generated IDs from database rows reach this function.
    return path.join(config().dataDir, 'images', userId, generationId, filename);
}

export function historyEntry(userId: string, id: string): ServerHistory | undefined {
    const row = database()
        .prepare('SELECT * FROM generations WHERE id=? AND user_id=? AND deleted=0')
        .get(id, userId) as
        | {
              id: string;
              created: number;
              metadata: string;
              cost_details: string | null;
              state: string;
              accounting: string;
          }
        | undefined;
    if (!row) return;
    const images = database()
        .prepare('SELECT filename FROM images WHERE generation_id=? AND user_id=? ORDER BY filename')
        .all(id, userId);
    return {
        ...JSON.parse(row.metadata),
        id: row.id,
        timestamp: row.created,
        images,
        storageModeUsed: 'fs',
        costDetails: row.cost_details ? JSON.parse(row.cost_details) : null,
        state: row.state,
        accounting: row.accounting
    };
}

export function history(userId: string, cursor?: string | null) {
    const db = database();
    let created = Number.MAX_SAFE_INTEGER;
    let id = '\uffff';
    if (cursor) {
        const row = db.prepare('SELECT id,created FROM generations WHERE id=? AND user_id=?').get(cursor, userId) as
            { id: string; created: number } | undefined;
        assert(row, 400, 'Invalid history cursor.');
        ({ created, id } = row);
    }
    const rows = db
        .prepare(
            `SELECT g.id FROM generations g WHERE user_id=? AND deleted=0 AND
        (created<? OR (created=? AND id<?)) AND EXISTS(SELECT 1 FROM images i WHERE i.generation_id=g.id)
        ORDER BY created DESC,id DESC LIMIT 51`
        )
        .all(userId, created, created, id) as Array<{ id: string }>;
    const totals = db
        .prepare(
            `SELECT COALESCE(SUM(cost_units),0) AS cost FROM generations g WHERE user_id=? AND deleted=0
        AND EXISTS(SELECT 1 FROM images i WHERE i.generation_id=g.id)`
        )
        .get(userId) as { cost: number };
    const count = db.prepare('SELECT COUNT(*) AS n FROM images WHERE user_id=?').get(userId) as { n: number };
    return {
        items: rows.slice(0, 50).map((row) => historyEntry(userId, row.id)!),
        summary: { totalCost: totals.cost / 10_000, totalImages: count.n },
        nextCursor: rows.length > 50 ? rows[49].id : null
    };
}

export function readImage(userId: string, filename: string) {
    const row = database()
        .prepare(
            `SELECT i.* FROM images i JOIN generations g ON g.id=i.generation_id
        WHERE i.filename=? AND i.user_id=? AND g.deleted=0`
        )
        .get(filename, userId) as
        { user_id: string; generation_id: string; filename: string; format: string } | undefined;
    assert(row, 404, 'Image not found.');
    try {
        return { buffer: fs.readFileSync(imagePath(row.user_id, row.generation_id, row.filename)), format: row.format };
    } catch {
        throw new AppError(404, 'Image not found.');
    }
}

export function cleanGarbage(batch?: { after: string; limit: number }) {
    const db = database();
    const root = path.resolve(config().dataDir, 'images');
    let removed = 0;
    let failed = 0;
    const rows = (
        batch
            ? db
                  .prepare('SELECT filepath FROM garbage WHERE filepath>? ORDER BY filepath LIMIT ?')
                  .all(batch.after, batch.limit)
            : db.prepare('SELECT filepath FROM garbage').all()
    ) as Array<{ filepath: string }>;
    for (const { filepath } of rows) {
        try {
            if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Unsafe image root');
            const relative = path.relative(root, path.resolve(filepath));
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
                throw new Error('Unsafe image path');
            // Reject symlink/junction traversal, including a replaced parent directory.
            let current = root;
            for (const part of relative.split(path.sep)) {
                current = path.join(current, part);
                if (
                    fs.existsSync(/* turbopackIgnore: true */ current) &&
                    fs.lstatSync(/* turbopackIgnore: true */ current).isSymbolicLink()
                )
                    throw new Error('Unsafe image link');
            }
            fs.rmSync(filepath, { force: true });
            db.prepare('DELETE FROM garbage WHERE filepath=?').run(filepath);
            removed++;
        } catch {
            /* Tombstoned content stays inaccessible; retry next cleanup. */
            failed++;
        }
    }
    return { removed, failed, ...(batch ? { next: rows.length === batch.limit ? rows.at(-1)!.filepath : null } : {}) };
}

export function deleteHistory(userId: string, ids?: string[], collectGarbage = true) {
    database()
        .transaction(() => {
            const db = database();
            const rows = ids
                ? ids.map((id) => {
                      const row = db
                          .prepare('SELECT id FROM generations WHERE id=? AND user_id=? AND deleted=0')
                          .get(id, userId) as { id: string } | undefined;
                      assert(row, 404, 'History not found.');
                      return row;
                  })
                : (db.prepare('SELECT id FROM generations WHERE user_id=? AND deleted=0').all(userId) as Array<{
                      id: string;
                  }>);
            for (const { id } of rows) {
                const state = db.prepare('SELECT active FROM generations WHERE id=?').get(id) as { active: number };
                assert(!state.active, 409, 'Wait for active generation to finish before clearing its history.');
                const images = db
                    .prepare('SELECT filename FROM images WHERE generation_id=? AND user_id=?')
                    .all(id, userId) as Array<{ filename: string }>;
                for (const image of images)
                    db.prepare('INSERT OR IGNORE INTO garbage VALUES(?)').run(imagePath(userId, id, image.filename));
                db.prepare('DELETE FROM images WHERE generation_id=? AND user_id=?').run(id, userId);
                db.prepare("UPDATE generations SET deleted=1,metadata='{}' WHERE id=? AND user_id=?").run(id, userId);
            }
        })
        .immediate();
    if (collectGarbage) cleanGarbage();
}

export function deleteImages(userId: string, filenames: string[]) {
    database()
        .transaction(() => {
            const db = database();
            const rows = filenames.map((filename) => {
                const row = db
                    .prepare(
                        `SELECT i.generation_id,g.active FROM images i JOIN generations g ON g.id=i.generation_id
                WHERE i.filename=? AND i.user_id=? AND g.deleted=0`
                    )
                    .get(filename, userId) as { generation_id: string; active: number } | undefined;
                assert(row, 404, 'Image not found.');
                assert(!row.active, 409, 'Wait for the active generation to finish.');
                return { ...row, filename };
            });
            for (const row of rows) {
                db.prepare('INSERT OR IGNORE INTO garbage VALUES(?)').run(
                    imagePath(userId, row.generation_id, row.filename)
                );
                db.prepare('DELETE FROM images WHERE filename=? AND user_id=?').run(row.filename, userId);
                if (!db.prepare('SELECT 1 FROM images WHERE generation_id=?').get(row.generation_id)) {
                    db.prepare("UPDATE generations SET deleted=1,metadata='{}' WHERE id=? AND user_id=?").run(
                        row.generation_id,
                        userId
                    );
                }
            }
        })
        .immediate();
    cleanGarbage();
}
