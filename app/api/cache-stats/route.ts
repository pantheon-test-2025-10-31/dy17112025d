import { NextRequest, NextResponse } from 'next/server';
import { getSharedCacheStats } from '../../../cacheHandler/file-cache-handler';

export async function GET(request: NextRequest) {
  try {
    // Access the shared file-based cache directly
    const stats = await getSharedCacheStats();

    console.log(`[API] Cache stats - Size: ${stats.size}, Keys:`, stats.keys);

    return NextResponse.json({
      message: 'Simple cache handler statistics',
      timestamp: new Date().toISOString(),
      cache_stats: {
        size: stats.size,
        entries: stats.keys.map((key: string) => ({ key }))
      },
      info: {
        handler_type: 'File-based Cache Handler',
        description: 'JSON file-based cache handler for persistent storage across Next.js instances'
      }
    }, {
      headers: {
        'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
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
    // Access the shared file-based cache directly
    const { clearSharedCache } = await import('../../../cacheHandler/file-cache-handler');
    const sizeBefore = await clearSharedCache();

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