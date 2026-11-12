'use client';

import { AccountRuntime, announceSessionChange, api, usd, useAccountRuntime } from './client';
import { usePreferences } from '@/modules/preferences/client';
import Image from 'next/image';
import * as React from 'react';

const input = 'block w-full rounded border border-border bg-background p-2 text-foreground';
const button = 'rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-40';
const panel = 'space-y-4 rounded-xl border border-border bg-card p-6';
type Provisioning = { username: string; qr: string; secret: string };

function Qr({ value }: { value: Provisioning }) {
    const { t } = usePreferences();
    return (
        <div className='space-y-3 rounded border border-amber-500 p-4'>
            <p>
                {t('Authenticator for')} <strong>{value.username}</strong>
                {t('. Save or share this privately now; it will not be shown again after you leave.')}
            </p>
            <Image
                src={value.qr}
                alt={t('Authenticator QR code for {v0}', { v0: value.username })}
                width={280}
                height={280}
                unoptimized
            />
            <p>
                {t('Manual setup key:')} <code className='break-all select-all'>{value.secret}</code>
            </p>
        </div>
    );
}

export function LoginScreen() {
    const { t } = usePreferences();
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    return (
        <main className='text-foreground mx-auto max-w-md p-8'>
            <form
                className={panel}
                onSubmit={async (event) => {
                    event.preventDefault();
                    setBusy(true);
                    setError('');
                    const fields = new FormData(event.currentTarget);
                    try {
                        await api('auth/login', { username: fields.get('username'), code: fields.get('code') });
                        announceSessionChange();
                        window.location.replace('/');
                    } catch (error) {
                        setError((error as Error).message);
                        setBusy(false);
                    }
                }}>
                <h1 className='text-2xl font-semibold'>{t('Sign in')}</h1>
                <p className='text-muted-foreground text-sm'>
                    {t('Use the account and authenticator QR code provided by your administrator.')}
                </p>
                <label className='block'>
                    {t('Username')}
                    <input className={input} name='username' autoComplete='username' required />
                </label>
                <label className='block'>
                    {t('Authenticator code')}
                    <input
                        className={input}
                        name='code'
                        inputMode='numeric'
                        pattern='[0-9]{6}'
                        autoComplete='one-time-code'
                        required
                    />
                </label>
                {error && (
                    <p role='alert' className='text-destructive'>
                        {t(error)}
                    </p>
                )}
                <button className={button} disabled={busy}>
                    {t('Sign in')}
                </button>
            </form>
        </main>
    );
}

export function SetupScreen() {
    const { t } = usePreferences();
    const [token, setToken] = React.useState('');
    const [provision, setProvision] = React.useState<Provisioning | null>(null);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => {
        queueMicrotask(() => {
            const value = new URLSearchParams(window.location.hash.slice(1)).get('token');
            if (value) {
                setToken(value);
                window.history.replaceState(null, '', '/setup');
            }
        });
    }, []);
    return (
        <main className='text-foreground mx-auto max-w-lg space-y-4 p-8'>
            <div className={panel}>
                <h1 className='text-2xl font-semibold'>{t('Set up administrator')}</h1>
                {!token ? (
                    <p>{t('Use the short-lived setup link issued by the server operator.')}</p>
                ) : (
                    <form
                        className='space-y-4'
                        onSubmit={async (event) => {
                            event.preventDefault();
                            setBusy(true);
                            setError('');
                            const data = new FormData(event.currentTarget);
                            try {
                                if (!provision)
                                    setProvision(
                                        await api<Provisioning>('setup/prepare', {
                                            token,
                                            username: data.get('username')
                                        })
                                    );
                                else {
                                    await api('setup/confirm', { token, code: data.get('code') });
                                    window.location.replace('/admin');
                                }
                            } catch (error) {
                                setError((error as Error).message);
                            } finally {
                                setBusy(false);
                            }
                        }}>
                        {!provision ? (
                            <label>
                                {t('Admin username')}
                                <input className={input} name='username' pattern='[a-zA-Z0-9_.\-]{3,40}' required />
                            </label>
                        ) : (
                            <>
                                <Qr value={provision} />
                                <label className='block'>
                                    {t('Verify authenticator code')}
                                    <input
                                        className={input}
                                        name='code'
                                        inputMode='numeric'
                                        pattern='[0-9]{6}'
                                        required
                                    />
                                </label>
                            </>
                        )}
                        <button className={button} disabled={busy}>
                            {provision ? t('Activate administrator') : t('Generate authenticator QR')}
                        </button>
                    </form>
                )}
                {error && (
                    <p role='alert' className='text-destructive'>
                        {t(error)}
                    </p>
                )}
            </div>
        </main>
    );
}

type Overview = {
    balance: number;
    version: number;
    users: Array<{ id: string; username: string; role: string; enabled: number; spending: number }>;
    unresolved: Array<{ id: string; username: string; model: string; state: string }>;
    ledger: Array<{
        id: number;
        created: number;
        kind: string;
        amount: number;
        reason: string;
        balance_after: number;
        actor: string | null;
        username: string | null;
    }>;
};

function Administration() {
    const { t, locale } = usePreferences();
    const runtime = useAccountRuntime();
    const [overview, setOverview] = React.useState<Overview | null>(null);
    const [provision, setProvision] = React.useState<Provisioning | null>(null);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState('');
    const sid = runtime.user!.sessionId;
    const refresh = React.useCallback(async () => {
        setOverview(await api<Overview>('admin/overview', undefined, sid));
    }, [sid]);
    React.useEffect(() => {
        queueMicrotask(() => {
            void refresh().catch((error) => setError(error.message));
        });
    }, [refresh]);
    const action = async (run: () => Promise<unknown>) => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
            await run();
            await refresh();
            await runtime.refresh();
            setNotice('Saved.');
        } catch (error) {
            setError((error as Error).message);
        } finally {
            setBusy(false);
        }
    };
    return (
        <main className='text-foreground mx-auto max-w-6xl space-y-6 p-6'>
            <h1 className='text-3xl font-semibold'>{t('Administration')}</h1>
            {error && (
                <p role='alert' className='text-destructive bg-destructive/10 rounded p-4'>
                    {t(error)}{' '}
                    <button className='underline' onClick={() => refresh()}>
                        {t('Refresh data')}
                    </button>
                </p>
            )}
            {notice && <p role='status'>{t(notice)}</p>}
            {overview && (
                <>
                    <section className={panel}>
                        <h2 className='text-xl'>
                            {t('Shared balance:')} {usd(overview.balance)}
                        </h2>
                        <p className='text-muted-foreground text-sm'>
                            {t(
                                'Charges are estimates from API usage and the playground price table. Running requests may take the balance below zero.'
                            )}
                        </p>
                        <form
                            className='grid gap-3 md:grid-cols-4'
                            onSubmit={(event) => {
                                event.preventDefault();
                                const data = new FormData(event.currentTarget);
                                void action(() =>
                                    api(
                                        'admin/balance',
                                        {
                                            action: data.get('action'),
                                            amount: data.get('amount'),
                                            reason: data.get('reason'),
                                            version: overview.version
                                        },
                                        sid
                                    )
                                );
                            }}>
                            <label>
                                {t('Action')}
                                <select className={input} name='action'>
                                    <option value='add'>{t('Add funds')}</option>
                                    <option value='set'>{t('Set remaining balance')}</option>
                                </select>
                            </label>
                            <label>
                                {t('USD amount')}
                                <input className={input} name='amount' inputMode='decimal' required />
                            </label>
                            <label>
                                {t('Reason')}
                                <input className={input} name='reason' maxLength={500} required />
                            </label>
                            <button className={`${button} self-end`} disabled={busy}>
                                {t('Update balance')}
                            </button>
                        </form>
                    </section>
                    <section className={panel}>
                        <h2 className='text-xl'>{t('Accounts')}</h2>
                        <form
                            className='flex items-end gap-3'
                            onSubmit={(event) => {
                                event.preventDefault();
                                const data = new FormData(event.currentTarget);
                                void action(async () =>
                                    setProvision(
                                        await api<Provisioning>('admin/users', { username: data.get('username') }, sid)
                                    )
                                );
                            }}>
                            <label>
                                {t('New username')}
                                <input name='username' className={input} required />
                            </label>
                            <button className={button} disabled={busy}>
                                {t('Create user')}
                            </button>
                        </form>
                        {provision && (
                            <>
                                <Qr value={provision} />
                                <button className={button} onClick={() => setProvision(null)}>
                                    {t('Dismiss QR code')}
                                </button>
                            </>
                        )}
                        <div className='overflow-auto'>
                            <table className='w-full text-left text-sm'>
                                <thead>
                                    <tr>
                                        <th>{t('Username')}</th>
                                        <th>{t('Status')}</th>
                                        <th>{t('Estimated spending')}</th>
                                        <th>{t('Actions')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {overview.users.map((user) => (
                                        <tr key={user.id} className='border-border border-t'>
                                            <td className='py-3'>
                                                {user.username} {user.role === 'admin' && `(${t('admin')})`}
                                            </td>
                                            <td>{user.enabled ? t('Enabled') : t('Disabled')}</td>
                                            <td>{usd(user.spending)}</td>
                                            <td className='space-x-3'>
                                                {user.role === 'user' && (
                                                    <>
                                                        <button
                                                            className='underline'
                                                            disabled={busy}
                                                            onClick={() =>
                                                                void action(() =>
                                                                    api(
                                                                        'admin/user',
                                                                        { id: user.id, enabled: !user.enabled },
                                                                        sid
                                                                    )
                                                                )
                                                            }>
                                                            {user.enabled ? t('Disable') : t('Enable')}
                                                        </button>
                                                        <button
                                                            className='underline'
                                                            disabled={busy}
                                                            onClick={() => {
                                                                if (
                                                                    confirm(
                                                                        t(
                                                                            `Replace ${user.username}'s authenticator and revoke all their sessions?`
                                                                        )
                                                                    )
                                                                )
                                                                    void action(async () =>
                                                                        setProvision(
                                                                            await api<Provisioning>(
                                                                                'admin/user',
                                                                                { id: user.id, action: 'reset' },
                                                                                sid
                                                                            )
                                                                        )
                                                                    );
                                                            }}>
                                                            {t('Reset authenticator')}
                                                        </button>
                                                    </>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                    <section className={panel}>
                        <h2 className='text-xl'>
                            {t('Needs reconciliation (')}
                            {overview.unresolved.length})
                        </h2>
                        <p className='text-muted-foreground text-sm'>
                            {t(
                                'Enter the full charge for requests whose usage was unavailable, or 0 if confirmed uncharged.'
                            )}
                        </p>
                        {overview.unresolved.map((row) => (
                            <form
                                key={row.id}
                                className='border-border flex flex-wrap items-end gap-3 border-t py-3'
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    const data = new FormData(event.currentTarget);
                                    void action(() =>
                                        api(
                                            'admin/reconcile',
                                            { id: row.id, amount: data.get('amount'), reason: data.get('reason') },
                                            sid
                                        )
                                    );
                                }}>
                                <span className='text-sm'>
                                    {row.username} · {row.model} · {t(row.state)}
                                    <br />
                                    <code>{row.id}</code>
                                </span>
                                <label>
                                    {t('Charge in USD')}
                                    <input className={input} name='amount' required />
                                </label>
                                <label>
                                    {t('Reason')}
                                    <input className={input} name='reason' required />
                                </label>
                                <button className={button} disabled={busy}>
                                    {t('Reconcile')}
                                </button>
                            </form>
                        ))}
                    </section>
                    <section className={panel}>
                        <h2 className='text-xl'>{t('Balance ledger')}</h2>
                        <div className='overflow-auto'>
                            <table className='w-full text-left text-sm'>
                                <thead>
                                    <tr>
                                        <th>{t('Time')}</th>
                                        <th>{t('Type / user')}</th>
                                        <th>{t('Amount')}</th>
                                        <th>{t('Balance after')}</th>
                                        <th>{t('Reason / admin')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {overview.ledger.map((row) => (
                                        <tr className='border-border border-t' key={row.id}>
                                            <td className='py-3'>{new Date(row.created).toLocaleString(locale)}</td>
                                            <td>
                                                {t(row.kind)} {row.username}
                                            </td>
                                            <td>{usd(row.amount)}</td>
                                            <td>{usd(row.balance_after)}</td>
                                            <td>
                                                {row.kind === 'usage' ? t(row.reason) : row.reason}{' '}
                                                {row.actor && `(${row.actor})`}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {overview.ledger.length >= 100 && (
                            <button
                                className={button}
                                onClick={async () => {
                                    const older = await api<Overview>(
                                        `admin/overview?before=${overview.ledger.at(-1)!.id}`,
                                        undefined,
                                        sid
                                    );
                                    setOverview({ ...overview, ledger: [...overview.ledger, ...older.ledger] });
                                }}>
                                {t('Load older entries')}
                            </button>
                        )}
                    </section>
                </>
            )}
        </main>
    );
}

export function AdminScreen() {
    return (
        <AccountRuntime admin>
            <Administration />
        </AccountRuntime>
    );
}
