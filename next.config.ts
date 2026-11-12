import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  // Private image URLs must never acquire an alternate shared optimizer/cache path.
  images: { unoptimized: true },
  // Stop `next dev` from writing AGENTS.md / CLAUDE.md into the repo root.
  agentRules: false,
};

export default nextConfig;
