import { mcpEnabled } from '@/modules/oauth/config';
import { ConsentScreen } from '@/modules/oauth/screens';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Connect an agent', referrer: 'no-referrer' };
export default async function Page({ searchParams }: { searchParams: Promise<{ request?: string }> }) {
    if (!mcpEnabled()) notFound();
    const { request } = await searchParams;
    return <ConsentScreen requestId={typeof request === 'string' ? request : ''} />;
}
