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
  private baseDir: string;
  private fetchCacheDir: string;
  private routeCacheDir: string;
  private buildMetaFile: string;

  constructor(context: FileSystemCacheContext) {
    console.log('[FileCacheHandler] Initializing file-based cache handler');
    console.log('CACHE BUCKET: ', process.env.CACHE_BUCKET || "NOT FOUND", "***")

    // Create separate cache directories for different cache types
    this.baseDir = path.join(process.cwd(), '.next', 'cache');
    this.fetchCacheDir = path.join(this.baseDir, 'fetch-cache');
    this.routeCacheDir = path.join(this.baseDir, 'route-cache');
    this.buildMetaFile = path.join(this.baseDir, 'build-meta.json');

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

      // Compare only by minute to avoid multiple resets during the same build
      const currentBuildMinute = Math.floor(currentBuildTime / (60 * 1000));
      const cachedBuildMinute = Math.floor(buildMeta.timestamp / (60 * 1000));

      if (cachedBuildMinute < currentBuildMinute) {
        console.log(`[FileCacheHandler] New build detected based on server directory modification time.`);
        console.log(`  Cache minute: ${new Date(buildMeta.timestamp).toISOString()}`);
        console.log(`  Server dir minute: ${new Date(currentBuildTime).toISOString()}`);

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
        console.log(`[FileCacheHandler] Same build minute detected - keeping existing cache`);
        console.log(`  Cache minute: ${new Date(buildMeta.timestamp).toISOString()}`);
        console.log(`  Server dir minute: ${new Date(currentBuildTime).toISOString()}`);
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
      let routeEntriesCleared = 0;
      let dataEntriesPreserved = 0;

      // Clear entire route cache directory (preserve fetch cache)
      try {
        const files = await fs.promises.readdir(this.routeCacheDir);
        routeEntriesCleared = files.length;

        // Remove the entire directory and recreate it
        await fs.promises.rm(this.routeCacheDir, { recursive: true, force: true });
        await fs.promises.mkdir(this.routeCacheDir, { recursive: true });
      } catch (error) {
        // Directory might not exist, that's fine
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[FileCacheHandler] Error clearing route cache:', error);
        }
      }

      // Count preserved fetch cache entries
      try {
        const fetchFiles = await fs.promises.readdir(this.fetchCacheDir);
        dataEntriesPreserved = fetchFiles.length;
      } catch (error) {
        // Directory might not exist, that's fine
      }

      console.log(`[FileCacheHandler] Route cache invalidation complete:`);
      console.log(`  - ${routeEntriesCleared} route cache entries cleared`);
      console.log(`  - ${dataEntriesPreserved} data cache entries preserved`);
    } catch (error) {
      console.log('[FileCacheHandler] Error during route cache invalidation:', error);
    }
  }

  private async ensureCacheDir(): Promise<void> {
    try {
      await mkdir(this.fetchCacheDir, { recursive: true });
      await mkdir(this.routeCacheDir, { recursive: true });
    } catch (error) {
      // Directory might already exist, that's fine
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        console.error('[FileCacheHandler] Error creating cache directories:', error);
      }
    }
  }

  private getCacheFilePath(cacheKey: string, cacheType: 'fetch' | 'route'): string {
    // Create a safe filename from the cache key
    const safeKey = cacheKey.replace(/[^a-zA-Z0-9-]/g, '_');
    const dir = cacheType === 'fetch' ? this.fetchCacheDir : this.routeCacheDir;
    return path.join(dir, `${safeKey}.json`);
  }

  private async readCacheEntry(cacheKey: string, cacheType: 'fetch' | 'route'): Promise<CacheHandlerValue | null> {
    try {
      const filePath = this.getCacheFilePath(cacheKey, cacheType);
      const data = await readFile(filePath, 'utf-8');
      const parsedData = JSON.parse(data);
      // Deserialize any Buffer data that was stored as base64
      return this.deserializeFromStorage({ [cacheKey]: parsedData })[cacheKey] || null;
    } catch (error) {
      // File doesn't exist or is invalid
      return null;
    }
  }

  private async writeCacheEntry(cacheKey: string, cacheValue: CacheHandlerValue, cacheType: 'fetch' | 'route'): Promise<void> {
    try {
      await this.ensureCacheDir();
      const filePath = this.getCacheFilePath(cacheKey, cacheType);
      // Convert Buffers to base64 strings for JSON serialization
      const serializedData = this.serializeForStorage({ [cacheKey]: cacheValue });
      await writeFile(filePath, JSON.stringify(serializedData[cacheKey], null, 2), 'utf-8');
    } catch (error) {
      console.error(`[FileCacheHandler] Error writing cache entry ${cacheKey}:`, error);
    }
  }

  private async deleteCacheEntry(cacheKey: string, cacheType: 'fetch' | 'route'): Promise<void> {
    try {
      const filePath = this.getCacheFilePath(cacheKey, cacheType);
      await fs.promises.unlink(filePath);
    } catch (error) {
      // File might not exist, that's fine
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[FileCacheHandler] Error deleting cache entry ${cacheKey}:`, error);
      }
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
      // Determine cache type based on context
      const cacheType = this.determineCacheType(ctx);
      const entry = await this.readCacheEntry(cacheKey, cacheType);

      if (!entry) {
        console.log(`[FileCacheHandler] MISS: ${cacheKey} (${cacheType})`);
        return null;
      }

      console.log(`[FileCacheHandler] HIT: ${cacheKey} (${cacheType})`, {
        entryType: typeof entry,
        hasValue: entry && typeof entry === 'object' && 'value' in entry
      });

      return entry;
    } catch (error) {
      console.error(`[FileCacheHandler] Error reading cache for key ${cacheKey}:`, error);
      return null;
    }
  }

  private determineCacheType(ctx?: CacheHandlerParametersGet[1]): 'fetch' | 'route' {
    if (!ctx) {
      return 'route'; // Default to route cache if no context
    }

    // Check for fetch cache indicators
    if ('fetchCache' in ctx && ctx.fetchCache === true) {
      return 'fetch';
    }

    if ('fetchUrl' in ctx) {
      return 'fetch';
    }

    if ('fetchIdx' in ctx) {
      return 'fetch';
    }

    // Default to route cache for page/route caches
    return 'route';
  }

  async set(
    cacheKey: CacheHandlerParametersSet[0],
    incrementalCacheValue: CacheHandlerParametersSet[1],
    ctx: CacheHandlerParametersSet[2] & {
      tags?: string[];
      revalidate?: Revalidate;
    }
  ): Promise<void> {
    // Determine cache type based on the value kind
    const cacheType = incrementalCacheValue && typeof incrementalCacheValue === 'object' && 'kind' in incrementalCacheValue && incrementalCacheValue.kind === 'FETCH' ? 'fetch' : 'route';

    console.log(`[FileCacheHandler] SET: ${cacheKey} (${cacheType})`, {
      valueType: typeof incrementalCacheValue,
      hasKind: incrementalCacheValue && typeof incrementalCacheValue === 'object' && 'kind' in incrementalCacheValue
    });

    try {
      const { tags = [] } = ctx;

      const cacheHandlerValue: CacheHandlerValue = {
        value: incrementalCacheValue,
        lastModified: Date.now(),
        tags: Object.freeze(tags)
      }

      // Store the incrementalCacheValue exactly as Next.js provides it
      // Next.js expects to get back exactly what it stored
      await this.writeCacheEntry(cacheKey, cacheHandlerValue, cacheType);

      console.log(`[FileCacheHandler] Cached ${cacheKey} in ${cacheType} cache`);
    } catch (error) {
      console.error(`[FileCacheHandler] Error setting cache for key ${cacheKey}:`, error);
    }
  }

  async revalidateTag(tag: CacheHandlerParametersRevalidateTag[0]): Promise<void> {
    console.log(`[FileCacheHandler] REVALIDATE TAG: ${tag}`);

    try {
      const tagArray = [tag].flat();
      let deletedCount = 0;

      // Check both cache directories
      for (const cacheType of ['fetch', 'route'] as const) {
        const cacheDir = cacheType === 'fetch' ? this.fetchCacheDir : this.routeCacheDir;

        try {
          const files = await fs.promises.readdir(cacheDir);

          for (const file of files) {
            if (!file.endsWith('.json')) continue;

            const filePath = path.join(cacheDir, file);
            const cacheKey = file.replace('.json', '').replace(/_/g, '-'); // Reverse safe key transformation

            try {
              const entry = await this.readCacheEntry(cacheKey, cacheType);

              if (entry && entry.tags && Array.isArray(entry.tags)) {
                if (entry.tags.some((entryTag: string) => tagArray.includes(entryTag))) {
                  await this.deleteCacheEntry(cacheKey, cacheType);
                  deletedCount++;
                  console.log(`[FileCacheHandler] Deleted cache entry: ${cacheKey} (${cacheType})`);
                }
              }
            } catch (error) {
              console.warn(`[FileCacheHandler] Error reading cache file ${file}:`, error);
            }
          }
        } catch (error) {
          // Directory might not exist, that's fine
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn(`[FileCacheHandler] Error reading ${cacheType} cache directory:`, error);
          }
        }
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
  const fetchCacheDir = path.join(process.cwd(), '.next', 'cache', 'fetch-cache');
  const routeCacheDir = path.join(process.cwd(), '.next', 'cache', 'route-cache');

  const keys: string[] = [];

  try {
    // Count fetch cache files
    try {
      const fetchFiles = await fs.promises.readdir(fetchCacheDir);
      const fetchKeys = fetchFiles
        .filter(file => file.endsWith('.json'))
        .map(file => `fetch:${file.replace('.json', '').replace(/_/g, '-')}`);
      keys.push(...fetchKeys);
    } catch (error) {
      // Directory might not exist
    }

    // Count route cache files
    try {
      const routeFiles = await fs.promises.readdir(routeCacheDir);
      const routeKeys = routeFiles
        .filter(file => file.endsWith('.json'))
        .map(file => `route:${file.replace('.json', '').replace(/_/g, '-')}`);
      keys.push(...routeKeys);
    } catch (error) {
      // Directory might not exist
    }

    console.log(`[getSharedCacheStats] Found ${keys.length} cache entries (${keys.filter(k => k.startsWith('fetch:')).length} fetch, ${keys.filter(k => k.startsWith('route:')).length} route)`);

    return {
      size: keys.length,
      keys: keys
    };
  } catch (error) {
    console.log(`[getSharedCacheStats] Error reading cache directories:`, error);
    return { size: 0, keys: [] };
  }
}

export async function clearSharedCache(): Promise<number> {
  const fetchCacheDir = path.join(process.cwd(), '.next', 'cache', 'fetch-cache');
  const routeCacheDir = path.join(process.cwd(), '.next', 'cache', 'route-cache');

  let sizeBefore = 0;

  try {
    // Clear fetch cache
    try {
      const fetchFiles = await fs.promises.readdir(fetchCacheDir);
      const jsonFiles = fetchFiles.filter(file => file.endsWith('.json'));
      sizeBefore += jsonFiles.length;

      for (const file of jsonFiles) {
        await fs.promises.unlink(path.join(fetchCacheDir, file));
      }

      console.log(`[clearSharedCache] Cleared ${jsonFiles.length} fetch cache entries`);
    } catch (error) {
      // Directory might not exist
    }

    // Clear route cache
    try {
      const routeFiles = await fs.promises.readdir(routeCacheDir);
      const jsonFiles = routeFiles.filter(file => file.endsWith('.json'));
      sizeBefore += jsonFiles.length;

      for (const file of jsonFiles) {
        await fs.promises.unlink(path.join(routeCacheDir, file));
      }

      console.log(`[clearSharedCache] Cleared ${jsonFiles.length} route cache entries`);
    } catch (error) {
      // Directory might not exist
    }

    console.log(`[clearSharedCache] Total cleared: ${sizeBefore} cache entries`);
    return sizeBefore;
  } catch (error) {
    console.log(`[clearSharedCache] Error clearing cache directories:`, error);
    return 0;
  }
}