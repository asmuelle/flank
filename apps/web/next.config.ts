import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages export TypeScript sources directly.
  transpilePackages: ['@flank/core', '@flank/db', '@flank/pipeline'],
  // Allow loading the dev server over the LAN (e.g. testing on a phone) without
  // tripping Next's cross-origin dev-resource guard.
  allowedDevOrigins: ['192.168.0.86'],
  // next 16 removed the built-in `eslint` build integration; linting runs at the workspace root
  // (`just lint`) instead, so there is nothing to configure here.

  // Baseline security headers on every response. Deliberately conservative: clickjacking, MIME
  // sniffing, referrer leakage, and (in production) transport downgrade. A full nonce-based CSP is
  // a follow-up — it needs per-surface testing against the OIDC redirect + Inngest routes.
  async headers() {
    const securityHeaders = [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ];
    if (process.env.NODE_ENV === 'production') {
      securityHeaders.push({
        key: 'Strict-Transport-Security',
        value: 'max-age=31536000; includeSubDomains; preload',
      });
    }
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
