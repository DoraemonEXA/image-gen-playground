'use client';

import type { ServerHistory } from './history';
import { usePreferences } from '@/modules/preferences/client';
import Link from 'next/link';
import * as React from 'react';

export type Identity = { id: string; username: string; role: 'admin' | 'user'; sessionId: string };
type AccountState = {
    user: Identity | null;
    balance?: number;
    version?: number;
    spending?: number;
    unresolved?: number;
    setupRequired?: boolean;
};
type Runtime = {
    multi: boolean;
    user: Identity | null;
    fetch: typeof fetch;
    refresh: () => Promise<void>;
    isCurrent: () => boolean;
};
const Context = React.createContext<Runtime | null>(null);
const ACCOUNT_REFRESH_INTERVAL_MS = 60_000;
export const usd = (units: number = 0) => `$${(units / 10_000).toFixed(4)}`;

export function announceSessionChange() {
    try {
        const channel = new BroadcastChannel('playground-session');
        channel.postMessage('changed');
        channel.close();
    } catch {
        /* Storage events and focus verification remain available. */
    }
    try {
        localStorage.setItem('playground-session-event', String(Date.now()));
    } catch {
        /* Storage may be disabled. */
    }
}

export async function api<T>(path: string, data?: object, sessionId?: string): Promise<T> {
    const response = await fetch(`/api/multi-user/${path}`, {
        method: data ? 'POST' : 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
            ...(data ? { 'Content-Type': 'application/json' } : {}),
            ...(sessionId ? { 'X-Playground-Session': sessionId } : {})
        },
        body: data ? JSON.stringify(data) : undefined
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Request failed.');
    return result;
}

export function useAccountRuntime() {
    const context = React.useContext(Context);
    if (!context) throw new Error('Account runtime is not mounted');
    return context;
}

export function AccountRuntime({ children, admin = false }: { children: React.ReactNode; admin?: boolean }) {
    const { t } = usePreferences();
    const [mode, setMode] = React.useState<'multi-user' | 'single-user' | null>(null);
    const [account, setAccount] = React.useState<AccountState | null>(null);
    const [error, setError] = React.useState('');
    const identity = React.useRef<string | null>(null);
    const invalid = React.useRef(false);
    const requests = React.useRef(new Set<AbortController>());
    const lastRefreshed = React.useRef(0);
    const activeRefreshes = React.useRef(0);
    const [blocked, setBlocked] = React.useState(false);
    const invalidate = React.useCallback(() => {
        invalid.current = true;
        requests.current.forEach((controller) => controller.abort());
        setBlocked(true);
        window.location.replace('/login');
    }, []);
    const refresh = React.useCallback(async () => {
        if (invalid.current) return;
        activeRefreshes.current++;
        try {
            const next = await api<AccountState>('auth/me');
            if (invalid.current) return;
            if (!next.user || (identity.current && identity.current !== next.user.sessionId)) {
                invalidate();
                return;
            }
            identity.current = next.user.sessionId;
            lastRefreshed.current = Date.now();
            setAccount(next);
        } finally {
            activeRefreshes.current--;
        }
    }, [invalidate]);

    React.useEffect(() => {
        let cancelled = false;
        fetch('/api/auth-status', { cache: 'no-store' })
            .then(async (response) => {
                if (!response.ok) throw new Error('Could not load application mode.');
                const status = await response.json();
                if (cancelled) return;
                if (status.mode === 'multi-user') await refresh();
                if (!cancelled) setMode(status.mode);
            })
            .catch((error) => {
                if (!cancelled) setError(error.message);
            });
        return () => {
            cancelled = true;
        };
    }, [refresh]);

    React.useEffect(() => {
        if (mode !== 'multi-user') return;
        const controllers = requests.current;
        const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('playground-session');
        if (channel) channel.onmessage = invalidate;
        const check = () => {
            // Automatic checks share a freshness window; explicit post-action refreshes stay immediate.
            if (
                document.visibilityState !== 'visible' ||
                activeRefreshes.current > 0 ||
                Date.now() - lastRefreshed.current < ACCOUNT_REFRESH_INTERVAL_MS
            )
                return;
            refresh().catch(() => setError('Session verification failed. Reload to continue.'));
        };
        const onStorage = (event: StorageEvent) => {
            if (event.key === 'playground-session-event') invalidate();
        };
        const onPageShow = (event: PageTransitionEvent) => {
            if (event.persisted) invalidate();
        };
        const timer = setInterval(check, ACCOUNT_REFRESH_INTERVAL_MS);
        window.addEventListener('focus', check);
        window.addEventListener('storage', onStorage);
        window.addEventListener('pageshow', onPageShow);
        return () => {
            clearInterval(timer);
            channel?.close();
            controllers.forEach((controller) => controller.abort());
            window.removeEventListener('focus', check);
            window.removeEventListener('storage', onStorage);
            window.removeEventListener('pageshow', onPageShow);
        };
    }, [mode, refresh, invalidate]);

    const sessionId = account?.user?.sessionId;
    const scopedFetch = React.useCallback<typeof fetch>(
        async (input, init) => {
            if (mode === 'single-user') return fetch(input, init);
            if (invalid.current) throw new Error('Session changed.');
            const controller = new AbortController();
            requests.current.add(controller);
            const headers = new Headers(init?.headers);
            headers.set('X-Playground-Session', sessionId || '');
            const release = () => requests.current.delete(controller);
            controller.signal.addEventListener('abort', release, { once: true });
            try {
                const response = await fetch(input, { ...init, headers, cache: 'no-store', signal: controller.signal });
                if (response.status === 401) invalidate();
                if (invalid.current) throw new Error('Session changed.');
                if (!response.body) {
                    release();
                    return response;
                }
                const reader = response.body.getReader();
                const stream = new ReadableStream({
                    async pull(target) {
                        try {
                            const chunk = await reader.read();
                            if (invalid.current) throw new Error('Session changed.');
                            if (chunk.done) {
                                release();
                                target.close();
                            } else target.enqueue(chunk.value);
                        } catch (error) {
                            release();
                            target.error(error);
                        }
                    },
                    async cancel(reason) {
                        release();
                        controller.abort();
                        await reader.cancel(reason);
                    }
                });
                return new Response(stream, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers
                });
            } catch (error) {
                release();
                throw error;
            }
        },
        [mode, sessionId, invalidate]
    );
    const runtime = React.useMemo<Runtime>(
        () => ({
            multi: mode === 'multi-user',
            user: account?.user ?? null,
            fetch: scopedFetch,
            refresh,
            isCurrent: () => !invalid.current
        }),
        [mode, account?.user, scopedFetch, refresh]
    );

    if (error)
        return (
            <div className='text-destructive p-8' role='alert'>
                {t(error)} <button onClick={() => window.location.reload()}>{t('Reload')}</button>
            </div>
        );
    if (blocked || !mode || (mode === 'multi-user' && !account?.user))
        return <p className='p-8'>{t('Loading account…')}</p>;
    if (admin && (mode !== 'multi-user' || account?.user?.role !== 'admin'))
        return <p className='p-8'>{t('Administrator access required.')}</p>;
    const logout = async () => {
        try {
            await api('auth/logout', {}, sessionId);
        } catch {
            setError('Sign out could not be confirmed. Reload and try again.');
            return;
        }
        announceSessionChange();
        invalidate();
    };
    return (
        <Context.Provider value={runtime}>
            <div>
                {mode === 'multi-user' && (
                    <header className='border-border bg-background text-foreground flex flex-wrap items-center gap-5 border-b px-6 py-3 text-sm'>
                        <Link href='/'>{t('Playground')}</Link>
                        <span>{account?.user?.username}</span>
                        <span>
                            {t('Shared balance:')} <strong>{usd(account?.balance)}</strong>
                        </span>
                        <span>
                            {t('My estimated spending:')} {usd(account?.spending)}
                        </span>
                        {!!account?.unresolved && (
                            <span className='text-warning'>{t('Usage awaiting reconciliation')}</span>
                        )}
                        {account?.user?.role === 'admin' && (
                            <a className='underline' href='/admin'>
                                {t('Administration')}
                            </a>
                        )}
                        <button className='ml-auto underline' onClick={logout}>
                            {t('Sign out')}
                        </button>
                    </header>
                )}
                {children}
            </div>
        </Context.Provider>
    );
}

export async function loadPrivateHistory(runtime: Pick<Runtime, 'fetch'>, cursor?: string) {
    const response = await runtime.fetch(
        `/api/multi-user/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load history.');
    return result as {
        items: ServerHistory[];
        nextCursor: string | null;
        summary: { totalCost: number; totalImages: number };
    };
}
