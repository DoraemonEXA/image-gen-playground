import { session, sessionDuration } from './accounts';
import { AppError, assert, config, isMultiUser, privateHeaders } from './config';
import { NextRequest, NextResponse } from 'next/server';

export const cookieName = () => (config().secure ? '__Host-playground' : 'playground-local');
export function cookieToken(request: NextRequest) {
    return request.cookies.get(cookieName())?.value || '';
}
export function sameOrigin(request: Request) {
    assert(request.headers.get('origin') === config().origin, 403, 'Request origin is not allowed.');
}
export function requireUser(request: NextRequest, admin = false) {
    assert(isMultiUser(), 404, 'Not found.');
    const user = session(cookieToken(request));
    assert(user, 401, 'Please sign in.');
    if (admin) assert(user.role === 'admin', 403, 'Administrator access required.');
    const expected = request.headers.get('x-playground-session');
    if (!['GET', 'HEAD'].includes(request.method)) {
        sameOrigin(request);
        assert(expected === user.sessionId, 401, 'Your session changed. Please reload.');
    } else if (expected) assert(expected === user.sessionId, 401, 'Your session changed. Please reload.');
    return user;
}

export function json(value: unknown, status = 200) {
    return NextResponse.json(value, { status, headers: privateHeaders });
}
export function errorResponse(error: unknown) {
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    console.error('Multi-user operation failed:', error instanceof Error ? error.name : 'Unknown error');
    return json({ error: 'The server could not complete this operation.' }, 500);
}
export function withSession(token: string) {
    const response = json({ ok: true });
    response.cookies.set(cookieName(), token, {
        httpOnly: true,
        secure: config().secure,
        sameSite: 'lax',
        path: '/',
        maxAge: token ? sessionDuration / 1000 : 0
    });
    return response;
}
export function clientIp(request: NextRequest) {
    // Only enable behind the supplied proxy, which overwrites this header. No public app port.
    return config().trustProxy ? (request.headers.get('x-real-ip') || 'unknown').slice(0, 100) : 'direct';
}

export async function body(request: Request): Promise<Record<string, unknown>> {
    const text = await request.text();
    assert(text.length <= 16_384, 413, 'Request is too large.');
    try {
        const value = JSON.parse(text);
        assert(value && typeof value === 'object' && !Array.isArray(value), 400, 'Expected a JSON object.');
        return value;
    } catch {
        throw new AppError(400, 'Invalid JSON request.');
    }
}
