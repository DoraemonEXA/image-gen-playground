import { IMAGE_SIZE_DESCRIPTION, IMAGE_SIZE_PATTERN, validateImageParameters } from '../../lib/image-params';
import {
    DEFAULT_GPT_IMAGE_MODEL,
    DEFAULT_SVG_WRITER_MODEL,
    EDIT_INPUT_FORMATS,
    getMimeType,
    GIF_FRAME_COUNT,
    GIF_FRAME_DURATION_MS,
    GPT_IMAGE_MODELS,
    IMAGE_OUTPUT_FORMATS,
    type ImageOutputFormat,
    MAX_EDIT_IMAGES,
    SVG_WRITER_MODELS
} from '../../lib/models';
import { executeImages } from '../images/execute';
import { AppError, assert, config } from '../multi-user/config';
import { database } from '../multi-user/database';
import { generationForUser } from '../multi-user/generation';
import { historyEntry, readImage } from '../multi-user/history';
import { hash } from '../multi-user/secrets';
import { MCP_MAX_BYTES, requireMcp, resourceUrl, type Scope } from '../oauth/config';
import { authenticateHash, type Principal, requireScope } from '../oauth/store';
import { imageDownload } from './downloads';
import * as z from 'zod/v4';

const imageInput = z.union([
    z.object({ image_id: z.string().min(1).max(100) }).strict(),
    z
        .object({
            data: z.string().min(4).max(MCP_MAX_BYTES),
            mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp'])
        })
        .strict()
]);
const common = {
    request_id: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_.:-]+$/)
        .describe('Unique request ID. Reuse it only when retrying this exact operation; retries never run it twice.'),
    prompt: z.string().min(1).max(32_000),
    model: z.enum(GPT_IMAGE_MODELS).default(DEFAULT_GPT_IMAGE_MODEL),
    n: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(1)
        .describe('Number of images, 1-10. SVG requires 1. GIFs also have a total tiled-sheet pixel budget.'),
    size: z.string().min(1).max(64).regex(IMAGE_SIZE_PATTERN).default('auto').describe(IMAGE_SIZE_DESCRIPTION),
    quality: z
        .enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
        .default('auto')
        .describe(
            'auto, low, medium, high for all models; xhigh and max only for gpt-image-2.5 and gpt-image-2.6. Low quality still requires a valid size.'
        ),
    background: z.enum(['auto', 'opaque', 'transparent']).default('auto'),
    moderation: z.enum(['auto', 'low']).default('auto'),
    output_format: z
        .enum(IMAGE_OUTPUT_FORMATS)
        .default('png')
        .describe(
            'png, jpeg or webp for all models. gif requires gpt-image-2.6; svg requires gpt-image-2.6 in generate mode and n=1. Transparent backgrounds cannot use jpeg.'
        ),
    output_compression: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('JPEG/WebP only: integer 0-100. Omit for other formats.'),
    complexity: z
        .enum(['low', 'medium', 'high'])
        .optional()
        .describe('Only gpt-image-2.6 models. Omit for older models; provider default is high.'),
    frame_count: z
        .number()
        .int()
        .min(GIF_FRAME_COUNT.min)
        .max(GIF_FRAME_COUNT.max)
        .optional()
        .describe(`GIF only. Defaults to ${GIF_FRAME_COUNT.default}; frame sizes are validated as a tiled sheet.`),
    frame_duration_ms: z
        .number()
        .int()
        .min(GIF_FRAME_DURATION_MS.min)
        .max(GIF_FRAME_DURATION_MS.max)
        .optional()
        .describe(`GIF only. Defaults to ${GIF_FRAME_DURATION_MS.default} milliseconds.`)
};
export const generateSchema = z
    .object({
        ...common,
        svg_model: z
            .enum(
                Object.keys(SVG_WRITER_MODELS) as [
                    keyof typeof SVG_WRITER_MODELS,
                    ...Array<keyof typeof SVG_WRITER_MODELS>
                ]
            )
            .optional(),
        svg_reasoning_effort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
    })
    .strict();
export const editSchema = z
    .object({
        ...common,
        images: z.array(imageInput).min(1).max(MAX_EDIT_IMAGES),
        mask: imageInput.optional(),
        markup: imageInput.optional()
    })
    .strict();
type Input = z.infer<typeof generateSchema> | z.infer<typeof editSchema>;
type ImageInput = z.infer<typeof imageInput>;

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
            .join(',')}}`;
    return JSON.stringify(value);
}

function source(principal: Principal, input: ImageInput) {
    if ('image_id' in input) {
        requireScope(principal, 'images:read');
        const image = readImage(principal.user.id, input.image_id);
        assert(
            EDIT_INPUT_FORMATS.includes(image.format as ImageOutputFormat),
            400,
            'Edit inputs must be PNG, JPEG, or WebP.'
        );
        return { bytes: image.buffer, mime: getMimeType(image.format as ImageOutputFormat) };
    }
    assert(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data),
        400,
        'Invalid base64 image.'
    );
    return { bytes: Buffer.from(input.data, 'base64'), mime: input.mime_type };
}

function createForm(principal: Principal, mode: 'generate' | 'edit', data: Input) {
    validateImageParameters({ ...data, mode });
    const form = new FormData();
    form.set('mode', mode);
    for (const [key, value] of Object.entries(data)) {
        if (!['request_id', 'images', 'mask', 'markup'].includes(key) && value !== undefined)
            form.set(key, String(value));
    }
    if (data.output_format === 'gif') {
        form.set('frame_count', String(data.frame_count ?? GIF_FRAME_COUNT.default));
        form.set('frame_duration_ms', String(data.frame_duration_ms ?? GIF_FRAME_DURATION_MS.default));
    }
    if (data.output_format === 'svg') {
        const params = data as z.infer<typeof generateSchema>;
        const model = params.svg_model ?? DEFAULT_SVG_WRITER_MODEL;
        form.set('svg_model', model);
    }
    let total = Buffer.byteLength(data.prompt);
    const append = (name: string, input: ImageInput) => {
        const { bytes, mime } = source(principal, input);
        total += bytes.length;
        assert(bytes.length > 0 && total <= MCP_MAX_BYTES, 413, 'Image inputs exceed the request size limit.');
        form.set(name, new File([new Uint8Array(bytes)], `${name}.${mime.split('/')[1]}`, { type: mime }));
    };
    if ('images' in data) {
        data.images.forEach((image, index) => append(`image_${index}`, image));
        if (data.mask) append('mask', data.mask);
        if (data.markup) append('markup', data.markup);
    }
    return form;
}

const starting = new Map<string, { fingerprint: string; promise: Promise<string> }>();
const running = new Set<Promise<void>>();

export async function startJob(principal: Principal, mode: 'generate' | 'edit', raw: unknown) {
    requireMcp();
    const scope: Scope = mode === 'generate' ? 'images:generate' : 'images:edit';
    requireScope(authenticateHash(principal.tokenHash), scope);
    const data = (mode === 'generate' ? generateSchema : editSchema).parse(raw);
    const fingerprint = hash(canonical({ mode, ...data }));
    const existing = database()
        .prepare('SELECT fingerprint,generation_id FROM mcp_requests WHERE user_id=? AND client_id=? AND request_id=?')
        .get(principal.user.id, principal.clientId, data.request_id) as
        { fingerprint: string; generation_id: string } | undefined;
    if (existing) {
        assert(existing.fingerprint === fingerprint, 409, 'This request_id was already used with different inputs.');
        return existing.generation_id;
    }
    const key = JSON.stringify([config().dataDir, principal.user.id, principal.clientId, data.request_id]);
    const pending = starting.get(key);
    if (pending) {
        assert(pending.fingerprint === fingerprint, 409, 'This request_id was already used with different inputs.');
        return pending.promise;
    }
    const promise = launchJob(principal, mode, data, fingerprint, scope);
    starting.set(key, { fingerprint, promise });
    try {
        return await promise;
    } finally {
        starting.delete(key);
    }
}

async function launchJob(
    principal: Principal,
    mode: 'generate' | 'edit',
    data: Input,
    fingerprint: string,
    scope: Scope
): Promise<string> {
    const form = createForm(principal, mode, data);
    let resolve!: (id: string) => void, reject!: (error: unknown) => void;
    let admitted = false;
    const admission = new Promise<string>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    const access = generationForUser(
        principal.user,
        () => {
            requireMcp();
            requireScope(authenticateHash(principal.tokenHash), scope);
        },
        (id) => {
            database()
                .prepare('INSERT INTO mcp_requests VALUES(?,?,?,?,?)')
                .run(principal.user.id, principal.clientId, data.request_id, fingerprint, id);
        }
    );
    const context = {
        ...access,
        start(parameters: object) {
            access.start(parameters);
            admitted = true;
            resolve(access.result().generationId!);
        }
    };
    // Independent of the MCP request signal: a lost response must not repeat a paid call.
    const execution = executeImages(new Request(resourceUrl(), { method: 'POST', body: form }), () => context);
    const job = execution
        .then(async (response) => {
            if (!admitted) {
                const result = await response.json();
                reject(new AppError(response.status, result.error || 'Generation was not admitted.'));
            } else await response.body?.cancel();
        })
        .catch((error) => {
            access.finish(false, error);
            reject(error);
        })
        .finally(() => running.delete(job));
    running.add(job);
    return admission;
}

export async function drainJobs() {
    await Promise.all([...running]);
}

export function jobResult(principal: Principal, generationId: string) {
    requireScope(principal, 'images:read');
    const request = database()
        .prepare('SELECT 1 FROM mcp_requests WHERE generation_id=? AND user_id=? AND client_id=?')
        .get(generationId, principal.user.id, principal.clientId);
    assert(request, 404, 'Generation not found.');
    const entry = historyEntry(principal.user.id, generationId);
    assert(entry, 404, 'Generation not found.');
    return {
        generation_id: generationId,
        state: entry.state,
        accounting: entry.accounting,
        images: entry.images.map((image) => ({
            image_id: image.filename,
            ...imageDownload(principal, image.filename)
        })),
        cost: entry.costDetails,
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.state === 'running' ? { poll_after_ms: 2000 } : {})
    };
}
