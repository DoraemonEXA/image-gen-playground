import { png } from '../mock-provider';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { generateSync } from 'otplib';

test('OTP consent, MCP generation, anonymous image downloads, and grant revocation work over HTTP', async ({
    page,
    browser
}) => {
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
    let downloadUrl = '';
    try {
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://localhost:3111/mcp'), {
                requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } }
            })
        );
        expect((await client.listTools()).tools).toHaveLength(4);
        const generated = await client.callTool({
            name: 'generate_image',
            arguments: { request_id: 'browser-download', prompt: 'A square' }
        });
        expect(generated.isError).not.toBe(true);
        const generationId = (generated.structuredContent as { generation_id: string }).generation_id;
        let imageId = '';
        await expect
            .poll(async () => {
                const response = await client.callTool({
                    name: 'get_generation',
                    arguments: { generation_id: generationId }
                });
                const result = response.structuredContent as {
                    state: string;
                    images: { image_id: string; download_url: string; download_url_expires_at: string }[];
                };
                if (result.state === 'complete') {
                    imageId = result.images[0].image_id;
                    downloadUrl = result.images[0].download_url;
                    expect(Date.parse(result.images[0].download_url_expires_at)).toBeGreaterThan(Date.now());
                }
                return result.state;
            })
            .toBe('complete');
        const inline = await client.callTool({ name: 'get_image', arguments: { image_id: imageId } });
        expect(inline.content[0].type).toBe('image');
        const linked = inline.structuredContent as { download_url: string };
        const bytes = await fetch(linked.download_url);
        expect(bytes.status).toBe(200);
        expect(Buffer.from(await bytes.arrayBuffer())).toEqual(Buffer.from(png, 'base64'));
        const head = await fetch(downloadUrl, { method: 'HEAD' });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
        // Next.js controls wire framing and strips route-provided Content-Length.
        expect(head.headers.get('content-type')).toBe('image/png');
        expect(head.headers.get('cache-control')).toContain('no-store');
        expect(head.headers.get('referrer-policy')).toBe('no-referrer');
        expect((await fetch(`http://localhost:3111/api/image/${imageId}`)).status).toBe(401);
        const anonymous = await browser.newContext();
        try {
            const preview = await anonymous.newPage();
            await preview.setContent('<img alt="Generated preview">');
            await preview.getByAltText('Generated preview').evaluate((element, url) => {
                (element as HTMLImageElement).src = url;
            }, downloadUrl);
            await expect
                .poll(() =>
                    preview
                        .getByAltText('Generated preview')
                        .evaluate((element) => (element as HTMLImageElement).naturalWidth)
                )
                .toBeGreaterThan(0);
            expect(await anonymous.cookies()).toEqual([]);
        } finally {
            await anonymous.close();
        }
    } finally {
        await client.close();
    }
    await page.goto('/connections');
    await expect(page.getByRole('heading', { name: '已连接的智能体', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Browser test agent' })).toBeVisible();
    await page.screenshot({ path: '.cache/oauth-connections-zh-dark.png', fullPage: true });
    await page.getByRole('button', { name: '撤销授权', exact: true }).click();
    await expect(page.getByText('暂无已连接的智能体。')).toBeVisible();
    const downloadRejected = await fetch(downloadUrl);
    expect(downloadRejected.status).toBe(404);
    expect(downloadRejected.headers.get('cache-control')).toContain('no-store');
    const rejected = await page.request.post('/mcp', {
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json, text/event-stream' },
        data: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    });
    expect(rejected.status()).toBe(401);
    expect(errors).toEqual([]);
});
