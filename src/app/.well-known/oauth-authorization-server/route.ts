import { metadataResponse } from '@/modules/oauth/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET() {
    return metadataResponse('authorization');
}
