import { POST as deleteRoute } from '../src/app/api/image-delete/route';
import { GET as imageRoute } from '../src/app/api/image/[filename]/route';
import { POST as generate } from '../src/app/api/images/route';
import {
    confirmSetup,
    createUser,
    issueSetupToken,
    login,
    prepareSetup,
    resetAuthenticator,
    session,
    setEnabled,
    sessionDuration
} from '../src/modules/multi-user/accounts';
import { handleAccountRequest } from '../src/modules/multi-user/api';
import { adjustBalance, adminOverview, balance, money, reconcile, settle } from '../src/modules/multi-user/billing';
import { closeDatabases, database, recoverInterruptedRequests } from '../src/modules/multi-user/database';
import { generationAccess } from '../src/modules/multi-user/generation';
import { deleteHistory, deleteImages, history, readImage } from '../src/modules/multi-user/history';
import { hash } from '../src/modules/multi-user/secrets';
import { mockProvider, usage } from './mock-provider';
import { NextRequest } from 'next/server';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';
import { generateSync } from 'otplib';

const origin = 'http://localhost:3100';
const testRoot = path.resolve('.cache/tests');
let directory: string;
let provider: Awaited<ReturnType<typeof mockProvider>>;
let admin: { id: string; token: string; secret: string };
const code = (secret: string, now = Date.now()) => generateSync({ secret, epoch: Math.floor(now / 1000) });
const tokenFrom = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('token')!;

function request(route: string, token?: string, data?: unknown) {
    return new NextRequest(`${origin}${route}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers: {
            origin,
            ...(token ? { cookie: `playground-local=${token}`, 'x-playground-session': hash(token) } : {}),
            ...(data instanceof FormData ? {} : { 'content-type': 'application/json' })
        },
        body: data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data)
    });
}
async function user(name: string) {
    const provision = await createUser(name);
    const token = login(name, code(provision.secret), name);
    return { id: session(token)!.id, token, secret: provision.secret };
}
function form(prompt = 'test', extra: Record<string, string> = {}) {
    const data = new FormData();
    for (const [key, value] of Object.entries({
        mode: 'generate',
        prompt,
        model: 'gpt-image-2.6-flare',
        quality: 'auto',
        output_format: 'png',
        ...extra
    }))
        data.set(key, value);
    if (extra.mode === 'edit')
        data.set('image_0', new File([new Uint8Array([1, 2, 3])], 'source.png', { type: 'image/png' }));
    return data;
}
function funds(amount = '10') {
    return adjustBalance(admin.id, 'add', amount, 'Test funds', 0);
}

before(async () => {
    fs.mkdirSync(testRoot, { recursive: true });
    provider = await mockProvider();
});
after(async () => {
    await provider.close();
});
beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(testRoot, 'case-'));
    Object.assign(process.env, {
        APP_MODE: 'multi-user',
        APP_ORIGIN: origin,
        AUTH_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
        APP_DATA_DIR: directory,
        OPENAI_API_KEY: 'mock-key-not-real',
        OPENAI_API_BASE_URL: provider.url,
        MAX_ACTIVE_PER_USER: '1',
        MAX_ACTIVE_GLOBAL: '4'
    });
    const token = tokenFrom(issueSetupToken());
    const provision = await prepareSetup(token, 'admin');
    const sessionToken = confirmSetup(token, code(provision.secret), 'setup');
    admin = { id: session(sessionToken)!.id, token: sessionToken, secret: provision.secret };
});
afterEach(() => {
    closeDatabases();
    assert.ok(path.resolve(directory).startsWith(testRoot + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
});

test('first-admin setup is permanently closed and bootstrap OTP cannot be replayed', async () => {
    assert.throws(() => issueSetupToken(), /permanently closed/);
    assert.throws(() => login('admin', code(admin.secret), 'admin'), /Invalid username/);
    const response = await handleAccountRequest(
        request('/api/multi-user/setup/confirm', undefined, { token: 'bad', code: '000000' })
    );
    assert.equal(response.status, 401);
});

test('setup token expiry, replacement, pending username, and simultaneous confirmation', async () => {
    closeDatabases();
    process.env.APP_DATA_DIR = path.join(directory, 'new-install');
    const expired = tokenFrom(issueSetupToken(Date.now() - 31 * 60_000));
    await assert.rejects(prepareSetup(expired, 'first'), /expired/);
    const old = tokenFrom(issueSetupToken());
    const token = tokenFrom(issueSetupToken());
    await assert.rejects(prepareSetup(old, 'first'), /expired/);
    const provision = await prepareSetup(token, 'first');
    await assert.rejects(prepareSetup(token, 'different'), /pending username/);
    const outcomes = await Promise.allSettled(
        [0, 1].map(() => Promise.resolve().then(() => confirmSetup(token, code(provision.secret), 'setup')))
    );
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal((database().prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n, 1);
});

test('login expiry, replay, recovery, disable and persistent throttling', async () => {
    const alice = await user('alice');
    assert.equal(session(alice.token, Date.now() + sessionDuration + 1), undefined);
    assert.throws(() => login('alice', code(alice.secret), 'alice'), /Invalid username/);
    setEnabled(alice.id, false);
    assert.equal(session(alice.token), undefined);
    setEnabled(alice.id, true);
    const replacement = await resetAuthenticator(alice.id);
    assert.throws(() => login('alice', code(alice.secret), 'alice'), /Invalid username/);
    assert.ok(session(login('alice', code(replacement.secret), 'alice')));
    for (let i = 0; i < 5; i++) assert.throws(() => login('unknown', '000000', 'brute'), /Invalid username/);
    closeDatabases();
    assert.throws(() => login('unknown', '000000', 'brute'), /Too many/);
    await resetAuthenticator(admin.id, true);
    assert.equal(session(admin.token), undefined);
    assert.throws(() => issueSetupToken(), /permanently closed/);
});

test('balance corrections are auditable, fixed-precision, and reject stale revisions', () => {
    assert.equal(balance().balance, 0);
    assert.equal(money('0.0001'), 1);
    assert.throws(() => money('0.00001'));
    const first = funds('0.1');
    funds('0.2');
    assert.equal(balance().balance, 3000);
    assert.throws(() => adjustBalance(admin.id, 'set', '1', 'stale', first.version), /changed/);
    adjustBalance(admin.id, 'set', '1', 'reconciled provider balance', balance().version);
    assert.equal(balance().balance, 10_000);
    assert.equal(adminOverview().ledger.length, 3);
});

test('generation is owner-scoped, charged once, persistent, and deletion preserves spending', async () => {
    const alice = await user('alice'),
        bob = await user('bob');
    funds();
    const result = await generate(request('/api/images', alice.token, form('private alice prompt', { n: '2' })));
    assert.equal(result.status, 200);
    const data = await result.json();
    assert.equal(data.images.length, 2);
    assert.equal(balance().balance, 100_000 - 111);
    settle(data.generationId, usage);
    assert.equal(balance().balance, 100_000 - 111);
    assert.equal(history(alice.id).items[0].prompt, 'private alice prompt');
    assert.equal(history(bob.id).items.length, 0);
    for (const token of [undefined, bob.token, admin.token]) {
        const response = await imageRoute(request(`/api/image/${data.images[0].filename}`, token), {
            params: Promise.resolve({ filename: data.images[0].filename })
        });
        assert.equal(response.status, token ? 404 : 401);
    }
    const blockedDelete = await deleteRoute(
        request('/api/image-delete', bob.token, { filenames: [data.images[0].filename] })
    );
    assert.equal(blockedDelete.status, 404);
    closeDatabases();
    assert.equal(history(alice.id).items.length, 1);
    assert.ok(readImage(alice.id, data.images[0].filename).buffer.length);
    deleteHistory(alice.id, [data.generationId]);
    assert.equal(history(alice.id).items.length, 0);
    assert.equal(balance().balance, 100_000 - 111);
    const view = JSON.stringify(adminOverview());
    assert.ok(!view.includes('private alice prompt') && !view.includes('b64_json'));
});

test('streaming generation and editing persist history and settle once', async () => {
    funds();
    for (const mode of ['generate', 'edit']) {
        const response = await generate(
            request('/api/images', admin.token, form('streaming test', { mode, stream: 'true' }))
        );
        assert.equal(response.status, 200);
        const events = (await response.text())
            .split('\n\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line.slice(6)));
        assert.ok(events.some((event) => event.type === 'partial_image'));
        assert.equal(events.at(-1).type, 'done');
        assert.equal(events.at(-1).history.state, 'complete');
    }
    assert.equal(history(admin.id).items.length, 2);
    assert.equal(balance().balance, 100_000 - 222);
});

test('SVG writer is charged and SVG delivery is sandboxed', async () => {
    funds();
    const response = await generate(
        request('/api/images', admin.token, form('svg', { output_format: 'svg', svg_model: 'gpt-6.1-sol' }))
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(balance().balance, 100_000 - 133);
    const image = await imageRoute(request(`/api/image/${data.images[0].filename}`, admin.token), {
        params: Promise.resolve({ filename: data.images[0].filename })
    });
    assert.match(image.headers.get('Content-Security-Policy')!, /sandbox/);
    assert.match(image.headers.get('Cache-Control')!, /no-store/);
});

test('missing usage is reconciled once and never silently treated as free', async () => {
    funds();
    const response = await generate(request('/api/images', admin.token, form('mock-no-usage')));
    const data = await response.json();
    assert.equal(data.history.accounting, 'needs_reconciliation');
    assert.equal(balance().balance, 100_000);
    reconcile(admin.id, data.generationId, '0.5', 'Verified provider charge');
    assert.equal(balance().balance, 95_000);
    assert.throws(() => reconcile(admin.id, data.generationId, '0.5', 'duplicate'), /not awaiting/);
});

test('a storage failure after provider usage still charges and releases capacity', async () => {
    const alice = await user('alice');
    funds();
    fs.writeFileSync(path.join(directory, 'images', alice.id), 'block directory creation');
    const response = await generate(request('/api/images', alice.token, form()));
    assert.equal(response.status, 500);
    assert.equal(balance().balance, 100_000 - 111);
    assert.equal(
        (database().prepare('SELECT active FROM generations WHERE user_id=?').get(alice.id) as { active: number })
            .active,
        0
    );
});

test('zero balance blocks calls; concurrent admitted calls finish below zero', async () => {
    const alice = await user('alice'),
        bob = await user('bob');
    const initial = provider.calls();
    assert.equal((await generate(request('/api/images', alice.token, form()))).status, 402);
    assert.equal(provider.calls(), initial);
    funds('0.0001');
    const first = generate(request('/api/images', alice.token, form('mock-delay')));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const blocked = await generate(request('/api/images', alice.token, form()));
    assert.equal(blocked.status, 429);
    const second = generate(request('/api/images', bob.token, form('mock-delay')));
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    assert.equal(balance().balance, 1 - 222);
    assert.equal((await generate(request('/api/images', bob.token, form()))).status, 402);
});

test('request guards reject missing identity, mismatched sessions, origin forgery and non-admin operations', async () => {
    const alice = await user('alice');
    funds();
    assert.equal((await generate(request('/api/images', undefined, form()))).status, 401);
    const mismatch = request('/api/images', alice.token, form());
    mismatch.headers.set('x-playground-session', hash(admin.token));
    assert.equal((await generate(mismatch)).status, 401);
    const foreign = request('/api/images', alice.token, form());
    foreign.headers.set('origin', 'https://foreign.example');
    assert.equal((await generate(foreign)).status, 403);
    const denial = await handleAccountRequest(request('/api/multi-user/admin/overview', alice.token));
    assert.equal(denial.status, 403);
    const logout = await handleAccountRequest(request('/api/multi-user/auth/logout', alice.token, {}));
    assert.equal(logout.status, 200);
    assert.equal(session(alice.token), undefined);
});

test('startup recovers interrupted requests without repeating or erasing accounting', () => {
    funds();
    const context = generationAccess(request('/api/images', admin.token, form()))!;
    context.start({ model: 'gpt-image-2.6-flare', mode: 'generate', prompt: 'interrupted' });
    recoverInterruptedRequests();
    const row = database().prepare('SELECT active,state,accounting FROM generations').get() as Record<string, unknown>;
    assert.deepEqual(row, { active: 0, state: 'interrupted', accounting: 'needs_reconciliation' });
});

test('explicit single-user mode preserves password auth and IndexedDB responses', async () => {
    process.env.APP_MODE = 'single-user';
    process.env.NEXT_PUBLIC_IMAGE_STORAGE_MODE = 'indexeddb';
    process.env.APP_PASSWORD = 'legacy';
    try {
        assert.equal((await generate(request('/api/images', undefined, form()))).status, 401);
        const data = form();
        data.set('passwordHash', hash('legacy'));
        const response = await generate(request('/api/images', undefined, data));
        const result = await response.json();
        assert.equal(response.status, 200);
        assert.ok(result.images[0].b64_json);
        assert.equal(result.history, undefined);
        assert.equal(balance().balance, 0);
    } finally {
        delete process.env.NEXT_PUBLIC_IMAGE_STORAGE_MODE;
        delete process.env.APP_PASSWORD;
    }
});

test('filename deletion preserves the rest of a batch and is atomic for mixed ownership', async () => {
    const alice = await user('alice'),
        bob = await user('bob');
    funds();
    const data = await (await generate(request('/api/images', alice.token, form('batch', { n: '2' })))).json();
    const other = await (await generate(request('/api/images', bob.token, form('other')))).json();
    assert.throws(() => deleteImages(alice.id, [data.images[0].filename, other.images[0].filename]), /not found/);
    assert.equal(history(alice.id).items[0].images.length, 2);
    deleteImages(alice.id, [data.images[0].filename]);
    assert.equal(history(alice.id).items[0].images.length, 1);
    assert.equal(balance().balance, 100_000 - 222);
});

test('global concurrency limit releases capacity after completion', async () => {
    process.env.MAX_ACTIVE_GLOBAL = '1';
    const alice = await user('alice'),
        bob = await user('bob');
    funds();
    const first = generationAccess(request('/api/images', alice.token, form()))!;
    first.start({ model: 'gpt-image-2.6-flare' });
    const second = generationAccess(request('/api/images', bob.token, form()))!;
    assert.throws(() => second.start({ model: 'gpt-image-2.6-flare' }), /busy/);
    first.finish(false);
    second.start({ model: 'gpt-image-2.6-flare' });
    second.finish(false);
});

test('coordinated backup and restore preserve accounts, sessions, balance, and image bytes', async () => {
    funds();
    const data = await (await generate(request('/api/images', admin.token, form('backup')))).json();
    const original = readImage(admin.id, data.images[0].filename).buffer;
    const expected = balance();
    closeDatabases();
    const backup = path.join(directory, 'restore-copy');
    fs.mkdirSync(backup);
    for (const name of ['playground.sqlite', 'images'])
        fs.cpSync(path.join(directory, name), path.join(backup, name), { recursive: true });
    process.env.APP_DATA_DIR = backup;
    assert.deepEqual(balance(), expected);
    assert.equal(session(admin.token)!.id, admin.id);
    assert.deepEqual(readImage(admin.id, data.images[0].filename).buffer, original);
});

test('history pagination has stable identifiers and totals independent of the page', () => {
    funds();
    for (let i = 0; i < 52; i++) {
        const context = generationAccess(request('/api/images', admin.token, form()))!;
        context.start({ model: 'gpt-image-2.6-flare', prompt: `item-${i}`, output_format: 'png' });
        context.settle(usage);
        context.save('dGVzdA==', 'png');
        context.finish(true);
    }
    const first = history(admin.id);
    assert.equal(first.items.length, 50);
    assert.equal(first.summary.totalImages, 52);
    const second = history(admin.id, first.nextCursor);
    assert.equal(second.items.length, 2);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 52);
});

test('single-user filesystem generation, retrieval and deletion work in an isolated working directory', async () => {
    await promisify(execFile)(process.execPath, ['--import', 'tsx', path.resolve('tests/legacy-smoke.ts')], {
        cwd: directory,
        windowsHide: true,
        env: {
            ...process.env,
            APP_MODE: 'single-user',
            APP_PASSWORD: 'legacy',
            NEXT_PUBLIC_IMAGE_STORAGE_MODE: 'fs',
            TSX_TSCONFIG_PATH: path.resolve('tsconfig.json')
        }
    });
});

test('production cookies are Secure, HttpOnly, host-only and expire after 30 days', async () => {
    const provision = await createUser('secure-user');
    process.env.APP_ORIGIN = 'https://images.example.test';
    const response = await handleAccountRequest(
        new NextRequest('https://images.example.test/api/multi-user/auth/login', {
            method: 'POST',
            headers: { origin: 'https://images.example.test', 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'secure-user', code: code(provision.secret) })
        })
    );
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!;
    assert.match(cookie, /__Host-playground=/);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Max-Age=2592000/i);
    assert.doesNotMatch(cookie, /Domain=/i);
});

test('completed images and their charge survive a later streaming failure', async () => {
    funds();
    const response = await generate(
        request('/api/images', admin.token, form('mock-partial-failure', { stream: 'true' }))
    );
    const events = (await response.text())
        .split('\n\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line.slice(6)));
    assert.equal(events.at(-1).type, 'error');
    assert.equal(history(admin.id).items[0].state, 'partial');
    assert.equal(history(admin.id).items[0].images.length, 1);
    assert.equal(balance().balance, 100_000 - 111);
});

test('a disconnected request releases capacity and records unknown provider usage for review', async () => {
    funds();
    const controller = new AbortController();
    const pending = generate(
        new NextRequest(request('/api/images', admin.token, form('mock-delay')), { signal: controller.signal })
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await pending;
    const row = database().prepare('SELECT active,accounting FROM generations').get() as {
        active: number;
        accounting: string;
    };
    assert.equal(row.active, 0);
    assert.equal(row.accounting, 'needs_reconciliation');
    assert.equal(balance().balance, 100_000);
});

test('streaming admission follows upstream single-image and output-format constraints', async () => {
    funds();
    const before = provider.calls();
    const cases: Array<Record<string, string>> = [{ n: '2' }, { output_format: 'gif' }, { output_format: 'svg', svg_model: 'gpt-6.1-sol' }];
    for (const extra of cases) {
        const response = await generate(
            request('/api/images', admin.token, form('invalid stream', { ...extra, stream: 'true' }))
        );
        assert.equal(response.status, 400);
    }
    assert.equal(provider.calls(), before);
    assert.equal(balance().balance, 100_000);
});
