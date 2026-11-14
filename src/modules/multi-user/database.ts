import { config } from './config';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const databases = new Map<string, Database.Database>();

export function database() {
    const { dataDir } = config();
    const filename = path.join(dataDir, 'playground.sqlite');
    let db = databases.get(filename);
    if (db) return db;
    fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true, mode: 0o700 });
    db = new Database(filename);
    fs.chmodSync(filename, 0o600);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.transaction(() => {
        const version = db!.pragma('user_version', { simple: true }) as number;
        if (version > 2) throw new Error('Database is newer than this application');
        if (version === 0) {
            db!.exec(`
                CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), balance INTEGER NOT NULL DEFAULT 0,
                    version INTEGER NOT NULL DEFAULT 0, setup_closed INTEGER NOT NULL DEFAULT 0);
                INSERT INTO settings(id) VALUES(1);
                CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, role TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1, secret TEXT NOT NULL, last_step INTEGER NOT NULL DEFAULT -1,
                    created INTEGER NOT NULL);
                CREATE TABLE sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
                CREATE INDEX sessions_user ON sessions(user_id);
                CREATE TABLE setup (id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT NOT NULL, expires INTEGER NOT NULL,
                    username TEXT, secret TEXT);
                CREATE TABLE attempts (bucket TEXT NOT NULL, time INTEGER NOT NULL);
                CREATE INDEX attempts_bucket ON attempts(bucket,time);
                CREATE TABLE generations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created INTEGER NOT NULL,
                    model TEXT NOT NULL, metadata TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'running', active INTEGER NOT NULL DEFAULT 1,
                    accounting TEXT NOT NULL DEFAULT 'pending', cost_units INTEGER, cost_details TEXT, usage TEXT,
                    deleted INTEGER NOT NULL DEFAULT 0);
                CREATE INDEX history_owner ON generations(user_id,created DESC,id DESC);
                CREATE TABLE images (filename TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES generations(id),
                    user_id TEXT NOT NULL REFERENCES users(id), format TEXT NOT NULL);
                CREATE INDEX images_generation ON images(generation_id);
                CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, kind TEXT NOT NULL,
                    amount INTEGER NOT NULL, actor_id TEXT REFERENCES users(id), user_id TEXT REFERENCES users(id),
                    generation_id TEXT UNIQUE REFERENCES generations(id), reason TEXT NOT NULL, balance_after INTEGER NOT NULL);
                CREATE TABLE garbage (filepath TEXT PRIMARY KEY);
                PRAGMA user_version = 1;
            `);
        }
        if (version < 2) {
            db!.exec(`
                CREATE TABLE oauth_clients (
                    id TEXT PRIMARY KEY, metadata TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER
                );
                CREATE TABLE oauth_requests (
                    id TEXT PRIMARY KEY, parameters TEXT NOT NULL, client_name TEXT NOT NULL,
                    expires INTEGER NOT NULL, session_hash TEXT, csrf_hash TEXT
                );
                CREATE TABLE oauth_grants (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), client_id TEXT NOT NULL,
                    client_name TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL,
                    created INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX oauth_grants_user ON oauth_grants(user_id);
                CREATE TABLE oauth_codes (
                    hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
                    redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL,
                    used INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE oauth_tokens (
                    hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
                    kind TEXT NOT NULL CHECK(kind IN ('access','refresh')), expires INTEGER NOT NULL,
                    used INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
                CREATE TABLE mcp_requests (
                    user_id TEXT NOT NULL REFERENCES users(id), client_id TEXT NOT NULL,
                    request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
                    generation_id TEXT NOT NULL UNIQUE REFERENCES generations(id),
                    PRIMARY KEY(user_id,client_id,request_id)
                );
                PRAGMA user_version = 2;
            `);
        }
    }).immediate();
    databases.set(filename, db);
    return db;
}

export function closeDatabases() {
    for (const db of databases.values()) db.close();
    databases.clear();
}

/** Called by the server entrypoint, never by route imports or the operator CLI. */
export function recoverInterruptedRequests() {
    database()
        .prepare(
            `UPDATE generations SET active=0, state='interrupted',
        accounting=CASE WHEN accounting='pending' THEN 'needs_reconciliation' ELSE accounting END WHERE active=1`
        )
        .run();
}
