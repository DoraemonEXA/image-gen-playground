import { executeImages } from '@/modules/images/execute';
import { generationAccess } from '@/modules/multi-user/generation';
import type { NextRequest } from 'next/server';

export function POST(request: NextRequest) {
    return executeImages(request, () => generationAccess(request));
}
