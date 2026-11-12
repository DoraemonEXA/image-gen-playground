import { expect, test } from '@playwright/test';

const account = {
    user: { id: 'focus-user', username: 'focus-user', role: 'user', sessionId: 'focus-session' },
    balance: 20_000,
    spending: 0,
    unresolved: 0
};

test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
    await page.route('**/api/auth-status', (route) => route.fulfill({ json: { mode: 'multi-user' } }));
    await page.route('**/api/multi-user/auth/me', (route) => route.fulfill({ json: account }));
    await page.route('**/api/multi-user/history', (route) =>
        route.fulfill({ json: { items: [], nextCursor: null, summary: { totalCost: 0, totalImages: 0 } } })
    );
    await page.goto('/');
    await expect(page.getByText('Shared balance:', { exact: false })).toContainText('$2.0000');
    await page.locator('#prompt').fill('Keep this draft when switching windows');
});

test('quick focus changes do not recheck the account or hide the playground', async ({ page }) => {
    let requests = 0;
    await page.route('**/api/multi-user/auth/me', async () => {
        requests++;
        // Hold the request to make any loading-state flicker observable.
    });
    await page.evaluate(() => {
        for (let index = 0; index < 5; index++) window.dispatchEvent(new Event('focus'));
    });
    await expect(page.locator('#prompt')).toBeVisible();
    await expect(page.locator('#prompt')).toHaveValue('Keep this draft when switching windows');
    await page.waitForLoadState('networkidle', { timeout: 3_000 });
    expect(requests).toBe(0);
});

test('a stale focus check stays in the background and coalesces repeated focus events', async ({ page }) => {
    let requests = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route('**/api/multi-user/auth/me', async (route) => {
        requests++;
        await pending;
        await route.fulfill({ json: { ...account, balance: 15_000 } });
    });
    // Advance freshness without running the periodic timer, as when a tab was suspended.
    await page.clock.setFixedTime(new Date('2026-01-01T00:01:01Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => requests).toBe(1);
    await expect(page.locator('#prompt')).toBeVisible();
    await page.evaluate(() => {
        for (let index = 0; index < 5; index++) window.dispatchEvent(new Event('focus'));
    });
    expect(requests).toBe(1);
    release();
    await expect(page.getByText('Shared balance:', { exact: false })).toContainText('$1.5000');
    await expect(page.locator('#prompt')).toHaveValue('Keep this draft when switching windows');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#prompt')).toBeVisible();
    await page.waitForLoadState('networkidle', { timeout: 3_000 });
    expect(requests).toBe(1);
});

test('periodic checks update the visible balance and share the focus freshness window', async ({ page }) => {
    let requests = 0;
    await page.route('**/api/multi-user/auth/me', async (route) => {
        requests++;
        await route.fulfill({ json: { ...account, balance: 10_000 } });
    });
    await page.clock.fastForward(60_000);
    await expect(page.getByText('Shared balance:', { exact: false })).toContainText('$1.0000');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForLoadState('networkidle', { timeout: 3_000 });
    expect(requests).toBe(1);
    await expect(page.locator('#prompt')).toHaveValue('Keep this draft when switching windows');
});

test('hidden tabs skip periodic checks and refresh when focused again', async ({ page }) => {
    let requests = 0;
    await page.route('**/api/multi-user/auth/me', async (route) => {
        requests++;
        await route.fulfill({ json: { ...account, balance: 10_000 } });
    });
    await page.evaluate(() =>
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    );
    await page.clock.fastForward(120_000);
    await page.waitForLoadState('networkidle', { timeout: 3_000 });
    expect(requests).toBe(0);
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        window.dispatchEvent(new Event('focus'));
    });
    await expect(page.getByText('Shared balance:', { exact: false })).toContainText('$1.0000');
    expect(requests).toBe(1);
});

for (const state of ['expired', 'replaced'] as const) {
    test(`${state} sessions still redirect to login on a stale focus check`, async ({ page }) => {
        await page.route('**/api/multi-user/auth/me', (route) =>
            route.fulfill({
                json: { ...account, user: state === 'expired' ? null : { ...account.user, sessionId: 'other-session' } }
            })
        );
        await page.clock.setFixedTime(new Date('2026-01-01T00:01:01Z'));
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(page).toHaveURL(/\/login$/);
    });
}
