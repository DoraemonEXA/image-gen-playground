import {
    confirmSetup,
    createUser,
    login,
    prepareSetup,
    resetAuthenticator,
    revoke,
    session,
    setEnabled,
    setupClosed,
    throttle
} from './accounts';
import { adjustBalance, adminOverview, balance, personalUsage, reconcile } from './billing';
import { assert, isMultiUser } from './config';
import { deleteHistory, history } from './history';
import { body, clientIp, cookieToken, errorResponse, json, requireUser, sameOrigin, withSession } from './http';
import type { NextRequest } from 'next/server';

export async function handleAccountRequest(request: NextRequest) {
    try {
        assert(isMultiUser(), 404, 'Not found.');
        const route = request.nextUrl.pathname.replace('/api/multi-user/', '');
        const method = request.method;
        if (method === 'POST') sameOrigin(request);
        if (method === 'GET' && route === 'auth/me') {
            const user = session(cookieToken(request));
            return json({
                user: user ?? null,
                setupRequired: !setupClosed(),
                ...(user ? { ...balance(), ...personalUsage(user.id) } : {})
            });
        }
        if (method === 'POST' && route === 'auth/login') {
            const data = await body(request);
            return withSession(login(data.username, data.code, clientIp(request)));
        }
        if (method === 'POST' && route === 'auth/logout') {
            requireUser(request);
            revoke(cookieToken(request));
            return withSession('');
        }
        if (method === 'POST' && route.startsWith('setup/')) {
            const data = await body(request);
            if (route === 'setup/prepare') {
                throttle([[`setup-ip:${clientIp(request)}`, 30]]);
                return json(await prepareSetup(data.token, data.username));
            }
            if (route === 'setup/confirm') return withSession(confirmSetup(data.token, data.code, clientIp(request)));
        }
        const user = requireUser(request, route.startsWith('admin/'));
        if (method === 'GET' && route === 'history')
            return json(history(user.id, request.nextUrl.searchParams.get('cursor')));
        if (method === 'POST' && route === 'history/delete') {
            const data = await body(request);
            assert(
                data.clear === true ||
                    (Array.isArray(data.ids) &&
                        data.ids.length <= 100 &&
                        data.ids.every((id) => typeof id === 'string')),
                400,
                'Invalid history selection.'
            );
            deleteHistory(user.id, data.clear === true ? undefined : (data.ids as string[]));
            return json({ ok: true });
        }
        if (method === 'GET' && route === 'admin/overview') {
            const before = Number(request.nextUrl.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
            assert(Number.isSafeInteger(before) && before > 0, 400, 'Invalid ledger cursor.');
            return json(adminOverview(before));
        }
        if (method === 'POST' && route === 'admin/users') return json(await createUser((await body(request)).username));
        if (method === 'POST' && route === 'admin/user') {
            const data = await body(request);
            assert(typeof data.id === 'string', 400, 'Account ID required.');
            if (data.action === 'reset') return json(await resetAuthenticator(data.id));
            assert(typeof data.enabled === 'boolean', 400, 'Enabled must be a boolean.');
            setEnabled(data.id, data.enabled);
            return json({ ok: true });
        }
        if (method === 'POST' && route === 'admin/balance') {
            const data = await body(request);
            return json(adjustBalance(user.id, data.action, data.amount, data.reason, data.version));
        }
        if (method === 'POST' && route === 'admin/reconcile') {
            const data = await body(request);
            assert(typeof data.id === 'string', 400, 'Generation ID required.');
            reconcile(user.id, data.id, data.amount, data.reason);
            return json({ ok: true });
        }
        return json({ error: 'Not found.' }, 404);
    } catch (error) {
        return errorResponse(error);
    }
}
