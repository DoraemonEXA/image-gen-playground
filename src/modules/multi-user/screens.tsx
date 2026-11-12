'use client';

import { AccountRuntime, announceSessionChange, api, useAccountRuntime, usd } from './client';
import Image from 'next/image';
import * as React from 'react';

const input = 'block w-full rounded border border-neutral-600 bg-neutral-950 p-2 text-white';
const button = 'rounded bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-40';
const panel = 'space-y-4 rounded-xl border border-neutral-700 bg-neutral-900 p-6';
type Provisioning = { username: string; qr: string; secret: string };

function Qr({ value }: { value: Provisioning }) {
    return (
        <div className='space-y-3 rounded border border-amber-500 p-4'>
            <p>
                Authenticator for <strong>{value.username}</strong>. Save or share this privately now; it will not be
                shown again after you leave.
            </p>
            <Image
                src={value.qr}
                alt={`Authenticator QR code for ${value.username}`}
                width={280}
                height={280}
                unoptimized
            />
            <p>
                Manual setup key: <code className='break-all select-all'>{value.secret}</code>
            </p>
        </div>
    );
}

export function LoginScreen() {
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    return (
        <main className='mx-auto max-w-md p-8 text-white'>
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
                <h1 className='text-2xl font-semibold'>Sign in</h1>
                <p className='text-sm text-neutral-300'>
                    Use the account and authenticator QR code provided by your administrator.
                </p>
                <label className='block'>
                    Username
                    <input className={input} name='username' autoComplete='username' required />
                </label>
                <label className='block'>
                    Authenticator code
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
                    <p role='alert' className='text-red-300'>
                        {error}
                    </p>
                )}
                <button className={button} disabled={busy}>
                    Sign in
                </button>
            </form>
        </main>
    );
}

export function SetupScreen() {
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
        <main className='mx-auto max-w-lg space-y-4 p-8 text-white'>
            <div className={panel}>
                <h1 className='text-2xl font-semibold'>Set up administrator</h1>
                {!token ? (
                    <p>Use the short-lived setup link issued by the server operator.</p>
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
                                Admin username
                                <input className={input} name='username' pattern='[a-zA-Z0-9_.\-]{3,40}' required />
                            </label>
                        ) : (
                            <>
                                <Qr value={provision} />
                                <label className='block'>
                                    Verify authenticator code
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
                            {provision ? 'Activate administrator' : 'Generate authenticator QR'}
                        </button>
                    </form>
                )}
                {error && (
                    <p role='alert' className='text-red-300'>
                        {error}
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
        <main className='mx-auto max-w-6xl space-y-6 p-6 text-white'>
            <h1 className='text-3xl font-semibold'>Administration</h1>
            {error && (
                <p role='alert' className='rounded bg-red-950 p-4 text-red-200'>
                    {error}{' '}
                    <button className='underline' onClick={() => refresh()}>
                        Refresh data
                    </button>
                </p>
            )}
            {notice && <p role='status'>{notice}</p>}
            {overview && (
                <>
                    <section className={panel}>
                        <h2 className='text-xl'>Shared balance: {usd(overview.balance)}</h2>
                        <p className='text-sm text-neutral-300'>
                            Charges are estimates from API usage and the playground price table. Running requests may
                            take the balance below zero.
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
                                Action
                                <select className={input} name='action'>
                                    <option value='add'>Add funds</option>
                                    <option value='set'>Set remaining balance</option>
                                </select>
                            </label>
                            <label>
                                USD amount
                                <input className={input} name='amount' inputMode='decimal' required />
                            </label>
                            <label>
                                Reason
                                <input className={input} name='reason' maxLength={500} required />
                            </label>
                            <button className={`${button} self-end`} disabled={busy}>
                                Update balance
                            </button>
                        </form>
                    </section>
                    <section className={panel}>
                        <h2 className='text-xl'>Accounts</h2>
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
                                New username
                                <input name='username' className={input} required />
                            </label>
                            <button className={button} disabled={busy}>
                                Create user
                            </button>
                        </form>
                        {provision && (
                            <>
                                <Qr value={provision} />
                                <button className={button} onClick={() => setProvision(null)}>
                                    Dismiss QR code
                                </button>
                            </>
                        )}
                        <div className='overflow-auto'>
                            <table className='w-full text-left text-sm'>
                                <thead>
                                    <tr>
                                        <th>Username</th>
                                        <th>Status</th>
                                        <th>Estimated spending</th>
                                        <th>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {overview.users.map((user) => (
                                        <tr key={user.id} className='border-t border-neutral-700'>
                                            <td className='py-3'>
                                                {user.username} {user.role === 'admin' && '(admin)'}
                                            </td>
                                            <td>{user.enabled ? 'Enabled' : 'Disabled'}</td>
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
                                                            {user.enabled ? 'Disable' : 'Enable'}
                                                        </button>
                                                        <button
                                                            className='underline'
                                                            disabled={busy}
                                                            onClick={() => {
                                                                if (
                                                                    confirm(
                                                                        `Replace ${user.username}'s authenticator and revoke all their sessions?`
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
                                                            Reset authenticator
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
                        <h2 className='text-xl'>Needs reconciliation ({overview.unresolved.length})</h2>
                        <p className='text-sm text-neutral-300'>
                            Enter the full charge for requests whose usage was unavailable, or 0 if confirmed uncharged.
                        </p>
                        {overview.unresolved.map((row) => (
                            <form
                                key={row.id}
                                className='flex flex-wrap items-end gap-3 border-t border-neutral-700 py-3'
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
                                    {row.username} · {row.model} · {row.state}
                                    <br />
                                    <code>{row.id}</code>
                                </span>
                                <label>
                                    Charge in USD
                                    <input className={input} name='amount' required />
                                </label>
                                <label>
                                    Reason
                                    <input className={input} name='reason' required />
                                </label>
                                <button className={button} disabled={busy}>
                                    Reconcile
                                </button>
                            </form>
                        ))}
                    </section>
                    <section className={panel}>
                        <h2 className='text-xl'>Balance ledger</h2>
                        <div className='overflow-auto'>
                            <table className='w-full text-left text-sm'>
                                <thead>
                                    <tr>
                                        <th>Time</th>
                                        <th>Type / user</th>
                                        <th>Amount</th>
                                        <th>Balance after</th>
                                        <th>Reason / admin</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {overview.ledger.map((row) => (
                                        <tr className='border-t border-neutral-700' key={row.id}>
                                            <td className='py-3'>{new Date(row.created).toLocaleString()}</td>
                                            <td>
                                                {row.kind} {row.username}
                                            </td>
                                            <td>{usd(row.amount)}</td>
                                            <td>{usd(row.balance_after)}</td>
                                            <td>
                                                {row.reason} {row.actor && `(${row.actor})`}
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
                                Load older entries
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
