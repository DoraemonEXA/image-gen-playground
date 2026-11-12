import { mockProvider } from './mock-provider';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
    const directory = path.resolve('.cache/browser-e2e');
    if (!directory.startsWith(path.resolve('.cache') + path.sep)) throw new Error('Invalid test data directory');
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    const mock = await mockProvider();
    const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', '3111'], {
        stdio: 'inherit',
        windowsHide: true,
        env: {
            ...process.env,
            APP_MODE: 'multi-user',
            APP_ORIGIN: 'http://localhost:3111',
            APP_DATA_DIR: directory,
            AUTH_ENCRYPTION_KEY: 'b'.repeat(64),
            OPENAI_API_KEY: 'mock-key',
            OPENAI_API_BASE_URL: mock.url,
            TRUST_PROXY: 'false'
        }
    });
    fs.writeFileSync(path.join(directory, 'server.pid'), String(child.pid));
    child.on('exit', async (code) => {
        await mock.close();
        process.exit(code || 0);
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
