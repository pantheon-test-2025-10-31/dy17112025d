import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // logging: {
  //   fetches: {
  //     fullUrl: true,
  //     hmrRefreshes: true,
  //   },
  // },
  // Use custom file-based cache handler for testing
  cacheHandler: path.resolve('./cacheHandler/file-cache-handler.ts'),
  cacheMaxMemorySize: 0, // disable default in-memory caching
  headers: async () => {
    return [
      {
        // Match all API routes - prevent CDN caching
        source: '/api/(.*)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'private, no-cache, no-store, must-revalidate',
          },
          {
            key: 'Pragma',
            value: 'no-cache',
          },
          {
            key: 'Expires',
            value: '0',
          },
        ],
      },
      {
        // Match all paths using wildcard (excluding API, static assets)
        source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
        headers: [
          {
            key: 'Surrogate-Key',
            value: 'unknown',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
