import fs from 'node:fs';

export default function teardown() {
    const file = '.cache/browser-e2e/server.pid';
    if (!fs.existsSync(file)) return;
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
        try {
            process.kill(pid);
        } catch {
            /* The test server may have already exited. */
        }
    }
    fs.unlinkSync(file);
}
