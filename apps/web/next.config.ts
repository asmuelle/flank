import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages export TypeScript sources directly.
  transpilePackages: ['@flank/core', '@flank/db', '@flank/pipeline'],
  // next 16 removed the built-in `eslint` build integration; linting runs at the workspace root
  // (`just lint`) instead, so there is nothing to configure here.
};

export default nextConfig;
