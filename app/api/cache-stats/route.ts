import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    // Import the shared cache directly instead of creating a new instance
    const { cache } = require('../../../cache-handler.ts');

    const stats = {
      size: cache.size,
      keys: Array.from(cache.keys())
    };

    console.log(`[API] Cache stats - Size: ${cache.size}, Keys:`, stats.keys);

    return NextResponse.json({
      message: 'Simple cache handler statistics',
      timestamp: new Date().toISOString(),
      cache_stats: {
        size: stats.size,
        entries: stats.keys.map((key: string) => ({ key }))
      },
      info: {
        handler_type: 'Simple Map-based Cache Handler',
        description: 'Basic cache handler following Next.js 15 documentation'
      }
    });

  } catch (error) {
    console.error('[API] /api/cache-stats - Error:', error);

    return NextResponse.json({
      error: 'Failed to retrieve cache statistics',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // Access the shared cache directly
    const { cache } = require('../../../cache-handler.ts');

    const sizeBefore = cache.size;
    cache.clear();

    console.log(`[API] Cache cleared - removed ${sizeBefore} entries`);

    return NextResponse.json({
      message: 'Cache cleared successfully',
      timestamp: new Date().toISOString(),
      cleared_entries: sizeBefore
    });

  } catch (error) {
    console.error('[API] /api/cache-stats - Clear cache error:', error);

    return NextResponse.json({
      error: 'Failed to clear cache',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }, { status: 500 });
  }
}