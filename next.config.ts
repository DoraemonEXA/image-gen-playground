import type { NextConfig } from 'next';




const nextConfig: NextConfig = {
    serverExternalPackages: ['better-sqlite3'],
    // Private image URLs must never acquire an alternate shared optimizer/cache path.
    images: { unoptimized: true },
    // Stop `next dev` from writing AGENTS.md / CLAUDE.md into the repo root.
    agentRules: false,
    async headers() {
        return [
            {
                source: '/oauth/:path*',
                headers: [
                    { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
                    { key: 'X-Frame-Options', value: 'DENY' },
                    { key: 'Referrer-Policy', value: 'no-referrer' },
                    { key: 'Cache-Control', value: 'no-store' }
                ]
            }
        ];
    }
};

export default nextConfig;
