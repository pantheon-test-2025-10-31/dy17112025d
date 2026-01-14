import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // logging: {
  //   fetches: {
  //     fullUrl: true,
  //     hmrRefreshes: true,
  //   },
  // },
  // Use environment-specific cache handler: file-based for dev, GCS for prod
  // cacheHandler: path.resolve(
  //   process.env.NODE_ENV === 'production'
  //     ? './cacheHandler/gcs-cache-handler.ts'
  //     : './cacheHandler/file-cache-handler.ts'
  // ),
  cacheHandler: path.resolve('./cacheHandler/gcs-cache-handler.ts'),
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
