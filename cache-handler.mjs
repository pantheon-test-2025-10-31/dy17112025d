// Cache handler configuration using @pantheon-systems/nextjs-cache-handler
import { createCacheHandler } from 'nextjs-cache-handler-test-dy-2';

const CacheHandler = createCacheHandler({
  type: 'auto', // Auto-detect: GCS if CACHE_BUCKET is set, otherwise file-based
});

export default CacheHandler;
