import { NextRequest, NextResponse } from 'next/server';

/**
 * Basic middleware for request interception and header manipulation.
 *
 * WARNING: Middleware is INCOMPATIBLE with NEXT_PRIVATE_MINIMAL_MODE=1.
 * When minimal mode is enabled, any route intercepted by middleware will
 * return an empty response. This is a Next.js limitation.
 *
 * If using minimal mode, disable the matcher below or delete this file.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  console.log(`[Middleware] ${request.method} ${pathname}`);

  const response = NextResponse.next();

  // Add headers to track middleware execution (useful for debugging)
  response.headers.set('x-middleware-executed', 'true');
  response.headers.set('x-intercepted-path', pathname);

  return response;
}

// Middleware matcher configuration
//
// IMPORTANT: Middleware breaks ALL routes in minimal mode (NEXT_PRIVATE_MINIMAL_MODE=1).
// Only enable middleware when NOT using minimal mode.
export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - Public assets (images)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.jpeg|.*\\.gif|.*\\.svg|.*\\.ico).*)',
  ],
};
