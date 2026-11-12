import { expect, test } from '@playwright/test';

test('display preferences follow the system, persist, and localize public screens', async ({ page, context }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/login');
    await expect(page.locator('html')).toHaveClass('light');
    await expect(page.getByLabel('Theme', { exact: true })).toHaveValue('system');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass('dark');
    await page.getByLabel('Theme', { exact: true }).selectOption('light');
    await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await page.getByLabel('用户名', { exact: true }).fill('missing-user');
    await page.getByLabel('身份验证器验证码', { exact: true }).fill('000000');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '用户名或验证码无效。' })).toBeVisible();
    await page.reload();
    await expect(page.locator('html')).toHaveClass('light');
    await expect(page.getByLabel('语言', { exact: true })).toHaveValue('zh-CN');
    const other = await context.newPage();
    await other.goto('/setup');
    await expect(other.getByRole('heading', { name: '设置管理员', exact: true })).toBeVisible();
    await other.getByLabel('主题', { exact: true }).selectOption('dark');
    await expect(page.locator('html')).toHaveClass('dark');
    await other.getByLabel('语言', { exact: true }).selectOption('en');
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    for (const locale of ['en', 'zh-CN']) {
        await page.locator('nav select').first().selectOption(locale);
        for (const theme of ['light', 'dark']) {
            await page.locator('nav select').nth(1).selectOption(theme);
            await page.setViewportSize({ width: 390, height: 844 });
            await expect(page.locator('html')).toHaveClass(theme);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            await page.screenshot({ path: `.cache/login-${locale}-${theme}.png`, fullPage: true });
        }
    }
    expect(errors).toEqual([]);
    await other.close();
});
