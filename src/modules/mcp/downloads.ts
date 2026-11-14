import { getMimeType, type ImageOutputFormat } from '../../lib/models';
import { AppError, assert, config } from '../multi-user/config';
import { database } from '../multi-user/database';
import { readImage } from '../multi-user/history';
import { requireMcp, resourceUrl } from '../oauth/config';
import { authenticateHash, type Principal, requireScope } from '../oauth/store';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import * as z from 'zod/v4';

export const IMAGE_DOWNLOAD_MS = 60 * 60_000;
const MAX_TOKEN_LENGTH = 1024;
const tokenSchema = z
    .object({
        v: z.literal(1),
        image_id: z.string().min(1).max(100),
        grant_id: z.string().min(1).max(100),
        expires: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    })
    .strict();

const downloadHeaders = {
    'Cache-Control': 'private, no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
};

function signature(payload: string) {
    const { key, origin } = config();
    // Separate this capability from TOTP encryption and bind it to this deployment's origin.
    const signingKey = Buffer.from(hkdfSync('sha256', key, origin, 'image-playground/mcp-image-download/v1', 32));
    return createHmac('sha256', signingKey).update(payload).digest();
}

function downloadAccess(grantId: string, imageId: string, now: number) {
    const row = database()
        .prepare(
            `SELECT g.user_id,g.expires,g.scope FROM oauth_grants g
        JOIN users u ON u.id=g.user_id
        JOIN images i ON i.user_id=g.user_id
        JOIN generations gen ON gen.id=i.generation_id AND gen.user_id=g.user_id
        WHERE g.id=? AND g.revoked=0 AND g.expires>? AND g.resource=? AND u.enabled=1
        AND i.filename=? AND gen.deleted=0`
        )
        .get(grantId, now, resourceUrl(), imageId) as { user_id: string; expires: number; scope: string } | undefined;
    assert(row && row.scope.split(' ').includes('images:read'), 404, 'Image not found.');
    return row;
}

export function imageDownload(principal: Principal, imageId: string, now = Date.now()) {
    requireMcp();
    const current = authenticateHash(principal.tokenHash, now);
    requireScope(current, 'images:read');
    const grant = downloadAccess(current.grantId, imageId, now);
    const expires = Math.min(now + IMAGE_DOWNLOAD_MS, grant.expires);
    const payload = Buffer.from(
        JSON.stringify({ v: 1, image_id: imageId, grant_id: current.grantId, expires })
    ).toString('base64url');
    const token = `${payload}.${signature(payload).toString('base64url')}`;
    const url = new URL(`/api/mcp/images/${encodeURIComponent(imageId)}`, config().origin);
    url.searchParams.set('token', token);
    return { download_url: url.href, download_url_expires_at: new Date(expires).toISOString() };
}

export function handleImageDownload(request: Request, imageId: string, now = Date.now()) {
    const failure = (status: number) =>
        new Response(
            request.method === 'HEAD'
                ? null
                : JSON.stringify({
                      error: status === 404 ? 'Image not found.' : 'The server could not complete this operation.'
                  }),
            { status, headers: { ...downloadHeaders, 'Content-Type': 'application/json' } }
        );
    try {
        requireMcp();
        if (!['GET', 'HEAD'].includes(request.method))
            return new Response(null, { status: 405, headers: { ...downloadHeaders, Allow: 'GET, HEAD' } });
        const tokens = new URL(request.url).searchParams.getAll('token');
        const token = tokens[0] ?? '';
        assert(
            tokens.length === 1 &&
                token.length <= MAX_TOKEN_LENGTH &&
                /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token),
            404,
            'Image not found.'
        );
        const [payload, encodedSignature] = token.split('.');
        const supplied = Buffer.from(encodedSignature, 'base64url');
        assert(
            supplied.length === 32 &&
                supplied.toString('base64url') === encodedSignature &&
                timingSafeEqual(signature(payload), supplied),
            404,
            'Image not found.'
        );
        let decoded: unknown;
        try {
            decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        } catch {
            throw new AppError(404, 'Image not found.');
        }
        const parsed = tokenSchema.safeParse(decoded);
        assert(
            parsed.success && parsed.data.image_id === imageId && parsed.data.expires > now,
            404,
            'Image not found.'
        );
        const access = downloadAccess(parsed.data.grant_id, imageId, now);
        const { buffer, format } = readImage(access.user_id, imageId);
        return new Response(request.method === 'HEAD' ? null : new Uint8Array(buffer), {
            headers: {
                ...downloadHeaders,
                'Content-Type': getMimeType(format as ImageOutputFormat),
                'Content-Length': String(buffer.length)
            }
        });
    } catch (error) {
        if (error instanceof AppError && error.status === 404) return failure(404);
        // Never log the request URL, token, or decoded capability.
        console.error('Image download failed:', error instanceof Error ? error.name : 'Unknown error');
        return failure(500);
    }
}
