import { throttle } from '../multi-user/accounts';
import { AppError, config } from '../multi-user/config';
import { body, clientIp, requireUser } from '../multi-user/http';
import { registerClient } from './clients';
import { oauthAssert, OAuthError, readLimited, requireMcp, resourceMetadataUrl, resourceUrl, SCOPES } from './config';
import {
    beginAuthorization,
    completeAuthorization,
    connectedAgents,
    consentDetails,
    exchangeToken,
    revokeAgent,
    revokeToken,
    uniqueParameters
} from './store';
import { NextRequest, NextResponse } from 'next/server';

export const oauthHeaders = {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Authorization, Cookie'
};
export const oauthJson = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: oauthHeaders });

export function checkHttpOrigin(request: Request) {
    const origin = config().origin;
    const host = request.headers.get('host') || new URL(request.url).host;
    if (host.toLowerCase() !== new URL(origin).host.toLowerCase())
        throw new OAuthError('invalid_request', 'Invalid request host.', 403);
    const supplied = request.headers.get('origin');
    if (supplied !== null && supplied !== origin)
        throw new OAuthError('invalid_request', 'Request origin is not allowed.', 403);
}

export function oauthFailure(error: unknown, bearer = false) {
    const status = error instanceof OAuthError || error instanceof AppError ? error.status : 500;
    const code =
        error instanceof OAuthError
            ? error.code
            : status === 401
              ? 'login_required'
              : status === 429
                ? 'temporarily_unavailable'
                : status === 404
                  ? 'not_found'
                  : 'server_error';
    const message =
        error instanceof OAuthError || error instanceof AppError
            ? error.message
            : 'The server could not complete this operation.';
    const response = oauthJson({ error: code, error_description: message }, status);
    if (
        bearer &&
        [401, 403].includes(status) &&
        error instanceof OAuthError &&
        ['invalid_token', 'insufficient_scope'].includes(code)
    ) {
        response.headers.set(
            'WWW-Authenticate',
            `Bearer resource_metadata="${resourceMetadataUrl()}", error="${code}", scope="${SCOPES.join(' ')}"`
        );
    }
    if (status === 429) response.headers.set('Retry-After', '900');
    return response;
}

export function authorizationMetadata() {
    const origin = config().origin;
    return {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: SCOPES,
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true
    };
}
export function protectedResourceMetadata() {
    return {
        resource: resourceUrl(),
        authorization_servers: [config().origin],
        scopes_supported: SCOPES,
        bearer_methods_supported: ['header'],
        resource_name: 'Image Playground'
    };
}
export function metadataResponse(kind: 'authorization' | 'resource') {
    try {
        requireMcp();
        return oauthJson(kind === 'authorization' ? authorizationMetadata() : protectedResourceMetadata());
    } catch (error) {
        return oauthFailure(error);
    }
}

async function form(request: Request) {
    oauthAssert(
        request.headers.get('content-type')?.split(';')[0] === 'application/x-www-form-urlencoded',
        'invalid_request',
        'Expected URL-encoded form data.'
    );
    return new URLSearchParams(await readLimited(request, 16_384));
}

export async function handleOAuth(request: NextRequest) {
    try {
        requireMcp();
        checkHttpOrigin(request);
        const route = request.nextUrl.pathname.slice('/oauth/'.length);
        if (request.method === 'GET' && route === 'authorize') {
            throttle([[`oauth-authorize:${clientIp(request)}`, 60]]);
            oauthAssert(request.url.length <= 8192, 'invalid_request', 'Authorization URL is too long.');
            const id = await beginAuthorization(request.nextUrl.searchParams);
            return NextResponse.redirect(`${config().origin}/oauth/consent?request=${id}`, {
                status: 303,
                headers: oauthHeaders
            });
        }
        if (request.method === 'GET' && route === 'request') {
            return oauthJson(consentDetails(request.nextUrl.searchParams.get('request') || '', requireUser(request)));
        }
        if (request.method === 'POST' && route === 'decision') {
            const user = requireUser(request);
            const data = await body(request);
            oauthAssert(typeof data.approve === 'boolean', 'invalid_request', 'An approval decision is required.');
            return oauthJson({ redirect: completeAuthorization(data.request_id, data.csrf, data.approve, user) });
        }
        if (route === 'connections') {
            const user = requireUser(request);
            if (request.method === 'GET') return oauthJson({ agents: connectedAgents(user.id) });
            if (request.method === 'POST') {
                const data = await body(request);
                oauthAssert(
                    typeof data.id === 'string' && data.id.length <= 100,
                    'invalid_request',
                    'Grant ID required.'
                );
                revokeAgent(user.id, data.id);
                return oauthJson({ ok: true });
            }
        }
        if (request.method === 'POST' && route === 'register') {
            throttle([[`oauth-register:${clientIp(request)}`, 30]]);
            oauthAssert(
                request.headers.get('content-type')?.split(';')[0] === 'application/json',
                'invalid_request',
                'Expected JSON.'
            );
            const text = await readLimited(request, 16_384);
            let data: unknown;
            try {
                data = JSON.parse(text);
            } catch {
                throw new OAuthError('invalid_request', 'Invalid JSON.');
            }
            return oauthJson(registerClient(data), 201);
        }
        if (request.method === 'POST' && ['token', 'revoke'].includes(route)) {
            throttle([[`oauth-token:${clientIp(request)}`, 120]]);
            oauthAssert(!request.headers.has('authorization'), 'invalid_client', 'Use a public client ID with PKCE.');
            const parameters = await form(request);
            if (route === 'token') return oauthJson(exchangeToken(parameters));
            const data = uniqueParameters(parameters);
            oauthAssert(
                data.client_id && data.client_id.length <= 2048 && data.token && data.token.length <= 100,
                'invalid_request',
                'Client ID and token are required.'
            );
            revokeToken(data.token, data.client_id);
            return oauthJson({});
        }
        return oauthJson({ error: 'not_found' }, 404);
    } catch (error) {
        return oauthFailure(error);
    }
}
