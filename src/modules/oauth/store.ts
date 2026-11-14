import type { User } from '../multi-user/accounts';
import { config } from '../multi-user/config';
import { database } from '../multi-user/database';
import { hash, randomToken } from '../multi-user/secrets';
import { matchesRedirect, resolveClient } from './clients';
import {
    ACCESS_MS,
    AUTH_REQUEST_MS,
    CODE_MS,
    GRANT_MS,
    oauthAssert,
    OAuthError,
    resourceUrl,
    type Scope,
    SCOPES
} from './config';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

type Authorization = {
    client_id: string;
    redirect_uri: string;
    scope: string;
    resource: string;
    code_challenge: string;
    state?: string;
};
type Pending = {
    id: string;
    parameters: string;
    client_name: string;
    expires: number;
    session_hash: string | null;
    csrf_hash: string | null;
};
type Grant = {
    id: string;
    user_id: string;
    client_id: string;
    client_name: string;
    scope: string;
    resource: string;
    created: number;
    expires: number;
    revoked: number;
};
export type Principal = { user: User; clientId: string; grantId: string; scopes: Scope[]; tokenHash: string };

export function uniqueParameters(params: URLSearchParams) {
    for (const name of params.keys())
        oauthAssert(params.getAll(name).length === 1, 'invalid_request', 'Duplicate request parameters.');
    return Object.fromEntries(params);
}

export function cleanupOAuth(now = Date.now()) {
    const db = database();
    db.transaction(() => {
        db.prepare('DELETE FROM oauth_requests WHERE expires<=?').run(now);
        // Keep spent refresh tokens until the grant expires, so replay revokes the family.
        db.prepare(
            'DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE expires<=? OR revoked=1)'
        ).run(now);
        db.prepare("DELETE FROM oauth_tokens WHERE kind='access' AND expires<=?").run(now);
        db.prepare('DELETE FROM oauth_codes WHERE expires<=?').run(now);
        db.prepare(
            'DELETE FROM oauth_grants WHERE (expires<=? OR revoked=1) AND NOT EXISTS (SELECT 1 FROM oauth_codes WHERE grant_id=oauth_grants.id)'
        ).run(now);
        db.prepare(
            `DELETE FROM oauth_clients WHERE created<? AND NOT EXISTS
            (SELECT 1 FROM oauth_grants WHERE client_id=oauth_clients.id)`
        ).run(now - GRANT_MS);
    })();
}

export async function beginAuthorization(params: URLSearchParams, now = Date.now()) {
    cleanupOAuth(now);
    const data = uniqueParameters(params);
    oauthAssert(data.response_type === 'code', 'unsupported_response_type', 'Authorization code flow is required.');
    const client = await resolveClient(data.client_id || '', now);
    oauthAssert(
        client.redirect_uris.some((uri) => matchesRedirect(uri, data.redirect_uri)),
        'invalid_request',
        'Redirect URI does not match the client registration.'
    );
    oauthAssert(
        data.code_challenge_method === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(data.code_challenge || ''),
        'invalid_request',
        'PKCE S256 is required.'
    );
    oauthAssert(data.resource === resourceUrl(), 'invalid_target', 'Invalid MCP resource.');
    const scopes = (data.scope ?? SCOPES.join(' ')).split(' ');
    oauthAssert(
        scopes.length > 0 && scopes.every((scope) => (SCOPES as readonly string[]).includes(scope)),
        'invalid_scope',
        'Unsupported scope.'
    );
    oauthAssert(!data.state || data.state.length <= 2048, 'invalid_request', 'State is too long.');
    const parameters: Authorization = {
        client_id: client.client_id,
        redirect_uri: data.redirect_uri,
        scope: [...new Set(scopes)].sort().join(' '),
        resource: data.resource,
        code_challenge: data.code_challenge,
        ...(data.state !== undefined ? { state: data.state } : {})
    };
    const id = randomToken();
    database()
        .prepare('INSERT INTO oauth_requests(id,parameters,client_name,expires) VALUES(?,?,?,?)')
        .run(id, JSON.stringify(parameters), client.client_name, now + AUTH_REQUEST_MS);
    return id;
}

function pending(id: unknown, now: number) {
    oauthAssert(
        typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(id),
        'invalid_request',
        'Invalid authorization request.'
    );
    const row = database().prepare('SELECT * FROM oauth_requests WHERE id=? AND expires>?').get(id, now) as
        Pending | undefined;
    oauthAssert(row, 'invalid_request', 'Authorization request expired. Connect the agent again.');
    return row;
}

export function consentDetails(id: string, user: User & { sessionId: string }, now = Date.now()) {
    const row = pending(id, now);
    oauthAssert(
        !row.session_hash || row.session_hash === user.sessionId,
        'invalid_request',
        'Authorization session changed. Connect the agent again.'
    );
    const csrf = randomToken();
    database()
        .prepare('UPDATE oauth_requests SET session_hash=?,csrf_hash=? WHERE id=?')
        .run(user.sessionId, hash(csrf), id);
    const parameters = JSON.parse(row.parameters) as Authorization;
    return {
        request_id: id,
        client_name: row.client_name,
        client_id: parameters.client_id,
        redirect_uri: parameters.redirect_uri,
        scopes: parameters.scope.split(' '),
        username: user.username,
        csrf,
        sessionId: user.sessionId
    };
}

export function completeAuthorization(
    id: unknown,
    csrf: unknown,
    approve: boolean,
    user: User & { sessionId: string },
    now = Date.now()
) {
    return database()
        .transaction(() => {
            const row = pending(id, now);
            // The browser may have been revoked while its confirmation body was being read.
            oauthAssert(
                database()
                    .prepare(
                        `SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
                WHERE s.hash=? AND s.user_id=? AND s.expires>? AND u.enabled=1`
                    )
                    .get(user.sessionId, user.id, now),
                'invalid_request',
                'Authorization session changed. Connect the agent again.'
            );
            oauthAssert(
                row.session_hash === user.sessionId &&
                    typeof csrf === 'string' &&
                    csrf.length <= 100 &&
                    row.csrf_hash === hash(csrf),
                'invalid_request',
                'Invalid authorization confirmation.'
            );
            const params = JSON.parse(row.parameters) as Authorization;
            const target = new URL(params.redirect_uri);
            if (params.state !== undefined) target.searchParams.set('state', params.state);
            target.searchParams.set('iss', config().origin);
            database().prepare('DELETE FROM oauth_requests WHERE id=?').run(row.id);
            if (!approve) {
                target.searchParams.set('error', 'access_denied');
                return target.href;
            }
            const grantId = randomUUID();
            database()
                .prepare(
                    'INSERT INTO oauth_grants(id,user_id,client_id,client_name,scope,resource,created,expires) VALUES(?,?,?,?,?,?,?,?)'
                )
                .run(
                    grantId,
                    user.id,
                    params.client_id,
                    row.client_name,
                    params.scope,
                    params.resource,
                    now,
                    now + GRANT_MS
                );
            const code = randomToken();
            database()
                .prepare('INSERT INTO oauth_codes(hash,grant_id,redirect_uri,challenge,expires) VALUES(?,?,?,?,?)')
                .run(hash(code), grantId, params.redirect_uri, params.code_challenge, now + CODE_MS);
            target.searchParams.set('code', code);
            return target.href;
        })
        .immediate();
}

function activeGrant(id: string, now: number): Grant | undefined {
    return database()
        .prepare(
            `SELECT g.* FROM oauth_grants g JOIN users u ON u.id=g.user_id
        WHERE g.id=? AND g.revoked=0 AND g.expires>? AND u.enabled=1`
        )
        .get(id, now) as Grant | undefined;
}

function issueTokens(grant: Grant, now: number) {
    const access = randomToken(),
        refresh = randomToken();
    const expires = Math.min(now + ACCESS_MS, grant.expires);
    const insert = database().prepare('INSERT INTO oauth_tokens(hash,grant_id,kind,expires) VALUES(?,?,?,?)');
    insert.run(hash(access), grant.id, 'access', expires);
    insert.run(hash(refresh), grant.id, 'refresh', grant.expires);
    return {
        access_token: access,
        token_type: 'Bearer',
        expires_in: Math.floor((expires - now) / 1000),
        refresh_token: refresh,
        scope: grant.scope
    };
}

export function exchangeToken(params: URLSearchParams, now = Date.now()) {
    const data = uniqueParameters(params);
    oauthAssert(
        data.client_id && data.client_id.length <= 2048 && data.resource === resourceUrl(),
        'invalid_request',
        'Client ID and MCP resource are required.'
    );
    oauthAssert(!data.client_secret, 'invalid_client', 'Only public clients with PKCE are supported.');
    const result = database()
        .transaction(() => {
            if (data.grant_type === 'authorization_code') {
                oauthAssert(
                    typeof data.code === 'string' && data.code.length <= 100,
                    'invalid_grant',
                    'Invalid authorization code.'
                );
                const code = database().prepare('SELECT * FROM oauth_codes WHERE hash=?').get(hash(data.code)) as
                    | { grant_id: string; redirect_uri: string; challenge: string; expires: number; used: number }
                    | undefined;
                const grant = code && activeGrant(code.grant_id, now);
                oauthAssert(
                    code &&
                        grant &&
                        grant.client_id === data.client_id &&
                        grant.resource === data.resource &&
                        code.expires > now &&
                        code.redirect_uri === data.redirect_uri,
                    'invalid_grant',
                    'Invalid authorization code.'
                );
                oauthAssert(
                    /^[A-Za-z0-9._~-]{43,128}$/.test(data.code_verifier || ''),
                    'invalid_grant',
                    'Invalid PKCE verifier.'
                );
                const challenge = createHash('sha256').update(data.code_verifier).digest('base64url');
                oauthAssert(
                    timingSafeEqual(Buffer.from(challenge), Buffer.from(code.challenge)),
                    'invalid_grant',
                    'Invalid PKCE verifier.'
                );
                if (code.used) {
                    database().prepare('UPDATE oauth_grants SET revoked=1 WHERE id=?').run(grant.id);
                    return null;
                }
                database().prepare('UPDATE oauth_codes SET used=1 WHERE hash=?').run(hash(data.code));
                return issueTokens(grant, now);
            }
            oauthAssert(data.grant_type === 'refresh_token', 'unsupported_grant_type', 'Unsupported grant type.');
            oauthAssert(
                typeof data.refresh_token === 'string' && data.refresh_token.length <= 100,
                'invalid_grant',
                'Invalid refresh token.'
            );
            const token = database()
                .prepare("SELECT * FROM oauth_tokens WHERE hash=? AND kind='refresh'")
                .get(hash(data.refresh_token)) as { grant_id: string; expires: number; used: number } | undefined;
            const grant = token && activeGrant(token.grant_id, now);
            oauthAssert(
                token &&
                    grant &&
                    token.expires > now &&
                    grant.client_id === data.client_id &&
                    grant.resource === data.resource,
                'invalid_grant',
                'Invalid refresh token.'
            );
            oauthAssert(
                data.scope === undefined || [...new Set(data.scope.split(' '))].sort().join(' ') === grant.scope,
                'invalid_scope',
                'Refresh cannot change granted scopes.'
            );
            if (token.used) {
                database().prepare('UPDATE oauth_grants SET revoked=1 WHERE id=?').run(grant.id);
                return null;
            }
            database().prepare('UPDATE oauth_tokens SET used=1 WHERE hash=?').run(hash(data.refresh_token));
            return issueTokens(grant, now);
        })
        .immediate();
    // Throw outside the transaction so replay revocation cannot roll back.
    if (!result) throw new OAuthError('invalid_grant', 'Credential was already used. Connect the agent again.');
    return result;
}

export function authenticateHash(tokenHash: string, now = Date.now()): Principal {
    const row = database()
        .prepare(
            `SELECT u.id,u.username,u.role,u.enabled,g.id AS grantId,g.client_id,g.scope
        FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id JOIN users u ON u.id=g.user_id
        WHERE t.hash=? AND t.kind='access' AND t.expires>? AND g.expires>? AND g.revoked=0 AND u.enabled=1 AND g.resource=?`
        )
        .get(tokenHash, now, now, resourceUrl()) as
        (User & { grantId: string; client_id: string; scope: string }) | undefined;
    if (!row) throw new OAuthError('invalid_token', 'Access token is invalid or expired.', 401);
    return {
        user: { id: row.id, username: row.username, role: row.role, enabled: row.enabled },
        clientId: row.client_id,
        grantId: row.grantId,
        scopes: row.scope.split(' ') as Scope[],
        tokenHash
    };
}

export function authenticate(request: Request, now = Date.now()) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.get('authorization') || '');
    if (!match) throw new OAuthError('invalid_token', 'An access token is required.', 401);
    return authenticateHash(hash(match[1]), now);
}

export function requireScope(principal: Principal, scope: Scope) {
    if (!principal.scopes.includes(scope)) throw new OAuthError('insufficient_scope', `Required scope: ${scope}`, 403);
}

export function revokeToken(token: string, clientId: string) {
    database()
        .prepare(
            `UPDATE oauth_grants SET revoked=1 WHERE client_id=? AND id IN
        (SELECT grant_id FROM oauth_tokens WHERE hash=?)`
        )
        .run(clientId, hash(token));
}
export function connectedAgents(userId: string, now = Date.now()) {
    return database()
        .prepare(
            `SELECT id,client_name,client_id,scope,created,expires FROM oauth_grants
        WHERE user_id=? AND revoked=0 AND expires>? ORDER BY created DESC`
        )
        .all(userId, now);
}
export function revokeAgent(userId: string, id: string) {
    database().prepare('UPDATE oauth_grants SET revoked=1 WHERE user_id=? AND id=?').run(userId, id);
}
