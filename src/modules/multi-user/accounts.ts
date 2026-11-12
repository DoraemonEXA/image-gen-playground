import { assert, config } from './config';
import { database } from './database';
import { decrypt, encrypt, hash, randomToken } from './secrets';
import { randomUUID } from 'node:crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';
import QRCode from 'qrcode';

export type User = { id: string; username: string; role: 'admin' | 'user'; enabled: number };
type Account = User & { secret: string; last_step: number };
type Setup = { hash: string; expires: number; username: string | null; secret: string | null };
export const sessionDuration = 30 * 24 * 60 * 60 * 1000;

export function username(value: unknown) {
    assert(
        typeof value === 'string' && /^[a-zA-Z0-9_.-]{3,40}$/.test(value),
        400,
        'Username must contain 3–40 letters, numbers, dots, underscores, or hyphens.'
    );
    return value.toLowerCase();
}

export function setupClosed() {
    return !!(database().prepare('SELECT setup_closed FROM settings WHERE id=1').get() as { setup_closed: number })
        .setup_closed;
}

export function issueSetupToken(now = Date.now()) {
    const token = randomToken();
    database()
        .transaction(() => {
            assert(!setupClosed(), 409, 'Initial setup is permanently closed. Use the operator recovery command.');
            database()
                .prepare('INSERT OR REPLACE INTO setup(id,hash,expires) VALUES(1,?,?)')
                .run(hash(token), now + 30 * 60_000);
        })
        .immediate();
    return `${config().origin}/setup#token=${token}`;
}

function getSetup(token: unknown, now: number) {
    assert(typeof token === 'string' && token.length <= 100 && !setupClosed(), 401, 'Invalid or expired setup link.');
    const row = database().prepare('SELECT * FROM setup WHERE id=1 AND hash=? AND expires>?').get(hash(token), now) as
        Setup | undefined;
    assert(row, 401, 'Invalid or expired setup link.');
    return row;
}

async function provisioning(name: string, secret: string) {
    const uri = generateURI({ issuer: 'Image Playground', label: name, secret });
    return { username: name, qr: await QRCode.toDataURL(uri, { width: 280 }), secret };
}

export async function prepareSetup(token: unknown, name: unknown, now = Date.now()) {
    const normalized = username(name);
    const secret = database()
        .transaction(() => {
            const row = getSetup(token, now);
            assert(
                !row.username || row.username === normalized,
                409,
                'This link already has a pending username. Issue a new link to restart.'
            );
            const value = row.secret ? decrypt(row.secret) : generateSecret();
            database().prepare('UPDATE setup SET username=?,secret=? WHERE id=1').run(normalized, encrypt(value));
            return value;
        })
        .immediate();
    return provisioning(normalized, secret);
}

/** Reserve attempts before verification so failures survive transaction rollback. */
export function throttle(buckets: Array<[string, number]>, now = Date.now()) {
    return database()
        .transaction(() => {
            const db = database();
            db.prepare('DELETE FROM attempts WHERE time<?').run(now - 15 * 60_000);
            for (const [bucket, limit] of buckets) {
                const count = (
                    db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE bucket=?').get(bucket) as { n: number }
                ).n;
                assert(count < limit, 429, 'Too many attempts. Try again in 15 minutes.');
            }
            return buckets.map(
                ([bucket]) => db.prepare('INSERT INTO attempts VALUES(?,?)').run(bucket, now).lastInsertRowid
            );
        })
        .immediate();
}

function step(secret: string, code: unknown, last: number, now: number) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
    const result = verifySync({
        secret,
        token: code,
        epoch: Math.floor(now / 1000),
        epochTolerance: 30,
        ...(last >= 0 ? { afterTimeStep: last } : {})
    });
    return result.valid && 'epoch' in result ? Math.floor(result.epoch / 30) : null;
}

function newSession(id: string, now: number) {
    const token = randomToken();
    database().prepare('DELETE FROM sessions WHERE expires<=?').run(now);
    database()
        .prepare('INSERT INTO sessions VALUES(?,?,?)')
        .run(hash(token), id, now + sessionDuration);
    return token;
}

export function confirmSetup(token: unknown, code: unknown, ip: string, now = Date.now()) {
    const attempts = throttle(
        [
            [`setup:${hash(String(token))}`, 5],
            [`ip:${ip}`, 30]
        ],
        now
    );
    return database()
        .transaction(() => {
            const row = getSetup(token, now);
            const accepted = row.secret ? step(decrypt(row.secret), code, -1, now) : null;
            assert(row.username && accepted !== null, 401, 'Invalid code or setup link.');
            const id = randomUUID();
            database()
                .prepare('INSERT INTO users(id,username,role,secret,last_step,created) VALUES(?,?,?,?,?,?)')
                .run(id, row.username, 'admin', row.secret, accepted, now);
            database().prepare('UPDATE settings SET setup_closed=1 WHERE id=1').run();
            database().prepare('DELETE FROM setup').run();
            for (const row of attempts) database().prepare('DELETE FROM attempts WHERE rowid=?').run(row);
            return newSession(id, now);
        })
        .immediate();
}

export function login(name: unknown, code: unknown, ip: string, now = Date.now()) {
    const normalized = typeof name === 'string' ? name.toLowerCase().slice(0, 100) : '';
    const attempts = throttle(
        [
            [`login:${normalized}`, 5],
            [`ip:${ip}`, 30]
        ],
        now
    );
    return database()
        .transaction(() => {
            const user = database().prepare('SELECT * FROM users WHERE username=?').get(normalized) as
                Account | undefined;
            // Perform verification for unknown names too; never expose whether an account exists.
            const accepted = step(
                user ? decrypt(user.secret) : 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
                code,
                user?.last_step ?? -1,
                now
            );
            assert(user?.enabled && accepted !== null && accepted > user.last_step, 401, 'Invalid username or code.');
            database().prepare('UPDATE users SET last_step=? WHERE id=?').run(accepted, user.id);
            database().prepare('DELETE FROM attempts WHERE bucket=?').run(`login:${normalized}`);
            for (const row of attempts) database().prepare('DELETE FROM attempts WHERE rowid=?').run(row);
            return newSession(user.id, now);
        })
        .immediate();
}

export function session(token: string, now = Date.now()) {
    return database()
        .prepare(
            `SELECT u.id,u.username,u.role,u.enabled,s.hash AS sessionId FROM sessions s
        JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>? AND u.enabled=1`
        )
        .get(hash(token), now) as (User & { sessionId: string }) | undefined;
}

export function revoke(token: string) {
    database().prepare('DELETE FROM sessions WHERE hash=?').run(hash(token));
}

export async function createUser(name: unknown) {
    const normalized = username(name);
    const secret = generateSecret();
    database()
        .transaction(() => {
            assert(
                !database().prepare('SELECT id FROM users WHERE username=?').get(normalized),
                409,
                'Username is already in use.'
            );
            database()
                .prepare('INSERT INTO users(id,username,role,secret,created) VALUES(?,?,?,?,?)')
                .run(randomUUID(), normalized, 'user', encrypt(secret), Date.now());
        })
        .immediate();
    return provisioning(normalized, secret);
}

export function setEnabled(id: string, enabled: boolean) {
    database()
        .transaction(() => {
            const user = database().prepare('SELECT role FROM users WHERE id=?').get(id) as User | undefined;
            assert(user?.role === 'user', 404, 'Regular user not found.');
            database().prepare('UPDATE users SET enabled=? WHERE id=?').run(Number(enabled), id);
            database().prepare('DELETE FROM sessions WHERE user_id=?').run(id);
        })
        .immediate();
}

export async function resetAuthenticator(id: string, operator = false) {
    const secret = generateSecret();
    const user = database()
        .transaction(() => {
            const account = database().prepare('SELECT * FROM users WHERE id=?').get(id) as Account | undefined;
            assert(account && (operator || account.role === 'user'), 404, 'Account not found.');
            database().prepare('UPDATE users SET secret=?,last_step=-1 WHERE id=?').run(encrypt(secret), id);
            database().prepare('DELETE FROM sessions WHERE user_id=?').run(id);
            database().prepare('DELETE FROM attempts WHERE bucket=?').run(`login:${account.username}`);
            return account;
        })
        .immediate();
    return provisioning(user.username, secret);
}
