import type { ApiUsage } from '../../lib/cost-utils';
import { getStreamingBlockedReason, type ImageOutputFormat, MAX_EDIT_IMAGES, SVG_WRITER_MODELS } from '../../lib/models';
import type { User } from './accounts';
import { balance, settle } from './billing';
import { assert, config, isMultiUser } from './config';
import { database } from './database';
import { historyEntry, imagePath } from './history';
import { requireUser } from './http';
import type { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ImagesResponse } from 'openai/resources/images';
















/** The only multi-user lifecycle the upstream generator needs to know. Null means legacy mode. */
export function generationAccess(request: NextRequest) {
    if (!isMultiUser()) return null;
    const user = requireUser(request);
    return generationForUser(user, () => {
        requireUser(request);
    });
}

/** Internal entry point. Callers must authenticate, and revalidate at admission. */
export function generationForUser(user: User, revalidate: () => void, onAdmission?: (generationId: string) => void) {
    let id: string | undefined;
    let finished = false;
    let saved = 0;
    let started = 0;
    return {
        start(parameters: object) {
            assert(!id, 500, 'Generation already started.');
            // Recheck at admission after potentially slow multipart parsing.
            revalidate();
            const params = parameters as Record<string, unknown>;
            if (params.stream) {
                const reason = getStreamingBlockedReason(Number(params.n), params.output_format as ImageOutputFormat);
                assert(!reason, 400, reason || 'Unsupported streaming request.');
            }
            if (params.svg)
                assert(
                    Object.hasOwn(SVG_WRITER_MODELS, (params.svg as { model: string }).model),
                    400,
                    'Unsupported SVG writer model.'
                );
            if (Array.isArray(params.image))
                assert(params.image.length <= MAX_EDIT_IMAGES, 400, 'Too many edit source images.');
            const metadata: Record<string, unknown> = { durationMs: 0 };
            for (const key of [
                'mode',
                'prompt',
                'model',
                'n',
                'size',
                'quality',
                'background',
                'moderation',
                'output_format',
                'complexity',
                'frame_count',
                'frame_duration_ms'
            ]) {
                if (params[key] !== undefined) metadata[key] = params[key];
            }
            if (params.svg) metadata.svg_model = (params.svg as { model: string }).model;
            const generationId = randomUUID();
            const limits = config();
            database()
                .transaction(() => {
                    assert(
                        balance().balance > 0,
                        402,
                        'Shared balance is exhausted. Ask an administrator to add funds.'
                    );
                    const counts = database()
                        .prepare(
                            'SELECT COUNT(*) AS total,COALESCE(SUM(user_id=?),0) AS personal FROM generations WHERE active=1'
                        )
                        .get(user.id) as { total: number; personal: number };
                    assert(
                        counts.personal < limits.perUser && counts.total < limits.global,
                        429,
                        'Generation capacity is busy. Please retry later.'
                    );
                    database()
                        .prepare('INSERT INTO generations(id,user_id,created,model,metadata) VALUES(?,?,?,?,?)')
                        .run(generationId, user.id, Date.now(), String(params.model), JSON.stringify(metadata));
                    // The MCP idempotency record commits atomically with admission.
                    onAdmission?.(generationId);
                })
                .immediate();
            id = generationId;
            started = Date.now();
        },
        settle(usage: ApiUsage | undefined, svgUsage?: ImagesResponse.SvgUsage) {
            if (id) settle(id, usage, svgUsage);
        },
        save(b64: string, format: string) {
            assert(id && /^[a-z0-9]+$/.test(format), 500, 'Invalid generation storage context.');
            assert(b64, 502, 'Provider returned an empty image.');
            const filename = `${randomUUID()}.${format}`;
            const target = imagePath(user.id, id, filename);
            fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
            fs.writeFileSync(target, Buffer.from(b64, 'base64'), { flag: 'wx', mode: 0o600 });
            try {
                database().prepare('INSERT INTO images VALUES(?,?,?,?)').run(filename, id, user.id, format);
            } catch (error) {
                fs.rmSync(target, { force: true });
                throw error;
            }
            saved++;
            return filename;
        },
        finish(success: boolean) {
            if (!id || finished) return;
            database()
                .transaction(() => {
                    const row = database().prepare('SELECT metadata FROM generations WHERE id=?').get(id) as {
                        metadata: string;
                    };
                    const metadata = { ...JSON.parse(row.metadata), durationMs: Date.now() - started };
                    database()
                        .prepare(
                            `UPDATE generations SET active=0,state=?,metadata=?,
                    accounting=CASE WHEN accounting='pending' THEN 'needs_reconciliation' ELSE accounting END WHERE id=?`
                        )
                        .run(success ? 'complete' : saved ? 'partial' : 'failed', JSON.stringify(metadata), id);
                })
                .immediate();
            finished = true;
        },
        result() {
            return id ? { generationId: id, history: historyEntry(user.id, id) } : {};
        }
    };
}
