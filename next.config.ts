import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // logging: {
  //   fetches: {
  //     fullUrl: true,
  //     hmrRefreshes: true,
  //   },
  // },
  // cacheHandler: path.resolve('./cacheHandler/file-cache-handler.ts'),
  cacheHandler: path.resolve('./cacheHandler/gcs-cache-handler.ts'),
  cacheMaxMemorySize: 0, // disable default in-memory caching
  headers: async () => {
    return [
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
