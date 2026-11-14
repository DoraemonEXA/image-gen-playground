import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { generateSync } from 'otplib';

test('OTP login resumes consent, real HTTP MCP connects, and Connected agents revokes access', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const account = JSON.parse(
        execFileSync(process.execPath, ['--import', 'tsx', 'tests/oauth-browser-user.ts'], {
            encoding: 'utf8',
            windowsHide: true,
            env: {
                ...process.env,
                APP_MODE: 'multi-user',
                APP_ORIGIN: 'http://localhost:3111',
                APP_DATA_DIR: path.resolve('.cache/browser-e2e'),
                AUTH_ENCRYPTION_KEY: 'b'.repeat(64)
            }
        })
    );
    const redirectUri = 'http://127.0.0.1:49152/callback';
    const registration = await page.request.post('/oauth/register', {
        data: { client_name: 'Browser test agent', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }
    });
    expect(registration.status()).toBe(201);
    const clientInfo = await registration.json();
    const verifier = randomBytes(32).toString('base64url');
    const parameters = new URLSearchParams({
        response_type: 'code',
        client_id: clientInfo.client_id,
        redirect_uri: redirectUri,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        resource: 'http://localhost:3111/mcp',
        scope: 'images:generate images:edit images:read',
        state: 'browser-state'
    });
    await page.route(`${redirectUri}*`, (route) => route.fulfill({ contentType: 'text/plain', body: 'Connected.' }));
    await page.goto(`/oauth/authorize?${parameters}`);
    await expect(page).toHaveURL(/\/login\?oauth_request=/);
    await page.getByLabel('Username', { exact: true }).fill(account.username);
    await page.getByLabel('Authenticator code', { exact: true }).fill(generateSync({ secret: account.secret }));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Connect an agent', exact: true })).toBeVisible();
    await expect(page.getByText('Authorize Browser test agent as oauth-browser?')).toBeVisible();
    await expect(page.getByText('Generate images using the shared balance', { exact: true })).toBeVisible();
    await page.screenshot({ path: '.cache/oauth-consent-light.png', fullPage: true });
    await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
    await page.getByLabel('主题', { exact: true }).selectOption('dark');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: '.cache/oauth-consent-zh-dark.png', fullPage: true });
    await page.getByRole('button', { name: '批准授权', exact: true }).click();
    await expect(page).toHaveURL(/127\.0\.0\.1:49152\/callback\?/);
    const callback = new URL(page.url());
    expect(callback.searchParams.get('state')).toBe('browser-state');
    expect(callback.searchParams.get('iss')).toBe('http://localhost:3111');
    const tokenResponse = await page.request.post('/oauth/token', {
        form: {
            grant_type: 'authorization_code',
            client_id: clientInfo.client_id,
            code: callback.searchParams.get('code')!,
            code_verifier: verifier,
            redirect_uri: redirectUri,
            resource: 'http://localhost:3111/mcp'
        }
    });
    expect(tokenResponse.status()).toBe(200);
    const tokens = await tokenResponse.json();
    const client = new Client({ name: 'real-http-test', version: '1' });
    try {
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://localhost:3111/mcp'), {
                requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } }
            })
        );
        expect((await client.listTools()).tools).toHaveLength(4);
    } finally {
        await client.close();
    }
    await page.goto('/connections');
    await expect(page.getByRole('heading', { name: '已连接的智能体', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Browser test agent' })).toBeVisible();
    await page.screenshot({ path: '.cache/oauth-connections-zh-dark.png', fullPage: true });
    await page.getByRole('button', { name: '撤销授权', exact: true }).click();
    await expect(page.getByText('暂无已连接的智能体。')).toBeVisible();
    const rejected = await page.request.post('/mcp', {
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json, text/event-stream' },
        data: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    });
    expect(rejected.status()).toBe(401);
    expect(errors).toEqual([]);
});
