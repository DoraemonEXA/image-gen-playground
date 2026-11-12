import { png } from '../mock-provider';
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
    await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
    await expect(page.getByRole('heading', { name: '设置管理员', exact: true })).toBeVisible();
    await page.getByLabel('主题', { exact: true }).selectOption('dark');
    await page.screenshot({ path: '.cache/setup-zh-dark.png', fullPage: true });
    await page.getByLabel('语言', { exact: true }).selectOption('en');
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

    await alice.getByLabel('Language', { exact: true }).selectOption('zh-CN');
    await alice.getByLabel('主题', { exact: true }).selectOption('light');
    await expect(alice.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await alice.getByRole('button', { name: '查看提示词', exact: true }).first().click();
    await expect(alice.getByRole('dialog')).toContainText('生成这组图片所使用的完整提示词。');
    await alice.screenshot({ path: '.cache/history-zh-light.png', fullPage: true });
    await alice.keyboard.press('Escape');
    await alice.getByRole('button', { name: '删除历史记录', exact: true }).first().click();
    await expect(alice.getByRole('dialog')).toContainText('不再询问');
    await alice.getByRole('button', { name: '取消', exact: true }).click();
    await alice.getByRole('tab', { name: '编辑', exact: true }).click();
    await expect
        .poll(() =>
            alice
                .getByRole('tab', { name: '编辑', exact: true })
                .evaluate(
                    (element) => getComputedStyle(element).backgroundColor === getComputedStyle(document.body).color
                )
        )
        .toBe(true);
    await alice.getByRole('textbox', { name: '提示词', exact: true }).fill('给图片添加蓝色边框');
    await alice
        .locator('input[type=file]')
        .first()
        .setInputFiles({ name: 'source.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await alice.getByRole('checkbox', { name: '启用流式预览' }).uncheck();
    const edited = alice.waitForResponse(
        (response) => response.url().endsWith('/api/images') && response.request().method() === 'POST'
    );
    await alice.getByRole('button', { name: '编辑图片', exact: true }).click();
    expect((await edited).ok()).toBe(true);
    await expect(alice.getByText('共享余额：', { exact: false })).toContainText('$1.9667');
    await alice.screenshot({ path: '.cache/edit-zh-light.png', fullPage: true });
    await alice.getByLabel('主题', { exact: true }).selectOption('dark');
    await expect
        .poll(() =>
            alice
                .getByRole('tab', { name: '编辑', exact: true })
                .evaluate(
                    (element) => getComputedStyle(element).backgroundColor === getComputedStyle(document.body).color
                )
        )
        .toBe(true);
    await alice.setViewportSize({ width: 390, height: 844 });
    await alice.screenshot({ path: '.cache/edit-zh-dark-mobile.png', fullPage: true });
    await alice.getByLabel('语言', { exact: true }).selectOption('en');

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
    await expect(page.getByRole('heading', { name: 'Shared balance: $1.9667' })).toBeVisible();
    await expect(page.getByText('A private blue square')).toHaveCount(0);
    await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
    await page.getByLabel('主题', { exact: true }).selectOption('light');
    await expect(page.getByRole('heading', { name: '管理后台', exact: true })).toBeVisible();
    await page.screenshot({ path: '.cache/admin-zh-light.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel('主题', { exact: true }).selectOption('dark');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: '.cache/admin-zh-dark-mobile.png', fullPage: true });
    expect(consoleErrors).toEqual([]);
    await secondContext.close();
    await aliceContext.close();
});
