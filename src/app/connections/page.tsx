import { mcpEnabled } from '@/modules/oauth/config';
import { ConnectionsScreen } from '@/modules/oauth/screens';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';
export default function Page() {
    if (!mcpEnabled()) notFound();
    return <ConnectionsScreen />;
}
