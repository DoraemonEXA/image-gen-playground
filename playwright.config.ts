import { defineConfig } from '@playwright/test';
import fs from 'node:fs';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
export default defineConfig({
    testDir: './tests/browser',
    workers: 1,
    globalTeardown: './tests/browser-teardown.ts',
    timeout: 45_000,
    use: {
        baseURL: 'http://localhost:3111',
        headless: true,
        launchOptions: {
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (fs.existsSync(edge) ? edge : undefined)
        },
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    webServer: {
        command: 'node --import tsx tests/browser-server.ts',
        url: 'http://localhost:3111/api/health',
        reuseExistingServer: false,
        timeout: 60_000
    }
});
