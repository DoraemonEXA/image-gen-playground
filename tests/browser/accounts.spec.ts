import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { generateSync } from 'otplib';

test('bootstrap, funding, account provisioning, private generations, logout and cross-device history', async ({
    page,
    browser
}) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    const link = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/admin.ts', 'setup-link'], {
        encoding: 'utf8',
        windowsHide: true,
        env: {
            ...process.env,
            APP_MODE: 'multi-user',
            APP_ORIGIN: 'http://localhost:3111',
            APP_DATA_DIR: path.resolve('.cache/browser-e2e'),
            AUTH_ENCRYPTION_KEY: 'b'.repeat(64)
        }
    }).trim();
    await page.goto(link);
    await page.getByLabel('Admin username').fill('owner');
    await page.getByRole('button', { name: 'Generate authenticator QR' }).click();
    const secret = await page.locator('code').innerText();
    await page.getByLabel('Verify authenticator code').fill(generateSync({ secret }));
    await page.getByRole('button', { name: 'Activate administrator' }).click();
    await expect(page.getByRole('heading', { name: 'Administration', exact: true })).toBeVisible();
    await page.getByLabel('USD amount', { exact: true }).fill('2.0000');
    await page.getByLabel('Reason', { exact: true }).fill('Initial shared funds');
    await page.getByRole('button', { name: 'Update balance' }).click();
    await expect(page.getByRole('heading', { name: 'Shared balance: $2.0000' })).toBeVisible();
    await page.getByLabel('New username').fill('alice');
    await page.getByRole('button', { name: 'Create user' }).click();
    const aliceSecret = await page.locator('code').innerText();
    await page.screenshot({ path: '.cache/admin-preview.png', fullPage: true });

    const aliceContext = await browser.newContext();
    const alice = await aliceContext.newPage();
    alice.on('pageerror', (error) => consoleErrors.push(error.message));
    await alice.goto('/login');
    await alice.getByLabel('Username', { exact: true }).fill('alice');
    await alice.getByLabel('Authenticator code', { exact: true }).fill(generateSync({ secret: aliceSecret }));
    await alice.getByRole('button', { name: 'Sign in' }).click();
    await expect(alice.getByText('Shared balance:', { exact: false })).toBeVisible();
    await alice.evaluate(() =>
        localStorage.setItem(
            'openaiImageHistory',
            JSON.stringify([{ timestamp: 1, prompt: 'LEGACY_PRIVATE_SECRET', images: [{ filename: 'legacy.png' }] }])
        )
    );
    await alice.reload();
    await expect(alice.getByText('LEGACY_PRIVATE_SECRET')).toHaveCount(0);
    await alice.getByLabel('Prompt', { exact: true }).first().fill('A private blue square');
    const resultPromise = alice.waitForResponse(
        (response) => response.url().endsWith('/api/images') && response.request().method() === 'POST'
    );
    await alice
        .locator('button[type="submit"]')
        .filter({ hasText: /^Generate$/ })
        .click();
    const result = await (await resultPromise).json();
    await expect(alice.getByText('Shared balance:', { exact: false })).toContainText('$1.9889');
    await expect(alice.locator('img[src*="/api/image/"]').first()).toBeVisible();
    const secondContext = await browser.newContext({ storageState: await aliceContext.storageState() });
    const second = await secondContext.newPage();
    await second.goto('/');
    await expect(second.locator('img[src*="/api/image/"]').first()).toBeVisible();
    const adminRead = await page.request.get(`/api/image/${result.images[0].filename}`);
    expect(adminRead.status()).toBe(404);
    const optimized = await alice.request.get(
        `/_next/image?url=${encodeURIComponent(`/api/image/${result.images[0].filename}`)}&w=128&q=75`
    );
    expect(optimized.ok()).toBe(false);
    await alice.getByRole('checkbox', { name: 'Enable Streaming' }).check();
    await alice.getByLabel('Prompt', { exact: true }).first().fill('A private streamed square');
    await alice
        .locator('button[type="submit"]')
        .filter({ hasText: /^Generate$/ })
        .click();
    await expect(alice.getByText('Shared balance:', { exact: false })).toContainText('$1.9778');
    await expect(alice.locator('button[type="submit"]').filter({ hasText: /^Generate$/ })).toBeEnabled();
    await alice.screenshot({ path: '.cache/playground-preview.png', fullPage: true });

    const sameBrowserTab = await aliceContext.newPage();
    await sameBrowserTab.goto('/');
    await expect(sameBrowserTab.locator('img[src*="/api/image/"]').first()).toBeVisible();
    // Leave an authenticated page in the back stack before logging out.
    await alice.goto('/?back-test=1');
    await expect(alice.locator('img[src*="/api/image/"]').first()).toBeVisible();
    await alice.getByRole('button', { name: 'Sign out' }).click();
    await expect(alice).toHaveURL(/\/login$/);
    await expect(sameBrowserTab).toHaveURL(/\/login$/);
    await alice.goBack();
    await expect(alice).toHaveURL(/\/login$/);
    const anonymous = await alice.request.get(`/api/image/${result.images[0].filename}`);
    expect(anonymous.status()).toBe(401);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Shared balance: $1.9778' })).toBeVisible();
    await expect(page.getByText('A private blue square')).toHaveCount(0);
    expect(consoleErrors).toEqual([]);
    await secondContext.close();
    await aliceContext.close();
});
