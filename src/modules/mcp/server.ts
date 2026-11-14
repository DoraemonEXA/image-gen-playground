import { ImageParameterError } from '../../lib/image-params';
import { getMimeType, type ImageOutputFormat } from '../../lib/models';
import { AppError } from '../multi-user/config';
import { generationFailure } from '../multi-user/generation-errors';
import { readImage } from '../multi-user/history';
import { MCP_MAX_BYTES, OAuthError, readLimited, requireMcp, type Scope } from '../oauth/config';
import { checkHttpOrigin, oauthFailure, oauthHeaders, oauthJson } from '../oauth/http';
import { authenticate, authenticateHash, type Principal, requireScope } from '../oauth/store';
import { imageDownload } from './downloads';
import { editSchema, generateSchema, jobResult, startJob } from './jobs';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

function textResult(value: object) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value };
}

function serverFor(principal: Principal) {
    const server = new McpServer({ name: 'image-playground', version: '1.0.0' });
    const safe =
        <T>(operation: () => Promise<T> | T) =>
        async () => {
            try {
                requireMcp();
                authenticateHash(principal.tokenHash);
                return await operation();
            } catch (error) {
                if (error instanceof ImageParameterError) {
                    const details = { error: generationFailure(error) };
                    return { isError: true, ...textResult(details) };
                }
                const message =
                    error instanceof AppError || error instanceof OAuthError || error instanceof z.ZodError
                        ? error.message
                        : 'The server could not complete this operation.';
                return { isError: true, content: [{ type: 'text' as const, text: message }] };
            }
        };
    const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
    if (principal.scopes.includes('images:generate'))
        server.registerTool(
            'generate_image',
            {
                description:
                    'Generate images using the shared paid balance. Prefer default options or size=1024x1024; 512x512 is invalid for still images. Invalid parameters are rejected before admission. Returns a generation_id immediately after admission. Poll get_generation, then use get_image. Reuse request_id for an exact retry; use a new ID when changing an admitted request.',
                inputSchema: generateSchema,
                annotations: writeAnnotations
            },
            async (input) =>
                safe(async () =>
                    textResult({ generation_id: await startJob(principal, 'generate', input), poll_after_ms: 2000 })
                )()
        );
    if (principal.scopes.includes('images:edit'))
        server.registerTool(
            'edit_image',
            {
                description:
                    'Edit images using the shared paid balance. Supply base64 image data with mime_type, or your own image_id; local file paths and remote URLs are not inputs. Poll get_generation, then get_image.',
                inputSchema: editSchema,
                annotations: writeAnnotations
            },
            async (input) =>
                safe(async () =>
                    textResult({ generation_id: await startJob(principal, 'edit', input), poll_after_ms: 2000 })
                )()
        );
    if (principal.scopes.includes('images:read')) {
        server.registerTool(
            'get_generation',
            {
                description:
                    'Get the status, accounting, result identifiers and sanitized error (status/code/param/message/request_id when available) of a generation submitted by this client for this user. Each image includes a signed download_url and download_url_expires_at, usable without cookies or Authorization for up to one hour. Call again to refresh links without regenerating. Poll running jobs every two seconds. Failed/interrupted jobs are not automatically retried. Changing parameters after admission requires a new request_id.',
                inputSchema: z.object({ generation_id: z.string().min(1).max(100) }).strict(),
                annotations: { readOnlyHint: true, openWorldHint: false }
            },
            async ({ generation_id }) => safe(() => textResult(jobResult(principal, generation_id)))()
        );
        server.registerTool(
            'get_image',
            {
                description:
                    'Read one of your images by image_id. Raster files are returned as MCP image content; SVG is returned as a binary resource. Also returns download_url and download_url_expires_at in text and structured content. Anyone with the signed URL can GET or HEAD this image without cookies or Authorization for up to one hour, unless access is revoked. Call again to refresh the link without regenerating.',
                inputSchema: z.object({ image_id: z.string().min(1).max(100) }).strict(),
                annotations: { readOnlyHint: true, openWorldHint: false }
            },
            async ({ image_id }) =>
                safe(() => {
                    requireScope(principal, 'images:read');
                    const { buffer, format } = readImage(principal.user.id, image_id);
                    const mimeType = getMimeType(format as ImageOutputFormat),
                        data = buffer.toString('base64');
                    const download = { image_id, ...imageDownload(principal, image_id) };
                    return {
                        structuredContent: download,
                        content: [
                            ...(format === 'svg'
                                ? [
                                      {
                                          type: 'resource' as const,
                                          resource: {
                                              uri: `image-playground://images/${image_id}`,
                                              mimeType,
                                              blob: data
                                          }
                                      }
                                  ]
                                : [{ type: 'image' as const, mimeType, data }]),
                            { type: 'text' as const, text: JSON.stringify(download) }
                        ]
                    };
                })()
        );
    }
    return server;
}

export async function handleMcp(request: Request) {
    try {
        requireMcp();
        checkHttpOrigin(request);
        const principal = authenticate(request);
        if (!['GET', 'POST', 'DELETE'].includes(request.method)) return oauthJson({ error: 'method_not_allowed' }, 405);
        let parsedBody: unknown;
        if (request.method === 'POST') {
            if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
                return oauthJson({ error: 'invalid_request' }, 415);
            const text = await readLimited(request, MCP_MAX_BYTES);
            try {
                parsedBody = JSON.parse(text);
            } catch {
                return oauthJson({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
            }
            if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
                const message = parsedBody as { method?: unknown; params?: { name?: unknown } };
                const scopes: Record<string, Scope> = {
                    generate_image: 'images:generate',
                    edit_image: 'images:edit',
                    get_generation: 'images:read',
                    get_image: 'images:read'
                };
                if (
                    message.method === 'tools/call' &&
                    typeof message.params?.name === 'string' &&
                    Object.hasOwn(scopes, message.params.name)
                ) {
                    const required = scopes[message.params.name];
                    if (!principal.scopes.includes(required)) {
                        const response = oauthFailure(
                            new OAuthError('insufficient_scope', `Required scope: ${required}`, 403),
                            true
                        );
                        response.headers.set(
                            'WWW-Authenticate',
                            response.headers.get('WWW-Authenticate')!.replace(/scope="[^"]*"/, `scope="${required}"`)
                        );
                        return response;
                    }
                }
            }
        }
        authenticateHash(principal.tokenHash);
        const handler = createMcpHandler(() => serverFor(principal), {
            legacy: 'stateless',
            maxRequestBodySize: MCP_MAX_BYTES
        });
        const response = await handler.fetch(request, { parsedBody });
        for (const [key, value] of Object.entries(oauthHeaders)) response.headers.set(key, value);
        return response;
    } catch (error) {
        return oauthFailure(error, true);
    }
}
