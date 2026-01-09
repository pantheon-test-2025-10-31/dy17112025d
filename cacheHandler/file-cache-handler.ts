import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type {
  CacheData,
  CacheStats,
  FileSystemCacheContext,
  CacheHandlerParametersGet,
  CacheHandlerParametersSet,
  CacheHandlerParametersRevalidateTag,
  CacheHandlerValue,
  Revalidate,
} from './types';

import type { CacheHandler as NextCacheHandler } from './types';

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const mkdir = promisify(fs.mkdir);

export default class FileCacheHandler implements NextCacheHandler {
  private cacheDir: string;
  private cacheFile: string;

  constructor(context: FileSystemCacheContext) {
    console.log('[FileCacheHandler] Initializing file-based cache handler');

    // Create cache directory in project root/.next/cache-data
    this.cacheDir = path.join(process.cwd(), '.next', 'cache-data');
    this.cacheFile = path.join(this.cacheDir, 'cache.json');

    // Ensure cache directory exists
    this.ensureCacheDir();
  }

  private async ensureCacheDir(): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
    } catch (error) {
      // Directory might already exist, that's fine
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        console.error('[FileCacheHandler] Error creating cache directory:', error);
      }
    }
  }

  private async readCacheData(): Promise<CacheData> {
    try {
      const data = await readFile(this.cacheFile, 'utf-8');
      return JSON.parse(data) as CacheData;
    } catch (error) {
      // File doesn't exist or is invalid, return empty cache
      return {};
    }
  }

  private async writeCacheData(data: CacheData): Promise<void> {
    try {
      await this.ensureCacheDir();
      await writeFile(this.cacheFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.error('[FileCacheHandler] Error writing cache data:', error);
    }
  }

  async get(
    cacheKey: CacheHandlerParametersGet[0],
    ctx?: CacheHandlerParametersGet[1]
  ): Promise<CacheHandlerValue | null> {
    console.log(`[FileCacheHandler] GET: ${cacheKey}`);

    try {
      const cacheData = await this.readCacheData();
      const entry = cacheData[cacheKey];

      if (entry === undefined) {
        console.log(`[FileCacheHandler] MISS: ${cacheKey}`);
        return null;
      }

      console.log(`[FileCacheHandler] HIT: ${cacheKey}`, {
        entryType: typeof entry,
        hasValue: entry && typeof entry === 'object' && 'value' in entry
      });

      // Return the stored incrementalCacheValue (the inner value)
      // Since we're storing: { value: incrementalCacheValue, lastModified, tags }
      // We need to return just the value part for Next.js
      return entry;
    } catch (error) {
      console.error(`[FileCacheHandler] Error reading cache for key ${cacheKey}:`, error);
      return null;
    }
  }

  async set(
    cacheKey: CacheHandlerParametersSet[0],
    incrementalCacheValue: CacheHandlerParametersSet[1],
    ctx: CacheHandlerParametersSet[2] & {
      tags?: string[];
      revalidate?: Revalidate;
    }
  ): Promise<void> {
    console.log(`[FileCacheHandler] SET: ${cacheKey}`, {
      valueType: typeof incrementalCacheValue,
      hasKind: incrementalCacheValue && typeof incrementalCacheValue === 'object' && 'kind' in incrementalCacheValue
    });

    try {
      const cacheData = await this.readCacheData();

      const { tags = [] } = ctx;

      const cacheHandlerValue: CacheHandlerValue = {
        value: incrementalCacheValue,
        lastModified: Date.now(),
        tags: Object.freeze(tags)
      }

      // Store the incrementalCacheValue exactly as Next.js provides it
      // Next.js expects to get back exactly what it stored
      cacheData[cacheKey] = cacheHandlerValue;

      await this.writeCacheData(cacheData);

      const cacheSize = Object.keys(cacheData).length;
      console.log(`[FileCacheHandler] Cache size: ${cacheSize} entries`);
    } catch (error) {
      console.error(`[FileCacheHandler] Error setting cache for key ${cacheKey}:`, error);
    }
  }

  async revalidateTag(tag: CacheHandlerParametersRevalidateTag[0]): Promise<void> {
    console.log(`[FileCacheHandler] REVALIDATE TAG: ${tag}`);

    try {
      const tagArray = [tag].flat();
      const cacheData = await this.readCacheData();
      let deletedCount = 0;

      // Iterate over all entries in the cache
      for (const [key, entry] of Object.entries(cacheData)) {
        // Check if the entry has tags and matches the revalidation tag
        // Tags are now part of the Next.js cache value structure
        if (entry && typeof entry === 'object' && 'tags' in entry && Array.isArray(entry.tags)) {
          if (entry.tags.some((entryTag: string) => tagArray.includes(entryTag))) {
            delete cacheData[key];
            deletedCount++;
            console.log(`[FileCacheHandler] Deleted cache entry: ${key}`);
          }
        }
      }

      if (deletedCount > 0) {
        await this.writeCacheData(cacheData);
      }

      console.log(`[FileCacheHandler] Revalidated ${deletedCount} entries for tags: ${tagArray.join(', ')}`);
    } catch (error) {
      console.error('[FileCacheHandler] Error during revalidateTag:', error);
    }
  }

  resetRequestCache(): void {
    console.log(`[FileCacheHandler] RESET REQUEST CACHE: No-op for file-based cache`);
    // For file-based cache, this is typically a no-op since we're not maintaining
    // per-request caches. The file system is the source of truth.
  }
}

// Export a shared instance of the cache data access functions for the API
export async function getSharedCacheStats(): Promise<CacheStats> {
  const cacheFile = path.join(process.cwd(), '.next', 'cache-data', 'cache.json');

  try {
    const data = await readFile(cacheFile, 'utf-8');
    const cacheData = JSON.parse(data);
    const keys = Object.keys(cacheData);

    console.log(`[getSharedCacheStats] Found ${keys.length} cache entries`);

    return {
      size: keys.length,
      keys: keys
    };
  } catch (error) {
    console.log(`[getSharedCacheStats] Cache file not found or invalid:`, error);
    // File doesn't exist or is invalid
    return { size: 0, keys: [] };
  }
}

export async function clearSharedCache(): Promise<number> {
  const cacheFile = path.join(process.cwd(), '.next', 'cache-data', 'cache.json');

  try {
    const data = await readFile(cacheFile, 'utf-8');
    const cacheData = JSON.parse(data);
    const sizeBefore = Object.keys(cacheData).length;

    console.log(`[clearSharedCache] Clearing ${sizeBefore} cache entries`);

    await writeFile(cacheFile, JSON.stringify({}, null, 2), 'utf-8');

    return sizeBefore;
  } catch (error) {
    console.log(`[clearSharedCache] Cache file not found, nothing to clear:`, error);
    // File doesn't exist, nothing to clear
    return 0;
  }
}