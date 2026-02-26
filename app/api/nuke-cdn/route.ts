import { NextResponse } from 'next/server';

const OUTBOUND_PROXY_ENDPOINT = process.env.OUTBOUND_PROXY_ENDPOINT || 'localhost:8000';

export async function POST() {
  const url = `http://${OUTBOUND_PROXY_ENDPOINT}/rest/v0alpha1/cache`;

  console.log(`[API] /api/nuke-cdn - Nuking CDN cache via: ${url}`);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const responseText = await response.text().catch(() => '');

    console.log(`[API] /api/nuke-cdn - Response: ${response.status} ${responseText}`);

    if (!response.ok) {
      return NextResponse.json({
        success: false,
        error: `HTTP ${response.status}: ${responseText}`,
        endpoint: url,
      }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: 'CDN cache nuked successfully',
      status: response.status,
      nuked_at: new Date().toISOString(),
    });

  } catch (error) {
    console.error('[API] /api/nuke-cdn - Error:', error);

    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      endpoint: url,
    }, { status: 500 });
  }
}

// GET method for easier testing
export async function GET() {
  return NextResponse.json({
    message: 'Use POST method to nuke CDN cache',
    endpoint: '/api/nuke-cdn',
    method: 'POST',
  });
}
