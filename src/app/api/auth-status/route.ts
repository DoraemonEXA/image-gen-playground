import { isMultiUser, privateHeaders } from '@/modules/multi-user/config';
import { NextResponse } from 'next/server';

export async function GET() {
    const multiUser = isMultiUser();
    return NextResponse.json(
        { mode: multiUser ? 'multi-user' : 'single-user', passwordRequired: !multiUser && !!process.env.APP_PASSWORD },
        { headers: privateHeaders }
    );
}
