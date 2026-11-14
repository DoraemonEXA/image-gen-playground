import { database } from '../multi-user/database';
import { randomToken } from '../multi-user/secrets';
import { OAuthError, oauthAssert, SCOPES } from './config';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

export type OAuthClient = { client_id: string; client_name: string; redirect_uris: string[] };

export function validRedirect(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2048) return false;
    try {
        const url = new URL(value);
        return (
            !url.username &&
            !url.password &&
            !url.hash &&
            (url.protocol === 'https:' ||
                (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
        );
    } catch {
        return false;
    }
}

/** Native loopback callbacks may choose an ephemeral port (RFC 8252 section 7.3). */
export function matchesRedirect(registered: string, requested: string) {
    if (!validRedirect(requested)) return false;
    if (registered === requested) return true;
    const expected = new URL(registered),
        actual = new URL(requested);
    if (expected.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)) return false;
    expected.port = '';
    actual.port = '';
    return expected.href === actual.href;
}

export function validateClient(value: unknown, id: string): OAuthClient {
    oauthAssert(
        value && typeof value === 'object' && !Array.isArray(value),
        'invalid_client_metadata',
        'Invalid client metadata.'
    );
    const data = value as Record<string, unknown>;
    oauthAssert(
        typeof data.client_name === 'string' && data.client_name.trim().length > 0 && data.client_name.length <= 120,
        'invalid_client_metadata',
        'A client name is required (up to 120 characters).'
    );
    oauthAssert(
        Array.isArray(data.redirect_uris) &&
            data.redirect_uris.length > 0 &&
            data.redirect_uris.length <= 10 &&
            data.redirect_uris.every(validRedirect),
        'invalid_redirect_uri',
        'Use HTTPS or a localhost HTTP callback.'
    );
    oauthAssert(
        data.token_endpoint_auth_method === undefined || data.token_endpoint_auth_method === 'none',
        'invalid_client_metadata',
        'Only public clients with PKCE are supported.'
    );
    for (const [field, allowed] of [
        ['grant_types', ['authorization_code', 'refresh_token']],
        ['response_types', ['code']]
    ] as const) {
        if (data[field] !== undefined)
            oauthAssert(
                Array.isArray(data[field]) &&
                    (data[field] as unknown[]).length > 0 &&
                    (data[field] as unknown[]).every((item) => (allowed as readonly unknown[]).includes(item)),
                'invalid_client_metadata',
                `Unsupported ${field}.`
            );
    }
    if (data.scope !== undefined)
        oauthAssert(
            typeof data.scope === 'string' &&
                data.scope.split(' ').every((s) => (SCOPES as readonly string[]).includes(s)),
            'invalid_client_metadata',
            'Unsupported scope.'
        );
    return { client_id: id, client_name: data.client_name.trim(), redirect_uris: data.redirect_uris as string[] };
}

export function registerClient(value: unknown, now = Date.now()) {
    const client = validateClient(value, randomToken());
    database()
        .prepare('INSERT INTO oauth_clients VALUES(?,?,?,NULL)')
        .run(client.client_id, JSON.stringify(client), now);
    return {
        ...client,
        client_id_issued_at: Math.floor(now / 1000),
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: SCOPES.join(' ')
    };
}

const privateV4 = new BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
] as const)
    privateV4.addSubnet(address, prefix, 'ipv4');
const publicV6 = new BlockList();
publicV6.addSubnet('2000::', 3, 'ipv6');
const reservedV6 = new BlockList();
reservedV6.addSubnet('2001::', 23, 'ipv6');
reservedV6.addSubnet('2001:db8::', 32, 'ipv6');
reservedV6.addSubnet('2002::', 16, 'ipv6');
reservedV6.addSubnet('3fff::', 20, 'ipv6');

export function publicAddress(address: string) {
    const family = isIP(address);
    return family === 4
        ? !privateV4.check(address, 'ipv4')
        : family === 6 && publicV6.check(address, 'ipv6') && !reservedV6.check(address, 'ipv6');
}

/** Resolve once, validate every answer, then pin the HTTPS connection to that address. */
async function fetchMetadata(url: URL): Promise<{ value: unknown; maxAge: number }> {
    const signal = AbortSignal.timeout(5000);
    const addresses = await Promise.race([
        lookup(url.hostname, { all: true }),
        new Promise<never>((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('DNS timeout')), { once: true })
        )
    ]);
    oauthAssert(
        addresses.length > 0 && addresses.every(({ address }) => publicAddress(address)),
        'invalid_client',
        'Client metadata must use a public HTTPS address.'
    );
    const selected = addresses[0];
    return new Promise((resolve, reject) => {
        const request = https.get(
            url,
            {
                signal,
                agent: false,
                family: selected.family,
                lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
                headers: { Accept: 'application/json' }
            },
            (response) => {
                if (
                    response.statusCode !== 200 ||
                    !response.headers['content-type']
                        ?.split(';')[0]
                        .trim()
                        .match(/^application\/(json|[a-z0-9.+-]+\+json)$/i)
                ) {
                    response.destroy();
                    reject(new Error('Invalid metadata response'));
                    return;
                }
                const parts: Buffer[] = [];
                let size = 0;
                response.on('data', (part: Buffer) => {
                    size += part.length;
                    if (size > 65_536) response.destroy(new Error('Metadata is too large'));
                    else parts.push(part);
                });
                response.on('error', reject);
                response.on('end', () => {
                    try {
                        const cache = response.headers['cache-control'] || '';
                        const seconds = Number(/(?:^|,)\s*max-age=(\d+)/i.exec(cache)?.[1] ?? 60);
                        resolve({
                            value: JSON.parse(Buffer.concat(parts).toString('utf8')),
                            maxAge: /no-store|no-cache/i.test(cache) ? 0 : Math.min(seconds * 1000, 300_000)
                        });
                    } catch (error) {
                        reject(error);
                    }
                });
            }
        );
        request.on('error', reject);
    });
}

export async function resolveClient(id: string, now = Date.now()): Promise<OAuthClient> {
    oauthAssert(id.length > 0 && id.length <= 2048, 'invalid_client', 'Invalid client ID.');
    const stored = database().prepare('SELECT metadata,expires FROM oauth_clients WHERE id=?').get(id) as
        { metadata: string; expires: number | null } | undefined;
    if (stored && (stored.expires === null || stored.expires > now)) return JSON.parse(stored.metadata);
    let url: URL;
    try {
        url = new URL(id);
    } catch {
        throw new OAuthError('invalid_client', 'Unknown client.');
    }
    oauthAssert(
        url.protocol === 'https:' &&
            url.pathname !== '/' &&
            !url.username &&
            !url.password &&
            !url.hash &&
            !url.search &&
            (!url.port || url.port === '443') &&
            !isIP(url.hostname.replace(/^\[|\]$/g, '')),
        'invalid_client',
        'Invalid client metadata URL.'
    );
    try {
        const { value, maxAge } = await fetchMetadata(url);
        oauthAssert(
            (value as Record<string, unknown>)?.client_id === id,
            'invalid_client',
            'Client metadata ID does not match.'
        );
        const client = validateClient(value, id);
        database()
            .prepare('INSERT OR REPLACE INTO oauth_clients VALUES(?,?,?,?)')
            .run(id, JSON.stringify(client), now, now + maxAge);
        return client;
    } catch (error) {
        if (error instanceof OAuthError) throw error;
        throw new OAuthError('invalid_client', 'Could not load client metadata.');
    }
}
