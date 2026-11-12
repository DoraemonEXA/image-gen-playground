import http from 'node:http';

export const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=';
export const usage = {
    input_tokens: 300,
    input_tokens_details: { text_tokens: 100, image_tokens: 200 },
    output_tokens: 300,
    total_tokens: 600
};

export async function mockProvider() {
    let calls = 0;
    const server = http.createServer(async (request, response) => {
        calls++;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString();
        const json = request.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null;
        const stream = json ? json.stream : /name="stream"\r\n\r\ntrue/.test(text);
        const format = json?.output_format || 'png';
        if (text.includes('mock-delay')) await new Promise((resolve) => setTimeout(resolve, 200));
        if (text.includes('mock-error')) {
            response.writeHead(400, { 'Content-Type': 'application/json' });
            response.end(
                JSON.stringify({ error: { message: 'Mock provider rejection', type: 'invalid_request_error' } })
            );
            return;
        }
        const returnedUsage = text.includes('mock-no-usage') ? undefined : usage;
        if (stream) {
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const prefix = request.url?.endsWith('/edits') ? 'image_edit' : 'image_generation';
            response.write(
                `data: ${JSON.stringify({ type: `${prefix}.partial_image`, b64_json: png, partial_image_index: 0 })}\n\n`
            );
            response.write(
                `data: ${JSON.stringify({ type: `${prefix}.completed`, b64_json: png, usage: returnedUsage })}\n\n`
            );
            if (text.includes('mock-partial-failure')) {
                response.end('data: invalid-json\n\n');
                return;
            }
            response.end('data: [DONE]\n\n');
        } else {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            const n = json?.n || 1;
            response.end(
                JSON.stringify({
                    created: Math.floor(Date.now() / 1000),
                    data: Array.from({ length: n }, () => ({
                        b64_json:
                            format === 'svg'
                                ? Buffer.from(
                                      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
                                  ).toString('base64')
                                : png
                    })),
                    usage: returnedUsage,
                    ...(format === 'svg' ? { svg_usage: { input_tokens: 100, output_tokens: 200 } } : {})
                })
            );
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    return {
        url: `http://127.0.0.1:${address.port}/v1`,
        calls: () => calls,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error ? reject(error) : resolve()));
            })
    };
}
