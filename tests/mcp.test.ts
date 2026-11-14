import { drainJobs, jobResult, startJob } from '../src/modules/mcp/jobs';
import { handleMcp } from '../src/modules/mcp/server';
import {
    confirmSetup,
    createUser,
    issueSetupToken,
    login,
    prepareSetup,
    resetAuthenticator,
    revoke,
    session,
    setEnabled
} from '../src/modules/multi-user/accounts';
import { adjustBalance, balance } from '../src/modules/multi-user/billing';
import { closeDatabases, database, recoverInterruptedRequests } from '../src/modules/multi-user/database';
import { deleteHistory, history } from '../src/modules/multi-user/history';
import { hash, randomToken } from '../src/modules/multi-user/secrets';
import {
    matchesRedirect,
    publicAddress,
    registerClient,
    resolveClient,
    validateClient
} from '../src/modules/oauth/clients';
import { ACCESS_MS, GRANT_MS, readLimited, resourceUrl, SCOPES } from '../src/modules/oauth/config';
import { handleOAuth, metadataResponse } from '../src/modules/oauth/http';
import {
    authenticate,
    beginAuthorization,
    completeAuthorization,
    connectedAgents,
    consentDetails,
    exchangeToken,
    revokeAgent,
    revokeToken
} from '../src/modules/oauth/store';
import { mockProvider, png } from './mock-provider';
import {
    auth,
    Client,
    type OAuthClientProvider,
    type OAuthDiscoveryState,
    type StoredOAuthClientInformation,
    type StoredOAuthTokens,
    StreamableHTTPClientTransport
} from '@modelcontextprotocol/client';
import { NextRequest } from 'next/server';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { generateSync } from 'otplib';

const origin = 'http://localhost:3100';
const root = path.resolve('.cache/mcp-tests');
let directory: string;
let provider: Awaited<ReturnType<typeof mockProvider>>;
let owner: { id: string; token: string; secret: string };

function browserRequest(route: string, token = owner.token, data?: unknown) {
    return new NextRequest(`${origin}${route}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers: {
            origin,
            cookie: `playground-local=${token}`,
            'x-playground-session': hash(token),
            'content-type': 'application/json'
        },
        body: data === undefined ? undefined : JSON.stringify(data)
    });
}
function bearer(token: string) {
    return new Request(resourceUrl(), { headers: { Authorization: `Bearer ${token}` } });
}
const metadata = () => ({
    client_name: 'Test coding agent',
    redirect_uris: ['http://127.0.0.1:4567/callback'],
    token_endpoint_auth_method: 'none'
});
async function user(name: string) {
    const { secret } = await createUser(name);
    const token = login(name, generateSync({ secret }), name);
    return { id: session(token)!.id, token, secret };
}
async function authorization(
    token = owner.token,
    scopes: readonly string[] = SCOPES,
    client = registerClient(metadata())
) {
    const verifier = randomToken();
    const params = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        response_type: 'code',
        resource: resourceUrl(),
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        scope: scopes.join(' '),
        state: 'preserved-state'
    });
    const requestId = await beginAuthorization(params);
    const identity = session(token)!;
    const details = consentDetails(requestId, identity);
    const redirect = new URL(completeAuthorization(requestId, details.csrf, true, identity));
    assert.equal(redirect.searchParams.get('state'), 'preserved-state');
    assert.equal(redirect.searchParams.get('iss'), origin);
    const exchange = new URLSearchParams({
        grant_type: 'authorization_code',
        code: redirect.searchParams.get('code')!,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        resource: resourceUrl(),
        code_verifier: verifier
    });
    return { exchange, client, params, verifier };
}
async function grant(token = owner.token, scopes: readonly string[] = SCOPES) {
    const setup = await authorization(token, scopes);
    const tokens = exchangeToken(setup.exchange);
    return { ...setup, tokens, principal: authenticate(bearer(tokens.access_token)) };
}
function refresh(tokens: { refresh_token: string }, clientId: string, now = Date.now()) {
    return exchangeToken(
        new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: tokens.refresh_token,
            resource: resourceUrl()
        }),
        now
    );
}

const localFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/mcp') return handleMcp(request);
    if (url.pathname === '/.well-known/oauth-authorization-server') return metadataResponse('authorization');
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return metadataResponse('resource');
    if (url.pathname.startsWith('/oauth/')) return handleOAuth(new NextRequest(request));
    return new Response(null, { status: 404 });
};

before(async () => {
    fs.mkdirSync(root, { recursive: true });
    provider = await mockProvider();
});
after(async () => {
    await provider.close();
});
beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(root, 'case-'));
    Object.assign(process.env, {
        APP_MODE: 'multi-user',
        MCP_ENABLED: 'true',
        APP_ORIGIN: origin,
        APP_DATA_DIR: directory,
        AUTH_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
        OPENAI_API_KEY: 'mock-key',
        OPENAI_API_BASE_URL: provider.url,
        MAX_ACTIVE_PER_USER: '1',
        MAX_ACTIVE_GLOBAL: '4',
        TRUST_PROXY: 'false'
    });
    const setup = new URLSearchParams(new URL(issueSetupToken()).hash.slice(1)).get('token')!;
    const { secret } = await prepareSetup(setup, 'owner');
    const token = confirmSetup(setup, generateSync({ secret }), 'setup');
    owner = { id: session(token)!.id, token, secret };
    adjustBalance(owner.id, 'add', '10', 'Test funds', 0);
});
afterEach(async () => {
    await drainJobs();
    closeDatabases();
    assert.ok(path.resolve(directory).startsWith(root + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
});

test('version 1 migration preserves accounts and balance, and is repeatable', () => {
    const db = database();
    db.exec(
        'DROP TABLE mcp_requests; DROP TABLE oauth_tokens; DROP TABLE oauth_codes; DROP TABLE oauth_grants; DROP TABLE oauth_requests; DROP TABLE oauth_clients; PRAGMA user_version=1;'
    );
    closeDatabases();
    assert.equal(database().pragma('user_version', { simple: true }), 2);
    assert.equal(balance().balance, 100000);
    assert.equal(session(owner.token)?.id, owner.id);
    closeDatabases();
    assert.equal(database().pragma('user_version', { simple: true }), 2);
});

test('MCP is opt-in and multi-user only; discovery advertises exact resource and OAuth capabilities', async () => {
    delete process.env.MCP_ENABLED;
    assert.equal((await handleMcp(new Request(resourceUrl()))).status, 404);
    assert.equal(metadataResponse('authorization').status, 404);
    process.env.MCP_ENABLED = 'true';
    process.env.APP_MODE = 'single-user';
    assert.equal((await handleOAuth(new NextRequest(`${origin}/oauth/register`, { method: 'POST' }))).status, 404);
    process.env.APP_MODE = 'multi-user';
    const resource = await metadataResponse('resource').json();
    const authorization = await metadataResponse('authorization').json();
    assert.equal(resource.resource, resourceUrl());
    assert.deepEqual(authorization.code_challenge_methods_supported, ['S256']);
    assert.equal(authorization.client_id_metadata_document_supported, true);
    const unauth = await handleMcp(new Request(resourceUrl()));
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get('www-authenticate')!, /oauth-protected-resource\/mcp/);
});

test('authorization rejects bad redirects, missing PKCE, wrong resource, duplicate parameters and unknown scopes', async () => {
    const setup = await authorization();
    for (const [key, value] of [
        ['redirect_uri', 'https://evil.example/cb'],
        ['code_challenge_method', 'plain'],
        ['code_challenge', 'bad'],
        ['resource', `${origin}/other`],
        ['scope', 'admin']
    ]) {
        const params = new URLSearchParams(setup.params);
        params.set(key, value);
        await assert.rejects(beginAuthorization(params));
    }
    const repeated = new URLSearchParams(setup.params);
    repeated.append('state', 'other');
    await assert.rejects(beginAuthorization(repeated), /Duplicate/);
    for (const uri of [
        'javascript:alert(1)',
        'http://example.com/cb',
        'https://a.example/cb#fragment',
        'https://a:b@example.com/cb'
    ]) {
        assert.throws(() => registerClient({ ...metadata(), redirect_uris: [uri] }));
    }
});

test('consent requires the same browser session, CSRF and explicit approval; denial preserves state', async () => {
    const setup = await authorization();
    const requestId = await beginAuthorization(setup.params);
    const identity = session(owner.token)!;
    const details = consentDetails(requestId, identity);
    assert.throws(() => completeAuthorization(requestId, 'wrong', true, identity), /confirmation/);
    const alice = await user('alice');
    assert.throws(() => consentDetails(requestId, session(alice.token)!), /session changed/);
    const noCsrf = new NextRequest(`${origin}/oauth/decision`, {
        method: 'POST',
        headers: { origin, cookie: `playground-local=${owner.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ request_id: requestId, csrf: details.csrf, approve: true })
    });
    assert.equal((await handleOAuth(noCsrf)).status, 401);
    const denied = await handleOAuth(
        browserRequest('/oauth/decision', owner.token, { request_id: requestId, csrf: details.csrf, approve: false })
    );
    const target = new URL((await denied.json()).redirect);
    assert.equal(target.searchParams.get('error'), 'access_denied');
    assert.equal(target.searchParams.get('state'), 'preserved-state');
    assert.equal(target.searchParams.get('iss'), origin);
    assert.throws(() => completeAuthorization(requestId, details.csrf, true, identity), /expired/);
    assert.throws(() => consentDetails('missing', identity), /Invalid/);
});

test('code exchange enforces PKCE, client, redirect and resource, then revokes on valid code replay', async () => {
    const { exchange } = await authorization();
    for (const [key, value] of [
        ['code_verifier', randomToken()],
        ['client_id', randomToken()],
        ['redirect_uri', 'http://127.0.0.1:9999/callback'],
        ['resource', `${origin}/other`]
    ]) {
        const bad = new URLSearchParams(exchange);
        bad.set(key, value);
        assert.throws(() => exchangeToken(bad));
    }
    const tokens = exchangeToken(exchange);
    assert.equal(tokens.expires_in, ACCESS_MS / 1000);
    assert.equal(authenticate(bearer(tokens.access_token)).user.id, owner.id);
    assert.throws(() => exchangeToken(exchange), /already used/);
    assert.throws(() => authenticate(bearer(tokens.access_token)), /invalid or expired/);
});

test('a revoked browser session cannot confirm an authorization already loaded in the browser', async () => {
    const { params } = await authorization();
    const id = await beginAuthorization(params);
    const identity = session(owner.token)!;
    const details = consentDetails(id, identity);
    await resetAuthenticator(owner.id, true);
    assert.throws(() => completeAuthorization(id, details.csrf, true, identity), /session changed/);
});

test('tokens are hashed, refresh rotates, replay revokes its family, and grants have a fixed expiry', async () => {
    const { tokens, client, principal } = await grant();
    const rows = database().prepare('SELECT hash FROM oauth_tokens').all() as { hash: string }[];
    assert.ok(rows.every((row) => row.hash !== tokens.access_token && row.hash !== tokens.refresh_token));
    const expiry = (
        database().prepare('SELECT expires FROM oauth_grants WHERE id=?').get(principal.grantId) as { expires: number }
    ).expires;
    assert.throws(() => authenticate(bearer(tokens.access_token), Date.now() + ACCESS_MS + 100), /expired/);
    const rotated = refresh(tokens, client.client_id);
    assert.notEqual(rotated.refresh_token, tokens.refresh_token);
    assert.equal(authenticate(bearer(rotated.access_token)).grantId, principal.grantId);
    assert.equal(
        (
            database().prepare('SELECT expires FROM oauth_grants WHERE id=?').get(principal.grantId) as {
                expires: number;
            }
        ).expires,
        expiry
    );
    assert.throws(() => refresh(tokens, client.client_id), /already used/);
    assert.throws(() => authenticate(bearer(rotated.access_token)), /expired/);
    const other = await grant();
    assert.throws(() => refresh(other.tokens, other.client.client_id, Date.now() + GRANT_MS + 100), /Invalid refresh/);
});

test('revocation is owner-scoped; browser logout is independent; disable and authenticator reset revoke grants', async () => {
    const alice = await user('alice');
    const first = await grant(alice.token);
    revokeAgent(owner.id, first.principal.grantId);
    assert.equal(authenticate(bearer(first.tokens.access_token)).user.id, alice.id);
    revoke(alice.token);
    assert.equal(authenticate(bearer(first.tokens.access_token)).user.id, alice.id);
    assert.equal(connectedAgents(owner.id).length, 0);
    setEnabled(alice.id, false);
    assert.throws(() => authenticate(bearer(first.tokens.access_token)));
    setEnabled(alice.id, true);
    assert.throws(() => refresh(first.tokens, first.client.client_id));
    const second = await grant();
    await resetAuthenticator(owner.id, true);
    assert.throws(() => authenticate(bearer(second.tokens.access_token)));
});

test('revocation endpoint does not reveal token existence and cannot revoke a different client', async () => {
    const { tokens, client } = await grant();
    revokeToken(tokens.refresh_token, 'other-client');
    authenticate(bearer(tokens.access_token));
    revokeToken('unknown', client.client_id);
    revokeToken(tokens.refresh_token, client.client_id);
    assert.throws(() => authenticate(bearer(tokens.access_token)));
});

test('client metadata rejects private network targets and validates cached metadata', async () => {
    for (const address of [
        '127.0.0.1',
        '10.0.0.1',
        '169.254.169.254',
        '100.64.0.1',
        '192.168.1.2',
        '::1',
        '::ffff:127.0.0.1',
        'fc00::1',
        '2002:7f00:1::'
    ])
        assert.equal(publicAddress(address), false);
    assert.equal(publicAddress('8.8.8.8'), true);
    assert.equal(publicAddress('2606:4700:4700::1111'), true);
    for (const id of [
        'http://example.com/client.json',
        'https://127.0.0.1/client.json',
        'https://[::1]/client.json',
        'https://example.com/',
        'https://localhost/client.json'
    ])
        await assert.rejects(resolveClient(id));
    const id = 'https://client.example/metadata.json';
    const data = validateClient({ ...metadata(), client_id: id }, id);
    database()
        .prepare('INSERT INTO oauth_clients VALUES(?,?,?,?)')
        .run(id, JSON.stringify(data), Date.now(), Date.now() + 60_000);
    assert.deepEqual(await resolveClient(id), data);
});

test('registration is throttled and bounded; MCP rejects hostile host and origin', async () => {
    for (let index = 0; index < 30; index++) {
        assert.equal((await handleOAuth(browserRequest('/oauth/register', owner.token, metadata()))).status, 201);
    }
    assert.equal((await handleOAuth(browserRequest('/oauth/register', owner.token, metadata()))).status, 429);
    const { tokens } = await grant();
    const maliciousHeaders: Record<string, string>[] = [{ origin: 'https://evil.example' }, { host: 'evil.example' }];
    for (const headers of maliciousHeaders) {
        assert.equal(
            (
                await handleMcp(
                    new Request(resourceUrl(), {
                        headers: { ...headers, authorization: `Bearer ${tokens.access_token}` }
                    })
                )
            ).status,
            403
        );
    }
    await assert.rejects(readLimited(new Request(origin, { method: 'POST', body: '12345' }), 4), /too large/);
});

test('metadata fetching pins public DNS, honors cache, and rejects redirects, private answers and bad documents', async (t) => {
    const id = 'https://agent.example/metadata.json';
    let address = '8.8.8.8',
        status = 200,
        calls = 0;
    let document = JSON.stringify({ ...metadata(), client_id: id });
    t.mock.method(dns, 'lookup', async () => [{ address, family: 4 }]);
    t.mock.method(https, 'get', (...args: unknown[]) => {
        calls++;
        const options = args[1] as {
            agent: boolean;
            lookup: (
                host: string,
                opts: object,
                callback: (error: unknown, address: string, family: number) => void
            ) => void;
        };
        assert.equal(options.agent, false);
        options.lookup('agent.example', {}, (error, pinned, family) => {
            assert.equal(error, null);
            assert.equal(pinned, address);
            assert.equal(family, 4);
        });
        const callback = args[2] as (response: PassThrough) => void;
        const response = Object.assign(new PassThrough(), {
            statusCode: status,
            headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' }
        });
        queueMicrotask(() => {
            callback(response);
            if (!response.destroyed) response.end(document);
        });
        return new EventEmitter();
    });
    const now = Date.now();
    assert.equal((await resolveClient(id, now)).client_id, id);
    assert.equal((await resolveClient(id, now + 1000)).client_id, id);
    assert.equal(calls, 1);
    address = '127.0.0.1';
    await assert.rejects(resolveClient(id, now + 301_000), /public HTTPS/);
    assert.equal(calls, 1);
    address = '8.8.8.8';
    status = 302;
    await assert.rejects(resolveClient(id, now + 301_000), /Could not load/);
    status = 200;
    document = JSON.stringify({ ...metadata(), client_id: 'https://other.example/client.json' });
    await assert.rejects(resolveClient(id, now + 301_000), /does not match/);
    document = JSON.stringify({ ...metadata(), client_id: id, extra: 'x'.repeat(65_536) });
    await assert.rejects(resolveClient(id, now + 301_000), /Could not load/);
});

test('native callbacks allow ephemeral ports while HTTPS callbacks, authorization expiry and PKCE remain strict', async () => {
    assert.equal(matchesRedirect('http://127.0.0.1:1234/cb?a=1', 'http://127.0.0.1:5432/cb?a=1'), true);
    for (const requested of [
        'http://localhost:5432/cb?a=1',
        'http://127.0.0.1:5432/other?a=1',
        'http://127.0.0.1:5432/cb?a=2'
    ]) {
        assert.equal(matchesRedirect('http://127.0.0.1:1234/cb?a=1', requested), false);
    }
    assert.equal(matchesRedirect('https://agent.example/cb', 'https://agent.example:8443/cb'), false);
    const { exchange, params } = await authorization();
    assert.throws(() => exchangeToken(exchange, Date.now() + 6 * 60_000), /Invalid authorization code/);
    params.set('redirect_uri', 'http://127.0.0.1:9876/callback');
    const id = await beginAuthorization(params);
    assert.throws(() => consentDetails(id, session(owner.token)!, Date.now() + 16 * 60_000), /expired/);
    const details = consentDetails(id, session(owner.token)!);
    assert.equal(new URL(completeAuthorization(id, details.csrf, true, session(owner.token)!)).port, '9876');
});

test('HTTP scope challenges identify the missing permission; cookie and query tokens cannot authenticate MCP', async () => {
    const { tokens } = await grant(owner.token, ['images:read']);
    const response = await handleMcp(
        new Request(resourceUrl(), {
            method: 'POST',
            headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'generate_image', arguments: { request_id: 'denied', prompt: 'no' } }
            })
        })
    );
    assert.equal(response.status, 403);
    assert.match(response.headers.get('www-authenticate')!, /scope="images:generate"/);
    assert.equal((await handleMcp(browserRequest('/mcp'))).status, 401);
    assert.equal((await handleMcp(new Request(`${resourceUrl()}?access_token=${tokens.access_token}`))).status, 401);
    assert.equal((database().prepare('SELECT COUNT(*) n FROM generations').get() as { n: number }).n, 0);
});

test('official SDK completes discovery, dynamic registration and PKCE token exchange', async () => {
    let clientInfo: StoredOAuthClientInformation | undefined, tokens: StoredOAuthTokens | undefined;
    let verifier = '',
        authorizationUrl: URL | undefined;
    let discovery: OAuthDiscoveryState | undefined;
    const oauth: OAuthClientProvider = {
        redirectUrl: metadata().redirect_uris[0],
        clientMetadata: { ...metadata(), token_endpoint_auth_method: 'none' },
        clientInformation: () => clientInfo,
        saveClientInformation: (value) => {
            clientInfo = value;
        },
        tokens: () => tokens,
        saveTokens: (value) => {
            tokens = value;
        },
        redirectToAuthorization: (url) => {
            authorizationUrl = url;
        },
        saveCodeVerifier: (value) => {
            verifier = value;
        },
        codeVerifier: () => verifier,
        state: () => 'sdk-state',
        discoveryState: () => discovery,
        saveDiscoveryState: (value) => {
            discovery = value;
        }
    };
    assert.equal(await auth(oauth, { serverUrl: resourceUrl(), fetchFn: localFetch }), 'REDIRECT');
    assert.ok(authorizationUrl);
    const initial = await handleOAuth(new NextRequest(authorizationUrl));
    assert.equal(initial.status, 303);
    const requestId = new URL(initial.headers.get('location')!).searchParams.get('request')!;
    const details = await (await handleOAuth(browserRequest(`/oauth/request?request=${requestId}`))).json();
    const decision = await handleOAuth(
        browserRequest('/oauth/decision', owner.token, { request_id: requestId, csrf: details.csrf, approve: true })
    );
    const callback = new URL((await decision.json()).redirect);
    assert.equal(callback.searchParams.get('state'), 'sdk-state');
    assert.equal(
        await auth(oauth, {
            serverUrl: resourceUrl(),
            fetchFn: localFetch,
            authorizationCode: callback.searchParams.get('code')!,
            iss: callback.searchParams.get('iss')!
        }),
        'AUTHORIZED'
    );
    assert.ok(tokens?.access_token);
    authenticate(bearer(tokens.access_token));
    const previousRefresh = tokens.refresh_token;
    assert.equal(
        await auth(oauth, { serverUrl: resourceUrl(), fetchFn: localFetch, scope: SCOPES.join(' ') }),
        'AUTHORIZED'
    );
    assert.notEqual(tokens.refresh_token, previousRefresh);
    authenticate(bearer(tokens.access_token));
});

test('official MCP client generates, edits, polls and retrieves images using current and legacy protocol versions', async () => {
    const { tokens } = await grant();
    for (const version of ['2026-07-28', '2025-11-25']) {
        const client = new Client(
            { name: 'integration-test', version: '1' },
            {
                supportedProtocolVersions: [version],
                versionNegotiation: { mode: version === '2026-07-28' ? 'auto' : 'legacy' }
            }
        );
        const transport = new StreamableHTTPClientTransport(new URL(resourceUrl()), {
            fetch: localFetch,
            requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } }
        });
        try {
            await client.connect(transport);
            const tools = await client.listTools();
            assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
                'edit_image',
                'generate_image',
                'get_generation',
                'get_image'
            ]);
            const result = await client.callTool({
                name: 'generate_image',
                arguments: { request_id: `sdk-${version}`, prompt: 'A square' }
            });
            assert.ok(!result.isError, JSON.stringify(result));
            const id = (result.structuredContent as { generation_id: string }).generation_id;
            await drainJobs();
            const status = await client.callTool({ name: 'get_generation', arguments: { generation_id: id } });
            const state = status.structuredContent as { state: string; images: { image_id: string }[] };
            assert.equal(state.state, 'complete');
            const image = await client.callTool({
                name: 'get_image',
                arguments: { image_id: state.images[0].image_id }
            });
            assert.equal(image.content[0].type, 'image');
            const edit = await client.callTool({
                name: 'edit_image',
                arguments: {
                    request_id: `edit-${version}`,
                    prompt: 'Add blue',
                    images: [{ image_id: state.images[0].image_id }],
                    mask: { data: png, mime_type: 'image/png' }
                }
            });
            assert.ok(!edit.isError, JSON.stringify(edit));
            await drainJobs();
        } finally {
            await client.close();
        }
    }
    assert.equal(
        (database().prepare('SELECT COUNT(*) n FROM ledger WHERE generation_id IS NOT NULL').get() as { n: number }).n,
        4
    );
});

test('concurrent retries and retry after restart reuse one paid generation; conflicting reuse fails', async () => {
    const { principal } = await grant();
    const start = provider.calls();
    const args = { request_id: 'same', prompt: 'mock-delay one square' };
    const [a, b] = await Promise.all([startJob(principal, 'generate', args), startJob(principal, 'generate', args)]);
    assert.equal(a, b);
    await assert.rejects(startJob(principal, 'generate', { ...args, prompt: 'different' }), /different inputs/);
    assert.equal(jobResult(principal, a).state, 'running');
    await drainJobs();
    closeDatabases();
    assert.equal(await startJob(principal, 'generate', args), a);
    assert.equal(provider.calls() - start, 1);
    assert.equal(
        (database().prepare('SELECT COUNT(*) n FROM ledger WHERE generation_id=?').get(a) as { n: number }).n,
        1
    );
    assert.equal(history(owner.id).items[0].id, a);
    deleteHistory(owner.id, [a]);
    assert.equal(await startJob(principal, 'generate', args), a);
    assert.throws(() => jobResult(principal, a), /not found/);
});

test('billing and capacity limits apply across browser and MCP, and errors never trigger automatic retries', async () => {
    const { principal } = await grant();
    const before = provider.calls();
    const id = await startJob(principal, 'generate', { request_id: 'delay', prompt: 'mock-delay' });
    await assert.rejects(startJob(principal, 'generate', { request_id: 'busy', prompt: 'other' }), /capacity/);
    await drainJobs();
    assert.equal(provider.calls() - before, 1);
    assert.equal(jobResult(principal, id).accounting, 'settled');
    const failed = await startJob(principal, 'generate', { request_id: 'failure', prompt: 'mock-error' });
    await drainJobs();
    assert.equal(jobResult(principal, failed).state, 'failed');
    assert.equal(jobResult(principal, failed).accounting, 'needs_reconciliation');
    assert.equal(await startJob(principal, 'generate', { request_id: 'failure', prompt: 'mock-error' }), failed);
    assert.equal(provider.calls() - before, 2);
    const current = balance();
    adjustBalance(owner.id, 'set', '0', 'Zero', current.version);
    await assert.rejects(
        startJob(principal, 'generate', { request_id: 'zero', prompt: 'none' }),
        /balance is exhausted/
    );
    assert.equal(provider.calls() - before, 2);
});

test('isolation, scopes, input bounds and revocation are enforced before starting provider work', async () => {
    const alice = await user('alice');
    const first = await grant();
    const other = await grant(alice.token);
    const readOnly = await grant(owner.token, ['images:read']);
    const id = await startJob(first.principal, 'generate', { request_id: 'owner', prompt: 'square' });
    await drainJobs();
    const imageId = jobResult(first.principal, id).images[0].image_id;
    assert.throws(() => jobResult(other.principal, id), /not found/);
    assert.throws(() => jobResult(readOnly.principal, id), /not found/);
    await assert.rejects(
        startJob(other.principal, 'edit', { request_id: 'foreign', prompt: 'edit', images: [{ image_id: imageId }] }),
        /not found/
    );
    await assert.rejects(startJob(readOnly.principal, 'generate', { request_id: 'read', prompt: 'square' }), /scope/);
    await assert.rejects(
        startJob(first.principal, 'edit', {
            request_id: 'bad',
            prompt: 'edit',
            images: [{ data: '####', mime_type: 'image/png' }]
        }),
        /base64/
    );
    await assert.rejects(
        startJob(first.principal, 'edit', {
            request_id: 'many',
            prompt: 'edit',
            images: Array.from({ length: 17 }, () => ({ data: png, mime_type: 'image/png' }))
        })
    );
    revokeAgent(owner.id, first.principal.grantId);
    await assert.rejects(startJob(first.principal, 'generate', { request_id: 'revoked', prompt: 'square' }), /expired/);
});

test('SVG charges include writer usage, missing usage needs reconciliation, and startup never reruns a job', async () => {
    const { principal } = await grant();
    const id = await startJob(principal, 'generate', { request_id: 'svg', prompt: 'svg', output_format: 'svg' });
    await drainJobs();
    assert.ok(jobResult(principal, id).cost);
    const unknown = await startJob(principal, 'generate', { request_id: 'unknown', prompt: 'mock-no-usage' });
    await drainJobs();
    assert.equal(jobResult(principal, unknown).accounting, 'needs_reconciliation');
    database().prepare("UPDATE generations SET active=1,state='running' WHERE id=?").run(unknown);
    recoverInterruptedRequests();
    assert.equal(jobResult(principal, unknown).state, 'interrupted');
    const before = provider.calls();
    assert.equal(await startJob(principal, 'generate', { request_id: 'unknown', prompt: 'mock-no-usage' }), unknown);
    assert.equal(provider.calls(), before);
});
