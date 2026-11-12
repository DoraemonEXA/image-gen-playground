import { isMultiUser } from '@/modules/multi-user/config';
import { database } from '@/modules/multi-user/database';

export const dynamic = 'force-dynamic';
export function GET() {
    try {
        if (isMultiUser()) database().prepare('SELECT 1').get();
        return Response.json({ status: 'ready' }, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
        return Response.json({ status: 'unavailable' }, { status: 503 });
    }
}
