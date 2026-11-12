'use client';

import type { ServerHistory } from './history';
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
    const [mode, setMode] = React.useState<'multi-user' | 'single-user' | null>(null);
    const [account, setAccount] = React.useState<AccountState | null>(null);
    const [error, setError] = React.useState('');
    const identity = React.useRef<string | null>(null);
    const invalid = React.useRef(false);
    const requests = React.useRef(new Set<AbortController>());
    const [blocked, setBlocked] = React.useState(false);
    const [checking, setChecking] = React.useState(false);
    const invalidate = React.useCallback(() => {
        invalid.current = true;
        requests.current.forEach((controller) => controller.abort());
        setBlocked(true);
        window.location.replace('/login');
    }, []);
    const refresh = React.useCallback(async () => {
        const next = await api<AccountState>('auth/me');
        if (!next.user || (identity.current && identity.current !== next.user.sessionId)) {
            invalidate();
            return;
        }
        identity.current = next.user.sessionId;
        setAccount(next);
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
            refresh().catch(() => setError('Session verification failed. Reload to continue.'));
        };
        const checkOnFocus = () => {
            setChecking(true);
            refresh()
                .then(() => setChecking(false))
                .catch(() => setError('Session verification failed. Reload to continue.'));
        };
        const onStorage = (event: StorageEvent) => {
            if (event.key === 'playground-session-event') invalidate();
        };
        const onPageShow = (event: PageTransitionEvent) => {
            if (event.persisted) invalidate();
        };
        const timer = setInterval(check, 60_000);
        window.addEventListener('focus', checkOnFocus);
        window.addEventListener('storage', onStorage);
        window.addEventListener('pageshow', onPageShow);
        return () => {
            clearInterval(timer);
            channel?.close();
            controllers.forEach((controller) => controller.abort());
            window.removeEventListener('focus', checkOnFocus);
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
            <div className='p-8 text-red-300' role='alert'>
                {error} <button onClick={() => window.location.reload()}>Reload</button>
            </div>
        );
    if (blocked || !mode || (mode === 'multi-user' && !account?.user)) return <p className='p-8'>Loading account…</p>;
    if (admin && (mode !== 'multi-user' || account?.user?.role !== 'admin'))
        return <p className='p-8'>Administrator access required.</p>;
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
            {checking && (
                <p className='p-4' role='status'>
                    Verifying session…
                </p>
            )}
            <div hidden={checking}>
                {mode === 'multi-user' && (
                    <header className='flex flex-wrap items-center gap-5 border-b border-neutral-800 bg-neutral-950 px-6 py-3 text-sm text-white'>
                        <Link href='/'>Playground</Link>
                        <span>{account?.user?.username}</span>
                        <span>
                            Shared balance: <strong>{usd(account?.balance)}</strong>
                        </span>
                        <span>My estimated spending: {usd(account?.spending)}</span>
                        {!!account?.unresolved && <span className='text-amber-300'>Usage awaiting reconciliation</span>}
                        {account?.user?.role === 'admin' && (
                            <a className='underline' href='/admin'>
                                Administration
                            </a>
                        )}
                        <button className='ml-auto underline' onClick={logout}>
                            Sign out
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
