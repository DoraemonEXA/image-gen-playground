import { type ApiUsage, calculateApiCost } from '../../lib/cost-utils';
import type { GptImageModel, SvgWriterModel } from '../../lib/models';
import { assert } from './config';
import { database } from './database';
import type { ImagesResponse } from 'openai/resources/images';

export type Balance = { balance: number; version: number };
export function balance(): Balance {
    return database().prepare('SELECT balance,version FROM settings WHERE id=1').get() as Balance;
}

export function money(value: unknown) {
    assert(
        typeof value === 'string' && /^\d+(\.\d{1,4})?$/.test(value),
        400,
        'Enter a nonnegative USD amount with at most four decimal places.'
    );
    const [whole, fraction = ''] = value.split('.');
    const units = Number(whole) * 10_000 + Number(fraction.padEnd(4, '0'));
    assert(Number.isSafeInteger(units), 400, 'Amount is too large.');
    return units;
}

function reasonText(reason: unknown) {
    assert(
        typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 500,
        400,
        'A reason of 1–500 characters is required.'
    );
    return reason.trim();
}

function entry(
    amount: number,
    kind: string,
    actor: string | null,
    user: string | null,
    generation: string | null,
    reason: string
) {
    const current = balance();
    assert(Number.isSafeInteger(current.balance + amount), 400, 'Balance is outside the supported range.');
    database().prepare('UPDATE settings SET balance=balance+?,version=version+1 WHERE id=1').run(amount);
    database()
        .prepare(
            `INSERT INTO ledger(created,kind,amount,actor_id,user_id,generation_id,reason,balance_after)
        VALUES(?,?,?,?,?,?,?,?)`
        )
        .run(Date.now(), kind, amount, actor, user, generation, reason, current.balance + amount);
}

export function adjustBalance(actor: string, action: unknown, amount: unknown, reason: unknown, version: unknown) {
    const units = money(amount);
    const text = reasonText(reason);
    assert(action === 'add' || action === 'set', 400, 'Invalid balance action.');
    database()
        .transaction(() => {
            const current = balance();
            if (action === 'set')
                assert(version === current.version, 409, 'Balance changed. Refresh before setting it.');
            entry(action === 'set' ? units - current.balance : units, action, actor, null, null, text);
        })
        .immediate();
    return balance();
}

function validUsage(usage: ApiUsage | undefined, svg?: ImagesResponse.SvgUsage) {
    const values = [
        usage?.input_tokens_details?.text_tokens,
        usage?.input_tokens_details?.image_tokens,
        usage?.output_tokens,
        ...(svg ? [svg.input_tokens, svg.output_tokens] : [])
    ];
    return values.every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

export function settle(id: string, usage: ApiUsage | undefined, svgUsage?: ImagesResponse.SvgUsage) {
    database()
        .transaction(() => {
            const row = database()
                .prepare('SELECT user_id,model,metadata,accounting FROM generations WHERE id=?')
                .get(id) as { user_id: string; model: GptImageModel; metadata: string; accounting: string };
            if (['settled', 'reconciled'].includes(row.accounting)) return;
            const metadata = JSON.parse(row.metadata);
            const svg = metadata.svg_model as SvgWriterModel | undefined;
            const complete = validUsage(usage, svgUsage) && (metadata.output_format !== 'svg' || !!svgUsage);
            const cost = complete
                ? calculateApiCost(usage, row.model, svg && svgUsage ? { model: svg, usage: svgUsage } : undefined)
                : null;
            const units = cost ? Math.round(cost.estimated_cost_usd * 10_000) : null;
            const known = units !== null && Number.isSafeInteger(units) && units >= 0;
            database()
                .prepare('UPDATE generations SET usage=?,accounting=? WHERE id=?')
                .run(JSON.stringify({ usage, svgUsage }), known ? 'settled' : 'needs_reconciliation', id);
            if (known) {
                entry(-units, 'usage', null, row.user_id, id, 'Estimated API usage');
                database()
                    .prepare('UPDATE generations SET cost_units=?,cost_details=? WHERE id=?')
                    .run(units, JSON.stringify(cost), id);
            }
        })
        .immediate();
}

export function reconcile(actor: string, id: string, amount: unknown, reason: unknown) {
    const units = money(amount);
    const text = reasonText(reason);
    database()
        .transaction(() => {
            const row = database().prepare('SELECT user_id,accounting,active FROM generations WHERE id=?').get(id) as
                { user_id: string; accounting: string; active: number } | undefined;
            assert(
                row && !row.active && row.accounting === 'needs_reconciliation',
                409,
                'This request is not awaiting reconciliation.'
            );
            entry(-units, 'reconciliation', actor, row.user_id, id, text);
            database().prepare("UPDATE generations SET accounting='reconciled',cost_units=? WHERE id=?").run(units, id);
        })
        .immediate();
}

/** Called only for an initial provider parameter rejection under the configured no-charge policy. */
export function reconcileRejectedRequest(id: string) {
    database()
        .transaction(() => {
            const row = database()
                .prepare(
                    `SELECT user_id FROM generations g WHERE id=? AND active=0
            AND state='failed' AND accounting='needs_reconciliation' AND usage IS NULL
            AND NOT EXISTS(SELECT 1 FROM images i WHERE i.generation_id=g.id)`
                )
                .get(id) as { user_id: string } | undefined;
            if (!row) return;
            entry(
                0,
                'reconciliation',
                null,
                row.user_id,
                id,
                'Automatic zero charge: initial parameter rejection under AUTO_RECONCILE_INVALID_REQUESTS policy'
            );
            database().prepare("UPDATE generations SET accounting='reconciled',cost_units=0 WHERE id=?").run(id);
        })
        .immediate();
}

export function personalUsage(id: string) {
    return database()
        .prepare(
            `SELECT COALESCE(SUM(cost_units),0) AS spending,
        SUM(CASE WHEN accounting='needs_reconciliation' THEN 1 ELSE 0 END) AS unresolved
        FROM generations WHERE user_id=?`
        )
        .get(id) as { spending: number; unresolved: number };
}

export function adminOverview(before = Number.MAX_SAFE_INTEGER) {
    const db = database();
    return {
        ...balance(),
        users: db
            .prepare(
                `SELECT u.id,u.username,u.role,u.enabled,u.created,COALESCE(SUM(g.cost_units),0) AS spending
            FROM users u LEFT JOIN generations g ON g.user_id=u.id GROUP BY u.id ORDER BY u.created`
            )
            .all(),
        unresolved: db
            .prepare(
                `SELECT g.id,u.username,g.created,g.model,g.state FROM generations g JOIN users u ON u.id=g.user_id
            WHERE g.accounting='needs_reconciliation' ORDER BY g.created`
            )
            .all(),
        ledger: db
            .prepare(
                `SELECT l.id,l.created,l.kind,l.amount,l.reason,l.balance_after,l.generation_id,
            u.username AS username,a.username AS actor FROM ledger l LEFT JOIN users u ON u.id=l.user_id
            LEFT JOIN users a ON a.id=l.actor_id WHERE l.id<? ORDER BY l.id DESC LIMIT 100`
            )
            .all(before)
    };
}
