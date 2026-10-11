import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  // Do not write a generated AGENTS.md into the repo on `next dev`.
  agentRules: false,
  // Server-only native/binary packages must not be bundled by Turbopack/webpack.
  serverExternalPackages: ['postgres', 'jszip', 'mammoth', '@google/genai', '@google-cloud/storage'],
  experimental: {
    serverActions: { bodySizeLimit: '2mb' },
    // Keep the client from treating every force-dynamic page as instantly
    // stale. A 0s stale time refetches the RSC tree on each client fetch and
    // Turbopack logs that as a compile loop.
    staleTimes: { dynamic: 60, static: 180 },
  },
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    },
  ],
};

export default config;
