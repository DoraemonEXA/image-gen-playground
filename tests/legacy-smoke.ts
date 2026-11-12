import { POST as remove } from '../src/app/api/image-delete/route';
import { GET } from '../src/app/api/image/[filename]/route';
import { POST } from '../src/app/api/images/route';
import { NextRequest } from 'next/server';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

async function main() {
    const passwordHash = createHash('sha256').update('legacy').digest('hex');
    const data = new FormData();
    for (const [key, value] of Object.entries({ mode: 'generate', prompt: 'filesystem compatibility', passwordHash }))
        data.set(key, value);
    const response = await POST(new NextRequest('http://localhost/api/images', { method: 'POST', body: data }));
    assert.equal(response.status, 200);
    const result = await response.json();
    const filename = result.images[0].filename;
    assert.equal(result.images[0].path, `/api/image/${filename}`);
    assert.ok(fs.existsSync(`generated-images/${filename}`));
    const image = await GET(new NextRequest(`http://localhost/api/image/${filename}`), {
        params: Promise.resolve({ filename })
    });
    assert.equal(image.status, 200);
    const deletion = await remove(
        new NextRequest('http://localhost/api/image-delete', {
            method: 'POST',
            body: JSON.stringify({ filenames: [filename], passwordHash })
        })
    );
    assert.equal(deletion.status, 200);
    assert.equal(fs.existsSync(`generated-images/${filename}`), false);
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
