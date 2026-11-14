import { handleImageDownload } from '@/modules/mcp/downloads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ image_id: string }> }) {
    return handleImageDownload(request, (await params).image_id);
}

export { GET as HEAD };
