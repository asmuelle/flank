import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages export TypeScript sources directly.
  transpilePackages: ['@flank/core', '@flank/pipeline'],
  // Linting runs once at the workspace root (`just lint`), not inside next build.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
