import { assert, config, isMultiUser } from '../multi-user/config';

export const SCOPES = ['images:generate', 'images:edit', 'images:read'] as const;
export type Scope = (typeof SCOPES)[number];
export const CODE_MS = 5 * 60_000;
export const ACCESS_MS = 15 * 60_000;
export const GRANT_MS = 30 * 24 * 60 * 60_000;
export const AUTH_REQUEST_MS = 15 * 60_000;
export const MCP_MAX_BYTES = 100_000_000;

export function mcpEnabled() {
    return isMultiUser() && process.env.MCP_ENABLED === 'true';
}
export function requireMcp() {
    assert(mcpEnabled(), 404, 'Not found.');
}
export const resourceUrl = () => `${config().origin}/mcp`;
export const resourceMetadataUrl = () => `${config().origin}/.well-known/oauth-protected-resource/mcp`;

export class OAuthError extends Error {
    constructor(
        public code: string,
        message: string,
        public status = 400
    ) {
        super(message);
    }
}
export function oauthAssert(condition: unknown, code: string, message: string): asserts condition {
    if (!condition) throw new OAuthError(code, message);
}

/** Bound reads before decoding JSON/form bodies, including chunked requests. */
export async function readLimited(request: Request, limit: number) {
    if (Number(request.headers.get('content-length')) > limit)
        throw new OAuthError('invalid_request', 'Request is too large.', 413);
    const reader = request.body?.getReader();
    if (!reader) return '';
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) {
                await reader.cancel();
                throw new OAuthError('invalid_request', 'Request is too large.', 413);
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks).toString('utf8');
}
