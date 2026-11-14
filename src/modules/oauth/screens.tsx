'use client';

import { AccountRuntime, useAccountRuntime } from '../multi-user/client';
import { usePreferences } from '../preferences/client';
import Link from 'next/link';
import * as React from 'react';

const button = 'rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50';
const permissionLabels: Record<string, string> = {
    'images:generate': 'Generate images using the shared balance',
    'images:edit': 'Edit supplied images using the shared balance',
    'images:read': 'Read your images by identifier and retrieve agent results'
};
type Consent = {
    request_id: string;
    client_name: string;
    client_id: string;
    redirect_uri: string;
    scopes: string[];
    username: string;
    csrf: string;
    sessionId: string;
};

export function ConsentScreen({ requestId }: { requestId: string }) {
    const { t } = usePreferences();
    const [details, setDetails] = React.useState<Consent>();
    const [error, setError] = React.useState(
        /^[A-Za-z0-9_-]{43}$/.test(requestId) ? '' : 'Invalid authorization request.'
    );
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => {
        let current = true;
        const id = requestId;
        if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return;
        void fetch(`/oauth/request?request=${id}`, { cache: 'no-store', credentials: 'same-origin' })
            .then(async (response) => {
                if (!current) return;
                if (response.status === 401) {
                    window.location.replace(`/login?oauth_request=${id}`);
                    return;
                }
                const data = await response.json();
                if (!response.ok) throw new Error(data.error_description || 'Request failed.');
                if (current) setDetails(data);
            })
            .catch((error) => {
                if (current) setError(error.message);
            });
        return () => {
            current = false;
        };
    }, [requestId]);
    const decide = async (approve: boolean) => {
        if (!details) return;
        setBusy(true);
        setError('');
        try {
            const response = await fetch('/oauth/decision', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'X-Playground-Session': details.sessionId },
                body: JSON.stringify({ request_id: details.request_id, csrf: details.csrf, approve })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error_description || 'Request failed.');
            window.location.assign(data.redirect);
        } catch (error) {
            setError((error as Error).message);
            setBusy(false);
        }
    };
    return (
        <main className='text-foreground mx-auto max-w-xl p-6'>
            <section className='border-border bg-card space-y-5 rounded-xl border p-6'>
                <h1 className='text-2xl font-semibold'>{t('Connect an agent')}</h1>
                {error && (
                    <p role='alert' className='text-destructive'>
                        {t(error)}
                    </p>
                )}
                {!details && !error && <p>{t('Loading account…')}</p>}
                {details && (
                    <>
                        <p>
                            {t('Authorize {client} as {user}?', {
                                client: details.client_name,
                                user: details.username
                            })}
                        </p>
                        <p className='text-muted-foreground text-sm'>
                            {t(
                                'Client names are provided by the connecting application. Check the client and callback before approving.'
                            )}
                        </p>
                        <dl className='space-y-1 text-sm break-all'>
                            <dt className='font-medium'>{t('Client ID')}</dt>
                            <dd>{details.client_id}</dd>
                            <dt className='font-medium'>{t('Callback')}</dt>
                            <dd>{details.redirect_uri}</dd>
                        </dl>
                        <ul className='list-inside list-disc space-y-2'>
                            {details.scopes.map((scope) => (
                                <li key={scope}>{t(permissionLabels[scope] || scope)}</li>
                            ))}
                        </ul>
                        <p>{t('Access lasts up to 30 days. You can revoke it at any time in Connected agents.')}</p>
                        <p className='text-muted-foreground text-sm'>
                            {t('Generation and editing spend the existing shared balance and use your account limits.')}
                        </p>
                        <div className='flex gap-3'>
                            <button className={button} disabled={busy} onClick={() => void decide(true)}>
                                {t('Approve access')}
                            </button>
                            <button
                                className='rounded border px-4 py-2'
                                disabled={busy}
                                onClick={() => void decide(false)}>
                                {t('Deny')}
                            </button>
                        </div>
                    </>
                )}
                <Link className='block underline' href='/'>
                    {t('Playground')}
                </Link>
            </section>
        </main>
    );
}

type Agent = { id: string; client_name: string; client_id: string; scope: string; created: number; expires: number };
function Connections() {
    const runtime = useAccountRuntime();
    const accountFetch = runtime.fetch;
    const { t, locale } = usePreferences();
    const [agents, setAgents] = React.useState<Agent[]>([]);
    const [error, setError] = React.useState('');
    const [loading, setLoading] = React.useState(true);
    const [busy, setBusy] = React.useState('');
    React.useEffect(() => {
        let current = true;
        void accountFetch('/oauth/connections')
            .then(async (response) => {
                const data = await response.json();
                if (!response.ok) throw new Error(data.error_description || 'Request failed.');
                if (current) setAgents(data.agents);
            })
            .catch((error) => {
                if (current) setError(error.message);
            })
            .finally(() => {
                if (current) setLoading(false);
            });
        return () => {
            current = false;
        };
    }, [accountFetch]);
    const revoke = async (id: string) => {
        setBusy(id);
        setError('');
        try {
            const response = await runtime.fetch('/oauth/connections', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error_description || 'Request failed.');
            setAgents((items) => items.filter((item) => item.id !== id));
        } catch (error) {
            setError((error as Error).message);
        } finally {
            setBusy('');
        }
    };
    return (
        <main className='mx-auto max-w-3xl space-y-5 p-6'>
            <h1 className='text-2xl font-semibold'>{t('Connected agents')}</h1>
            <p className='text-muted-foreground'>
                {t('Revoking access stops new agent requests. Already admitted image jobs can finish and be charged.')}
            </p>
            {error && (
                <p role='alert' className='text-destructive'>
                    {t(error)}
                </p>
            )}
            {loading ? <p>{t('Loading account…')}</p> : agents.length === 0 && <p>{t('No connected agents.')}</p>}
            {agents.map((agent) => (
                <article key={agent.id} className='border-border bg-card space-y-3 rounded-xl border p-5'>
                    <h2 className='text-lg font-medium'>{agent.client_name}</h2>
                    <p className='text-muted-foreground text-sm break-all'>{agent.client_id}</p>
                    <ul className='list-inside list-disc text-sm'>
                        {agent.scope.split(' ').map((scope) => (
                            <li key={scope}>{t(permissionLabels[scope] || scope)}</li>
                        ))}
                    </ul>
                    <p>{t('Expires: {date}', { date: new Date(agent.expires).toLocaleString(locale) })}</p>
                    <button className={button} disabled={!!busy} onClick={() => void revoke(agent.id)}>
                        {t('Revoke access')}
                    </button>
                </article>
            ))}
        </main>
    );
}
export function ConnectionsScreen() {
    return (
        <AccountRuntime>
            <Connections />
        </AccountRuntime>
    );
}
