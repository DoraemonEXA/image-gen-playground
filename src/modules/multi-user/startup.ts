import { config, isMultiUser } from './config';
import { database, recoverInterruptedRequests } from './database';
import { cleanGarbage } from './history';
import { retentionDays, startRetentionWorker } from './retention';
import { decrypt } from './secrets';
import fs from 'node:fs';

export function initializeRuntime() {
    if (!isMultiUser()) return;
    const settings = config();
    retentionDays();
    if (!process.env.APP_ORIGIN) throw new Error('APP_ORIGIN is required in multi-user mode');
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
    if (process.env.NEXT_PUBLIC_IMAGE_STORAGE_MODE === 'indexeddb')
        throw new Error('Multi-user mode requires server filesystem storage');
    const db = database();
    fs.accessSync(settings.dataDir, fs.constants.W_OK);
    const account = db.prepare('SELECT secret FROM users LIMIT 1').get() as { secret: string } | undefined;
    if (account) decrypt(account.secret); // Fail startup if the wrong encryption key was supplied.
    recoverInterruptedRequests();
    cleanGarbage();
    startRetentionWorker();
}
