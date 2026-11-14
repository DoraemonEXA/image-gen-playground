import { ImageParameterError } from '../../lib/image-params';
import { AppError } from './config';
import OpenAI from 'openai';

export type GenerationFailure = {
    status: number;
    code: string;
    param?: string;
    message: string;
    request_id?: string;
};

// Only explicit parameter validation rejections qualify under the operator's no-charge provider policy.
const parameterCodes: Record<string, string> = {
    invalid_value: 'invalid value',
    invalid_parameter: 'invalid parameter',
    invalid_size: 'unsupported size',
    unsupported_parameter: 'unsupported parameter',
    unknown_parameter: 'unknown parameter',
    missing_required_parameter: 'missing required parameter'
};
const parameterNames = new Set([
    'model',
    'n',
    'size',
    'quality',
    'background',
    'moderation',
    'output_format',
    'output_compression',
    'complexity',
    'frame_count',
    'frame_duration_ms',
    'svg.model',
    'svg.reasoning.effort',
    'stream',
    'partial_images'
]);

export function isInitialParameterRejection(error: unknown): boolean {
    return (
        error instanceof OpenAI.APIError &&
        error.status === 400 &&
        error.type === 'invalid_request_error' &&
        Object.hasOwn(parameterCodes, error.code ?? '') &&
        parameterNames.has(error.param ?? '') &&
        !!error.error &&
        !['usage', 'svg_usage', 'data'].some((key) => Object.hasOwn(error.error!, key))
    );
}

/** Provider text can echo API keys, prompts, URLs or image data. Return messages built from known identifiers. */
export function generationFailure(error: unknown): GenerationFailure {
    if (error instanceof ImageParameterError)
        return { status: error.status, code: error.code, param: error.param, message: error.message };
    if (error instanceof OpenAI.APIError) {
        const param = parameterNames.has(error.param ?? '') ? error.param! : undefined;
        const knownCode = Object.hasOwn(parameterCodes, error.code ?? '') ? error.code! : undefined;
        const status = error.status ?? 502;
        const rejected = isInitialParameterRejection(error);
        const requestId =
            error.requestID && /^req_[A-Za-z0-9_-]{1,100}$/.test(error.requestID) ? error.requestID : undefined;
        return {
            status,
            code: knownCode ?? (status === 400 ? 'provider_rejected_request' : 'provider_error'),
            ...(param ? { param } : {}),
            message: rejected
                ? `Provider rejected ${param}: ${parameterCodes[knownCode!]}. Check the tool parameter constraints.`
                : status === 401 || status === 403
                  ? 'Provider authentication failed. Contact an administrator.'
                  : status === 400
                    ? 'Provider rejected the image request. Check the parameters and content.'
                    : 'Unable to complete the provider request. Check saved results; the provider charge may be unknown.',
            ...(requestId ? { request_id: requestId } : {})
        };
    }
    if (error instanceof AppError && error.status < 500)
        return { status: error.status, code: 'request_rejected', message: error.message };
    return {
        status: 500,
        code: 'generation_failed',
        message: 'Unable to complete generation. Check your history for any saved results.'
    };
}
