import {
    DEFAULT_GPT_IMAGE_MODEL,
    DEFAULT_SVG_WRITER_MODEL,
    EXTENDED_QUALITIES,
    getAvailableOutputFormats,
    getStreamingBlockedReason,
    GIF_FRAME_COUNT,
    GIF_FRAME_DURATION_MS,
    IMAGE_OUTPUT_FORMATS,
    type ImageMode,
    type ImageOutputFormat,
    type ImageQuality,
    isGptImageModel,
    MODEL_CAPABILITIES,
    SVG_WRITER_MODELS
} from './models';
import {
    CUSTOM_SIZE_EDGE_MULTIPLE,
    CUSTOM_SIZE_MAX_ASPECT,
    CUSTOM_SIZE_MAX_EDGE,
    CUSTOM_SIZE_MAX_PIXELS,
    CUSTOM_SIZE_MIN_PIXELS,
    validateSizeSelection
} from './size-utils';

export const IMAGE_SIZE_PATTERN = /^(auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/;
export const IMAGE_SIZE_DESCRIPTION = `Use auto or WIDTHxHEIGHT, e.g. 1024x1024, 1536x1024, 1024x1536. Still images: both edges multiples of ${CUSTOM_SIZE_EDGE_MULTIPLE}, maximum edge ${CUSTOM_SIZE_MAX_EDGE}, aspect ratio at most ${CUSTOM_SIZE_MAX_ASPECT}:1, total pixels ${CUSTOM_SIZE_MIN_PIXELS}-${CUSTOM_SIZE_MAX_PIXELS}. 512x512 is too small for a still image. GIF sizes describe each frame; these limits apply to the tiled frame sheet instead.`;

export class ImageParameterError extends Error {
    readonly status = 400;
    readonly code = 'invalid_image_parameter';
    constructor(
        public readonly param: string,
        message: string
    ) {
        super(`${param}: ${message}`);
    }
}

/** Validate raw multipart fields and MCP inputs before admission, without silently changing supplied values. */
export function validateImageParameters(params: Record<string, unknown>) {
    const fail = (param: string, message: string): never => {
        throw new ImageParameterError(param, message);
    };
    const choice = (param: string, choices: readonly string[], fallback?: string) => {
        const value = params[param] ?? fallback;
        if (typeof value !== 'string' || !choices.includes(value)) fail(param, `Use ${choices.join(', ')}.`);
        return value as string;
    };
    const integer = (param: string, min: number, max: number, fallback?: number) => {
        const raw = params[param] ?? fallback;
        const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
            fail(param, `Use a whole number from ${min} to ${max}.`);
        return value as number;
    };
    const mode = choice('mode', ['generate', 'edit']) as ImageMode;
    const model = params.model ?? DEFAULT_GPT_IMAGE_MODEL;
    if (!isGptImageModel(model))
        throw new ImageParameterError('model', 'Use a model from the supported model catalog.');
    const capabilities = MODEL_CAPABILITIES[model];
    const quality = choice('quality', ['auto', 'low', 'medium', 'high', ...EXTENDED_QUALITIES], 'auto');
    if (!capabilities.extendedQuality && EXTENDED_QUALITIES.includes(quality as ImageQuality))
        fail('quality', `${model} supports auto, low, medium, high.`);
    // Preserve the route's existing JPEG alias and case normalization.
    const rawFormat = params.output_format ?? 'png';
    const normalizedFormat =
        typeof rawFormat === 'string' ? rawFormat.toLowerCase().replace(/^jpg$/, 'jpeg') : rawFormat;
    if (typeof normalizedFormat !== 'string' || !(IMAGE_OUTPUT_FORMATS as readonly string[]).includes(normalizedFormat))
        fail('output_format', `Use ${IMAGE_OUTPUT_FORMATS.join(', ')}.`);
    const format = normalizedFormat as ImageOutputFormat;
    if (!getAvailableOutputFormats(model, mode).includes(format))
        fail('output_format', `For ${model} ${mode}, use ${getAvailableOutputFormats(model, mode).join(', ')}.`);
    const n = integer('n', 1, 10, 1);
    const background = choice('background', ['auto', 'opaque', 'transparent'], 'auto');
    choice('moderation', ['auto', 'low'], 'auto');
    if (background === 'transparent' && format === 'jpeg')
        fail('background', 'Transparent backgrounds require a format with transparency, such as png or webp.');
    if (params.complexity !== undefined) {
        if (!capabilities.complexity) fail('complexity', `${model} does not support complexity; omit this field.`);
        choice('complexity', ['low', 'medium', 'high']);
    }
    if (params.output_compression !== undefined) {
        integer('output_compression', 0, 100);
        if (format !== 'jpeg' && format !== 'webp')
            fail('output_compression', 'Only jpeg and webp support compression; otherwise omit this field.');
    }
    let frameCount: number = GIF_FRAME_COUNT.default;
    if (format === 'gif') {
        frameCount = integer('frame_count', GIF_FRAME_COUNT.min, GIF_FRAME_COUNT.max, GIF_FRAME_COUNT.default);
        integer(
            'frame_duration_ms',
            GIF_FRAME_DURATION_MS.min,
            GIF_FRAME_DURATION_MS.max,
            GIF_FRAME_DURATION_MS.default
        );
    } else {
        for (const field of ['frame_count', 'frame_duration_ms'])
            if (params[field] !== undefined) fail(field, 'Only gif output supports this field; otherwise omit it.');
    }
    const size = params.size ?? 'auto';
    if (typeof size !== 'string' || !IMAGE_SIZE_PATTERN.test(size))
        fail('size', 'Use auto or WIDTHxHEIGHT, for example 1024x1024.');
    if (size !== 'auto') {
        const [width, height] = (size as string).split('x').map(Number);
        const result = validateSizeSelection('custom', width, height, format, frameCount, n);
        if (!result.valid)
            fail('size', `${result.reason} Use auto or a supported size; 1024x1024 is a standard still-image size.`);
    }
    if (format === 'svg') {
        if (n !== 1) fail('n', 'SVG output requires n=1.');
        const svgModel = choice(
            'svg_model',
            Object.keys(SVG_WRITER_MODELS),
            DEFAULT_SVG_WRITER_MODEL
        ) as keyof typeof SVG_WRITER_MODELS;
        if (params.svg_reasoning_effort !== undefined) choice('svg_reasoning_effort', SVG_WRITER_MODELS[svgModel]);
    } else {
        for (const field of ['svg_model', 'svg_reasoning_effort'])
            if (params[field] !== undefined) fail(field, 'Only svg output supports this field; otherwise omit it.');
    }
    if (params.stream !== undefined && ![true, false, 'true', 'false'].includes(params.stream as boolean | string))
        fail('stream', 'Use true or false.');
    if (params.stream === true || params.stream === 'true') {
        const reason = getStreamingBlockedReason(n, format);
        if (reason) fail('stream', reason);
    }
}
