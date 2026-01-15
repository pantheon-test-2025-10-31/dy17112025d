export interface CacheClearResult {
  success: boolean;
  error?: string;
  statusCode?: number;
  duration?: number;
}

export default class EdgeCacheClear {
    private proxyUrl: string;

    constructor() {
        if (!process.env.OUTBOUND_PROXY_ENDPOINT) {
            throw new Error('OUTBOUND_PROXY_ENDPOINT environment variable is required for GCS cache handler');
        }
        this.proxyUrl = `http://${process.env.OUTBOUND_PROXY_ENDPOINT}/rest/v0alpha1/cache`;
    }

    async nukeCache(): Promise<CacheClearResult> {
        const startTime = Date.now();

        try {
            console.log(`[EdgeCacheClear] Attempting to clear edge cache via: ${this.proxyUrl}`);

            const response = await fetch(this.proxyUrl, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                },
                // Add timeout to prevent hanging
                signal: AbortSignal.timeout(10000) // 10 second timeout
            });

            const duration = Date.now() - startTime;

            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Unknown error');
                console.error(`[EdgeCacheClear] HTTP Error ${response.status}: ${errorText}`);

                return {
                    success: false,
                    error: `HTTP ${response.status}: ${errorText}`,
                    statusCode: response.status,
                    duration
                };
            }

            console.log(`[EdgeCacheClear] Successfully cleared edge cache in ${duration}ms`);

            return {
                success: true,
                statusCode: response.status,
                duration
            };

        } catch (error) {
            const duration = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            console.error(`[EdgeCacheClear] Failed to clear edge cache:`, error);

            return {
                success: false,
                error: errorMessage,
                duration
            };
        }
    }
}