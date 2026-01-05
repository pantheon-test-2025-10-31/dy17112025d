import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // logging: {
  //   fetches: {
  //     fullUrl: true,
  //     hmrRefreshes: true,
  //   },
  // },
  // Use custom TypeScript cache handler for testing
  cacheHandler: path.resolve('./cache-handler.ts'),
  headers: async () => {
    return [
      {
        // Match all paths using wildcard
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
