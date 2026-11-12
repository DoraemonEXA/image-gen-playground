import { closeDatabases, database } from '../src/modules/multi-user/database';
import { RETENTION_INTERVAL_MS, startRetentionWorker } from '../src/modules/multi-user/retention';
import { initializeRuntime } from '../src/modules/multi-user/startup';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

test('startup runs retention without traffic and a single worker sweeps again hourly', async (context) => {
    const root = path.resolve('.cache/tests');
    fs.mkdirSync(root, { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, 'worker-'));
    Object.assign(process.env, {
        APP_MODE: 'multi-user',
        APP_ORIGIN: 'http://localhost:3000',
        APP_DATA_DIR: directory,
        AUTH_ENCRYPTION_KEY: 'c'.repeat(64),
        OPENAI_API_KEY: 'unused-mock-key',
        IMAGE_RETENTION_DAYS: '1'
    });
    delete process.env.NEXT_PUBLIC_IMAGE_STORAGE_MODE;
    context.mock.timers.enable({ apis: ['setTimeout'] });
    try {
        initializeRuntime();
        const state = (globalThis as typeof globalThis & { playgroundRetention?: unknown }).playgroundRetention;
        startRetentionWorker();
        assert.equal((globalThis as typeof globalThis & { playgroundRetention?: unknown }).playgroundRetention, state);
        database()
            .prepare("INSERT INTO users(id,username,role,secret,created) VALUES('owner','owner','user','unused',1)")
            .run();
        const seed = (id: string) =>
            database()
                .prepare('INSERT INTO generations(id,user_id,created,model,metadata,active) VALUES(?,?,?,?,?,0)')
                .run(id, 'owner', 1, 'gpt-image-2', '{}');
        const expired = (id: string) =>
            (database().prepare('SELECT deleted FROM generations WHERE id=?').get(id) as { deleted: number }).deleted;
        seed('startup');
        context.mock.timers.tick(1);
        await setImmediate();
        await setImmediate();
        assert.equal(expired('startup'), 1);
        seed('hourly');
        context.mock.timers.tick(RETENTION_INTERVAL_MS - 1);
        assert.equal(expired('hourly'), 0);
        context.mock.timers.tick(1);
        await setImmediate();
        await setImmediate();
        assert.equal(expired('hourly'), 1);
    } finally {
        context.mock.timers.reset();
        closeDatabases();
        assert.ok(directory.startsWith(root + path.sep));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
