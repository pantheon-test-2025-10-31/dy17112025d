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

// Global singleton to track if build invalidation has been checked for this process
let buildInvalidationChecked = false;

export default class FileCacheHandler implements NextCacheHandler {
  private cacheDir: string;
  private cacheFile: string;
  private buildMetaFile: string;

  constructor(context: FileSystemCacheContext) {
    console.log('[FileCacheHandler] Initializing file-based cache handler');
    console.log('CACHE BUCKET: ', process.env.CACHE_BUCKET || "NOT FOUND", "***")

    // Create cache directory in project root/.next/cache-data
    this.cacheDir = path.join(process.cwd(), '.next', 'cache-data');
    this.cacheFile = path.join(this.cacheDir, 'cache.json');
    this.buildMetaFile = path.join(this.cacheDir, 'build-meta.json');

    // Ensure cache directory exists
    this.ensureCacheDir();

    // Only check build invalidation once per process
    if (!buildInvalidationChecked) {
      this.checkBuildInvalidation();
      buildInvalidationChecked = true;
    }
  }

  private getServerDirModificationTime(): number {
    try {
      // Check when the .next/server directory was last modified
      // This changes on each build
      const serverDir = path.join(process.cwd(), '.next', 'server');
      const stats = fs.statSync(serverDir);
      return stats.mtime.getTime();
    } catch (error) {
      console.log('[FileCacheHandler] Could not get server dir mtime:', error);
      return Date.now();
    }
  }

  private async checkBuildInvalidation(): Promise<void> {
    try {
      const currentBuildTime = this.getServerDirModificationTime();
      const buildMeta = await this.readBuildMeta();

      if (buildMeta.timestamp < currentBuildTime) {
        console.log(`[FileCacheHandler] New build detected based on server directory modification time.`);
        console.log(`  Cache timestamp: ${new Date(buildMeta.timestamp).toISOString()}`);
        console.log(`  Server dir modified: ${new Date(currentBuildTime).toISOString()}`);

        // Clear ONLY Full Route Cache (APP_PAGE, APP_ROUTE, PAGES)
        // Preserve Data Cache (FETCH) as per Next.js behavior
        await this.invalidateRouteCache();

        // Update build metadata with current server directory modification time
        await this.writeBuildMeta({
          buildId: `build-${currentBuildTime}`, // Keep for compatibility but use timestamp as ID
          timestamp: currentBuildTime
        });

        console.log('[FileCacheHandler] Full Route Cache invalidated, Data Cache preserved');
      } else {
        console.log(`[FileCacheHandler] No new build detected - keeping existing cache`);
        console.log(`  Cache timestamp: ${new Date(buildMeta.timestamp).toISOString()}`);
        console.log(`  Server dir modified: ${new Date(currentBuildTime).toISOString()}`);
      }
    } catch (error) {
      console.log('[FileCacheHandler] No previous build metadata found, starting fresh');
      const currentBuildTime = this.getServerDirModificationTime();
      await this.writeBuildMeta({
        buildId: `build-${currentBuildTime}`,
        timestamp: currentBuildTime
      });
    }
  }

  private async readBuildMeta(): Promise<{ buildId: string; timestamp: number }> {
    const data = await readFile(this.buildMetaFile, 'utf-8');
    return JSON.parse(data);
  }

  private async writeBuildMeta(meta: { buildId: string; timestamp: number }): Promise<void> {
    await this.ensureCacheDir();
    await writeFile(this.buildMetaFile, JSON.stringify(meta), 'utf-8');
  }

  private async invalidateRouteCache(): Promise<void> {
    try {
      const cacheData = await this.readCacheData();
      const preserved: CacheData = {};
      let routeEntriesCleared = 0;
      let dataEntriesPreserved = 0;

      // Only clear Full Route Cache entries (APP_PAGE, APP_ROUTE, PAGES)
      // Preserve Data Cache entries (FETCH)
      for (const [key, entry] of Object.entries(cacheData)) {
        if (entry && typeof entry === 'object' && 'value' in entry) {
          const value = entry.value;

          // Preserve FETCH cache entries (Data Cache)
          if (value && typeof value === 'object' && value.kind === 'FETCH') {
            preserved[key] = entry;
            dataEntriesPreserved++;
          } else {
            // Clear route cache entries (APP_PAGE, APP_ROUTE, PAGES, etc.)
            routeEntriesCleared++;
          }
        }
      }

      await this.writeCacheData(preserved);

      console.log(`[FileCacheHandler] Route cache invalidation complete:`);
      console.log(`  - ${routeEntriesCleared} route cache entries cleared`);
      console.log(`  - ${dataEntriesPreserved} data cache entries preserved`);
    } catch (error) {
      console.log('[FileCacheHandler] Error during route cache invalidation:', error);
    }
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
      const parsedData = JSON.parse(data);
      // Deserialize any Buffer data that was stored as base64
      return this.deserializeFromStorage(parsedData);
    } catch (error) {
      // File doesn't exist or is invalid, return empty cache
      return {};
    }
  }

  private async writeCacheData(data: CacheData): Promise<void> {
    try {
      await this.ensureCacheDir();
      // Convert Buffers to base64 strings for JSON serialization
      const serializedData = this.serializeForStorage(data);
      await writeFile(this.cacheFile, JSON.stringify(serializedData, null, 2), 'utf-8');
    } catch (error) {
      console.error('[FileCacheHandler] Error writing cache data:', error);
    }
  }

  private serializeForStorage(data: CacheData): any {
    const serialized: any = {};

    for (const [key, entry] of Object.entries(data)) {
      if (entry && typeof entry === 'object' && 'value' in entry) {
        const value = entry.value;

        // Handle Next.js 15 buffer serialization requirements
        if (value && typeof value === 'object') {
          const serializedValue = { ...value };

          // Convert body Buffer to base64 string for storage
          if (serializedValue.body && Buffer.isBuffer(serializedValue.body)) {
            serializedValue.body = {
              type: 'Buffer',
              data: serializedValue.body.toString('base64')
            };
          }

          // Handle rscData if it's a Buffer
          if (serializedValue.rscData && Buffer.isBuffer(serializedValue.rscData)) {
            serializedValue.rscData = {
              type: 'Buffer',
              data: serializedValue.rscData.toString('base64')
            };
          }

          // Handle segmentData if it's a Map with Buffers
          if (serializedValue.segmentData && serializedValue.segmentData instanceof Map) {
            const segmentObj: any = {};
            for (const [segKey, segValue] of serializedValue.segmentData.entries()) {
              if (Buffer.isBuffer(segValue)) {
                segmentObj[segKey] = {
                  type: 'Buffer',
                  data: segValue.toString('base64')
                };
              } else {
                segmentObj[segKey] = segValue;
              }
            }
            serializedValue.segmentData = {
              type: 'Map',
              data: segmentObj
            };
          }

          serialized[key] = {
            ...entry,
            value: serializedValue
          };
        } else {
          serialized[key] = entry;
        }
      } else {
        serialized[key] = entry;
      }
    }

    return serialized;
  }

  private deserializeFromStorage(data: any): CacheData {
    const deserialized: CacheData = {};

    for (const [key, entry] of Object.entries(data)) {
      if (entry && typeof entry === 'object' && 'value' in entry) {
        const value = (entry as any).value;

        if (value && typeof value === 'object') {
          const deserializedValue = { ...value };

          // Convert base64 string back to Buffer for body
          if (deserializedValue.body &&
            typeof deserializedValue.body === 'object' &&
            deserializedValue.body.type === 'Buffer') {
            deserializedValue.body = Buffer.from(deserializedValue.body.data, 'base64');
          }

          // Convert base64 string back to Buffer for rscData
          if (deserializedValue.rscData &&
            typeof deserializedValue.rscData === 'object' &&
            deserializedValue.rscData.type === 'Buffer') {
            deserializedValue.rscData = Buffer.from(deserializedValue.rscData.data, 'base64');
          }

          // Convert serialized Map back to Map with Buffers
          if (deserializedValue.segmentData &&
            typeof deserializedValue.segmentData === 'object' &&
            deserializedValue.segmentData.type === 'Map') {
            const segmentMap = new Map();
            for (const [segKey, segValue] of Object.entries(deserializedValue.segmentData.data)) {
              if (segValue && typeof segValue === 'object' && (segValue as any).type === 'Buffer') {
                segmentMap.set(segKey, Buffer.from((segValue as any).data, 'base64'));
              } else {
                segmentMap.set(segKey, segValue);
              }
            }
            deserializedValue.segmentData = segmentMap;
          }

          deserialized[key] = {
            ...(entry as any),
            value: deserializedValue
          };
        } else {
          deserialized[key] = entry as any;
        }
      } else {
        deserialized[key] = entry as any;
      }
    }

    return deserialized;
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