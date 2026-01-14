import type {
  CacheData,
  CacheStats,
  CacheEntryInfo,
  CacheHandlerParametersGet,
  CacheHandlerParametersSet,
  CacheHandlerParametersRevalidateTag,
  CacheHandlerValue,
  Revalidate,
  SerializedCacheData,
  SerializedBuffer,
  SerializedMap,
  SerializableValue,
} from './types';

import type { CacheHandler as NextCacheHandler } from './types';

import { Bucket, Storage } from '@google-cloud/storage';
import * as fs from 'fs';
import * as path from 'path';

// Global singleton to track if build invalidation has been checked for this process
let buildInvalidationChecked = false;

export default class GcsCacheHandler implements NextCacheHandler {
  private bucket: Bucket;
  private fetchCachePrefix: string;
  private routeCachePrefix: string;
  private buildMetaKey: string;
  private tagsPrefix: string;
  private tagsMapKey: string;

  constructor(context: any) {
    console.log('[GcsCacheHandler] Initializing GCS-based cache handler');

    const bucketName = process.env.CACHE_BUCKET;
    if (!bucketName) {
      throw new Error('CACHE_BUCKET environment variable is required for GCS cache handler');
    }

    console.log('CACHE BUCKET:', bucketName);

    // Initialize GCS storage
    const storage = new Storage();
    this.bucket = storage.bucket(bucketName);

    // Create separate cache prefixes for different cache types
    this.fetchCachePrefix = 'fetch-cache/';
    this.routeCachePrefix = 'route-cache/';
    this.buildMetaKey = 'build-meta.json';
    this.tagsPrefix = 'cache/tags/';
    this.tagsMapKey = `${this.tagsPrefix}tags.json`;

    // Initialize tags mapping file (don't await to avoid blocking constructor)
    this.initializeTagsMapping().catch(error => {
      console.error('[GcsCacheHandler] Failed to initialize tags mapping:', error);
    });

    // Only check build invalidation once per process
    if (!buildInvalidationChecked) {
      this.checkBuildInvalidation();
      buildInvalidationChecked = true;
    }
  }

  private async initializeTagsMapping(): Promise<void> {
    try {
      const file = this.bucket.file(this.tagsMapKey);
      const [exists] = await file.exists();

      if (!exists) {
        console.log('[GcsCacheHandler] Creating initial tags mapping file');
        const emptyTagsMapping = {};
        await file.save(JSON.stringify(emptyTagsMapping), {
          metadata: {
            contentType: 'application/json',
          },
        });
      } else {
        console.log('[GcsCacheHandler] Tags mapping file already exists');
      }
    } catch (error) {
      console.error('[GcsCacheHandler] Error initializing tags mapping:', error);
    }
  }

  private async readTagsMapping(): Promise<Record<string, string[]>> {
    try {
      const file = this.bucket.file(this.tagsMapKey);
      const [exists] = await file.exists();

      if (!exists) {
        return {};
      }

      const [data] = await file.download();
      return JSON.parse(data.toString());
    } catch (error) {
      console.warn('[GcsCacheHandler] Error reading tags mapping:', error);
      return {};
    }
  }

  private async writeTagsMapping(tagsMapping: Record<string, string[]>): Promise<void> {
    try {
      const file = this.bucket.file(this.tagsMapKey);
      await file.save(JSON.stringify(tagsMapping, null, 2), {
        metadata: {
          contentType: 'application/json',
        },
      });
    } catch (error) {
      console.error('[GcsCacheHandler] Error writing tags mapping:', error);
    }
  }

  private async updateTagsMapping(cacheKey: string, tags: string[], isDelete = false): Promise<void> {
    try {
      const tagsMapping = await this.readTagsMapping();

      if (isDelete) {
        // Remove the cache key from all tag mappings
        for (const tag of Object.keys(tagsMapping)) {
          tagsMapping[tag] = tagsMapping[tag].filter(key => key !== cacheKey);
          // Remove empty tag entries
          if (tagsMapping[tag].length === 0) {
            delete tagsMapping[tag];
          }
        }
      } else {
        // Add the cache key to each tag mapping
        for (const tag of tags) {
          if (!tagsMapping[tag]) {
            tagsMapping[tag] = [];
          }
          // Add cache key if not already present
          if (!tagsMapping[tag].includes(cacheKey)) {
            tagsMapping[tag].push(cacheKey);
          }
        }
      }

      await this.writeTagsMapping(tagsMapping);
    } catch (error) {
      console.error('[GcsCacheHandler] Error updating tags mapping:', error);
    }
  }

  private async updateTagsMappingBulkDelete(cacheKeysToDelete: string[]): Promise<void> {
    try {
      const tagsMapping = await this.readTagsMapping();

      // Remove all deleted cache keys from all tag mappings
      for (const tag of Object.keys(tagsMapping)) {
        tagsMapping[tag] = tagsMapping[tag].filter(key => !cacheKeysToDelete.includes(key));
        // Remove empty tag entries
        if (tagsMapping[tag].length === 0) {
          delete tagsMapping[tag];
        }
      }

      await this.writeTagsMapping(tagsMapping);
    } catch (error) {
      console.error('[GcsCacheHandler] Error bulk updating tags mapping:', error);
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
      console.log('[GcsCacheHandler] Could not get server dir mtime:', error);
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
        console.log(`[GcsCacheHandler] New build detected based on server directory modification time.`);
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

        console.log('[GcsCacheHandler] Full Route Cache invalidated, Data Cache preserved');
      } else {
        console.log(`[GcsCacheHandler] Same build minute detected - keeping existing cache`);
        console.log(`  Cache minute: ${new Date(buildMeta.timestamp).toISOString()}`);
        console.log(`  Server dir minute: ${new Date(currentBuildTime).toISOString()}`);
      }
    } catch (error) {
      console.log('[GcsCacheHandler] No previous build metadata found, starting fresh');
      const currentBuildTime = this.getServerDirModificationTime();
      await this.writeBuildMeta({
        buildId: `build-${currentBuildTime}`,
        timestamp: currentBuildTime
      });
    }
  }

  private async readBuildMeta(): Promise<{ buildId: string; timestamp: number }> {
    const file = this.bucket.file(this.buildMetaKey);
    const [data] = await file.download();
    return JSON.parse(data.toString());
  }

  private async writeBuildMeta(meta: { buildId: string; timestamp: number }): Promise<void> {
    const file = this.bucket.file(this.buildMetaKey);
    await file.save(JSON.stringify(meta), {
      metadata: {
        contentType: 'application/json',
      },
    });
  }

  private async invalidateRouteCache(): Promise<void> {
    try {
      let routeEntriesCleared = 0;
      let dataEntriesPreserved = 0;

      // Clear entire route cache (preserve fetch cache)
      try {
        const [files] = await this.bucket.getFiles({ prefix: this.routeCachePrefix });
        routeEntriesCleared = files.length;

        // Delete all route cache files
        const deletePromises = files.map(file => file.delete());
        await Promise.all(deletePromises);
      } catch (error) {
        console.warn('[GcsCacheHandler] Error clearing route cache:', error);
      }

      // Count preserved fetch cache entries
      try {
        const [fetchFiles] = await this.bucket.getFiles({ prefix: this.fetchCachePrefix });
        dataEntriesPreserved = fetchFiles.length;
      } catch (error) {
        // Error getting fetch files, that's fine
      }

      console.log(`[GcsCacheHandler] Route cache invalidation complete:`);
      console.log(`  - ${routeEntriesCleared} route cache entries cleared`);
      console.log(`  - ${dataEntriesPreserved} data cache entries preserved`);
    } catch (error) {
      console.log('[GcsCacheHandler] Error during route cache invalidation:', error);
    }
  }

  private getCacheKey(cacheKey: string, cacheType: 'fetch' | 'route'): string {
    // Create a safe filename from the cache key
    const safeKey = cacheKey.replace(/[^a-zA-Z0-9-]/g, '_');
    const prefix = cacheType === 'fetch' ? this.fetchCachePrefix : this.routeCachePrefix;
    return `${prefix}${safeKey}.json`;
  }

  private async readCacheEntry(cacheKey: string, cacheType: 'fetch' | 'route'): Promise<CacheHandlerValue | null> {
    try {
      const gcsKey = this.getCacheKey(cacheKey, cacheType);
      const file = this.bucket.file(gcsKey);

      const [exists] = await file.exists();
      if (!exists) {
        return null;
      }

      const [data] = await file.download();
      const parsedData = JSON.parse(data.toString());

      // Deserialize any Buffer data that was stored as base64
      return this.deserializeFromStorage({ [cacheKey]: parsedData })[cacheKey] || null;
    } catch (error) {
      // File doesn't exist or is invalid
      return null;
    }
  }

  private async writeCacheEntry(cacheKey: string, cacheValue: CacheHandlerValue, cacheType: 'fetch' | 'route'): Promise<void> {
    try {
      const gcsKey = this.getCacheKey(cacheKey, cacheType);
      const file = this.bucket.file(gcsKey);

      // Convert Buffers to base64 strings for JSON serialization
      const serializedData = this.serializeForStorage({ [cacheKey]: cacheValue });

      await file.save(JSON.stringify(serializedData[cacheKey], null, 2), {
        metadata: {
          contentType: 'application/json',
        },
      });
    } catch (error) {
      console.error(`[GcsCacheHandler] Error writing cache entry ${cacheKey}:`, error);
    }
  }

  private async deleteCacheEntry(cacheKey: string, cacheType: 'fetch' | 'route'): Promise<void> {
    try {
      const gcsKey = this.getCacheKey(cacheKey, cacheType);
      const file = this.bucket.file(gcsKey);
      await file.delete();
    } catch (error) {
      // File might not exist, that's fine
      if (!error || typeof error !== 'object' || !('code' in error) || (error as any).code !== 404) {
        console.error(`[GcsCacheHandler] Error deleting cache entry ${cacheKey}:`, error);
      }
    }
  }

  private serializeForStorage(data: CacheData): SerializedCacheData {
    const serialized: SerializedCacheData = {};

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
            const segmentObj: Record<string, SerializableValue> = {};
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

  private deserializeFromStorage(data: SerializedCacheData): CacheData {
    const deserialized: CacheData = {};

    for (const [key, entry] of Object.entries(data)) {
      if (entry && typeof entry === 'object' && 'value' in entry) {
        const value = entry.value;

        if (value && typeof value === 'object') {
          const deserializedValue = { ...value } as Record<string, unknown>;

          // Convert base64 string back to Buffer for body
          if (deserializedValue.body &&
            typeof deserializedValue.body === 'object' &&
            'type' in deserializedValue.body &&
            deserializedValue.body.type === 'Buffer' &&
            'data' in deserializedValue.body) {
            deserializedValue.body = Buffer.from((deserializedValue.body as SerializedBuffer).data, 'base64');
          }

          // Convert base64 string back to Buffer for rscData
          if (deserializedValue.rscData &&
            typeof deserializedValue.rscData === 'object' &&
            'type' in deserializedValue.rscData &&
            deserializedValue.rscData.type === 'Buffer' &&
            'data' in deserializedValue.rscData) {
            deserializedValue.rscData = Buffer.from((deserializedValue.rscData as SerializedBuffer).data, 'base64');
          }

          // Convert serialized Map back to Map with Buffers
          if (deserializedValue.segmentData &&
            typeof deserializedValue.segmentData === 'object' &&
            'type' in deserializedValue.segmentData &&
            deserializedValue.segmentData.type === 'Map' &&
            'data' in deserializedValue.segmentData) {
            const segmentMap = new Map();
            for (const [segKey, segValue] of Object.entries((deserializedValue.segmentData as SerializedMap).data)) {
              if (segValue && typeof segValue === 'object' && 'type' in segValue && segValue.type === 'Buffer' && 'data' in segValue) {
                segmentMap.set(segKey, Buffer.from(segValue.data as string, 'base64'));
              } else {
                segmentMap.set(segKey, segValue);
              }
            }
            deserializedValue.segmentData = segmentMap;
          }

          deserialized[key] = {
            ...entry,
            value: deserializedValue
          };
        } else {
          deserialized[key] = entry;
        }
      } else {
        deserialized[key] = entry;
      }
    }

    return deserialized;
  }

  async get(
    cacheKey: CacheHandlerParametersGet[0],
    ctx?: CacheHandlerParametersGet[1]
  ): Promise<CacheHandlerValue | null> {
    console.log(`[GcsCacheHandler] GET: ${cacheKey}`);

    try {
      // Determine cache type based on context
      const cacheType = this.determineCacheType(ctx);
      const entry = await this.readCacheEntry(cacheKey, cacheType);

      if (!entry) {
        console.log(`[GcsCacheHandler] MISS: ${cacheKey} (${cacheType})`);
        return null;
      }

      console.log(`[GcsCacheHandler] HIT: ${cacheKey} (${cacheType})`, {
        entryType: typeof entry,
        hasValue: entry && typeof entry === 'object' && 'value' in entry
      });

      return entry;
    } catch (error) {
      console.error(`[GcsCacheHandler] Error reading cache for key ${cacheKey}:`, error);
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

    console.log(`[GcsCacheHandler] SET: ${cacheKey} (${cacheType})`, {
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

      // Update tags mapping if there are tags
      if (tags.length > 0) {
        await this.updateTagsMapping(cacheKey, tags);
        console.log(`[GcsCacheHandler] Updated tags mapping for ${cacheKey} with tags:`, tags);
      }

      console.log(`[GcsCacheHandler] Cached ${cacheKey} in ${cacheType} cache`);
    } catch (error) {
      console.error(`[GcsCacheHandler] Error setting cache for key ${cacheKey}:`, error);
    }
  }

  async revalidateTag(tag: CacheHandlerParametersRevalidateTag[0]): Promise<void> {
    console.log(`[GcsCacheHandler] REVALIDATE TAG: ${tag}`);

    const tagArray = [tag].flat();
    let deletedCount = 0;
    const deletedKeys: string[] = [];

    let tagsMapping;
    try {
      // Read the current tags mapping
      tagsMapping = await this.readTagsMapping();
    } catch (error) {
      console.error('[GcsCacheHandler] Error reading tags mapping during revalidateTag:', error);
      tagsMapping = {}; // Use empty mapping if we can't read the file
    }

    // Process each tag
    for (const currentTag of tagArray) {
      const cacheKeysForTag = tagsMapping[currentTag] || [];

      if (cacheKeysForTag.length === 0) {
        console.log(`[GcsCacheHandler] No cache entries found for tag: ${currentTag}`);
        continue;
      }

      console.log(`[GcsCacheHandler] Found ${cacheKeysForTag.length} cache entries for tag: ${currentTag}`);

      // Delete each cache entry for this tag
      for (const cacheKey of cacheKeysForTag) {
        // Determine cache type - we need to check both locations since we don't store the type in the mapping
        let deleted = false;

        // Try fetch cache first
        try {
          await this.deleteCacheEntry(cacheKey, 'fetch');
          deleted = true;
          console.log(`[GcsCacheHandler] Deleted fetch cache entry: ${cacheKey}`);
        } catch (error) {
          // Entry might not exist in fetch cache, try route cache
        }

        // Try route cache if not found in fetch cache
        if (!deleted) {
          try {
            await this.deleteCacheEntry(cacheKey, 'route');
            deleted = true;
            console.log(`[GcsCacheHandler] Deleted route cache entry: ${cacheKey}`);
          } catch (error) {
            console.warn(`[GcsCacheHandler] Cache entry not found in either cache: ${cacheKey}`);
          }
        }

        if (deleted) {
          deletedCount++;
          deletedKeys.push(cacheKey);
        }
      }
    }

    // Update the tags mapping to remove deleted keys
    if (deletedKeys.length > 0) {
      await this.updateTagsMappingBulkDelete(deletedKeys);
      console.log(`[GcsCacheHandler] Updated tags mapping after deleting ${deletedKeys.length} entries`);
    }

    console.log(`[GcsCacheHandler] Revalidated ${deletedCount} entries for tags: ${tagArray.join(', ')}`);

  }

  resetRequestCache(): void {
    console.log(`[GcsCacheHandler] RESET REQUEST CACHE: No-op for GCS-based cache`);
    // For GCS-based cache, this is typically a no-op since we're not maintaining
    // per-request caches. The GCS bucket is the source of truth.
  }
}

// Export a shared instance of the cache data access functions for the API
export async function getSharedCacheStats(): Promise<CacheStats> {
  const bucketName = process.env.CACHE_BUCKET;
  if (!bucketName) {
    console.log('[getSharedCacheStats] CACHE_BUCKET environment variable not found');
    return { size: 0, keys: [], entries: [] };
  }

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  const fetchCachePrefix = 'fetch-cache/';
  const routeCachePrefix = 'route-cache/';

  const keys: string[] = [];
  const entries: CacheEntryInfo[] = [];

  try {
    // Process fetch cache files
    try {
      const [fetchFiles] = await bucket.getFiles({ prefix: fetchCachePrefix });
      const jsonFiles = fetchFiles.filter((file: any) => file.name.endsWith('.json'));

      for (const file of jsonFiles) {
        try {
          const cacheKey = file.name.replace(fetchCachePrefix, '').replace('.json', '').replace(/_/g, '-');
          const displayKey = `fetch:${cacheKey}`;
          keys.push(displayKey);

          // Read the cache file to extract tags
          const [data] = await file.download();
          const cacheData = JSON.parse(data.toString());

          entries.push({
            key: displayKey,
            tags: cacheData.tags || [],
            lastModified: cacheData.lastModified || Date.now(),
            type: 'fetch'
          });
        } catch (fileError) {
          console.warn(`[getSharedCacheStats] Error reading fetch cache file ${file.name}:`, fileError);
          // Add entry with empty tags if file can't be read
          const cacheKey = file.name.replace(fetchCachePrefix, '').replace('.json', '').replace(/_/g, '-');
          const displayKey = `fetch:${cacheKey}`;
          keys.push(displayKey);
          entries.push({
            key: displayKey,
            tags: [],
            type: 'fetch'
          });
        }
      }
    } catch (error) {
      console.warn('[getSharedCacheStats] Error reading fetch cache:', error);
    }

    // Process route cache files
    try {
      const [routeFiles] = await bucket.getFiles({ prefix: routeCachePrefix });
      const jsonFiles = routeFiles.filter((file: any) => file.name.endsWith('.json'));

      for (const file of jsonFiles) {
        try {
          const cacheKey = file.name.replace(routeCachePrefix, '').replace('.json', '').replace(/_/g, '-');
          const displayKey = `route:${cacheKey}`;
          keys.push(displayKey);

          // Read the cache file to extract tags
          const [data] = await file.download();
          const cacheData = JSON.parse(data.toString());

          entries.push({
            key: displayKey,
            tags: cacheData.tags || [],
            lastModified: cacheData.lastModified || Date.now(),
            type: 'route'
          });
        } catch (fileError) {
          console.warn(`[getSharedCacheStats] Error reading route cache file ${file.name}:`, fileError);
          // Add entry with empty tags if file can't be read
          const cacheKey = file.name.replace(routeCachePrefix, '').replace('.json', '').replace(/_/g, '-');
          const displayKey = `route:${cacheKey}`;
          keys.push(displayKey);
          entries.push({
            key: displayKey,
            tags: [],
            type: 'route'
          });
        }
      }
    } catch (error) {
      console.warn('[getSharedCacheStats] Error reading route cache:', error);
    }

    console.log(`[getSharedCacheStats] Found ${keys.length} cache entries (${keys.filter(k => k.startsWith('fetch:')).length} fetch, ${keys.filter(k => k.startsWith('route:')).length} route)`);

    return {
      size: keys.length,
      keys: keys,
      entries: entries
    };
  } catch (error) {
    console.log(`[getSharedCacheStats] Error reading cache:`, error);
    return { size: 0, keys: [], entries: [] };
  }
}

export async function clearSharedCache(): Promise<number> {
  const bucketName = process.env.CACHE_BUCKET;
  if (!bucketName) {
    console.log('[clearSharedCache] CACHE_BUCKET environment variable not found');
    return 0;
  }

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  const fetchCachePrefix = 'fetch-cache/';
  const routeCachePrefix = 'route-cache/';
  const tagsFilePath = 'cache/tags/tags.json';

  let sizeBefore = 0;

  try {
    // Clear fetch cache
    try {
      const [fetchFiles] = await bucket.getFiles({ prefix: fetchCachePrefix });
      const jsonFiles = fetchFiles.filter(file => file.name.endsWith('.json'));
      sizeBefore += jsonFiles.length;

      const deletePromises = jsonFiles.map(file => file.delete());
      await Promise.all(deletePromises);

      console.log(`[clearSharedCache] Cleared ${jsonFiles.length} fetch cache entries`);
    } catch (error) {
      console.warn('[clearSharedCache] Error clearing fetch cache:', error);
    }

    // Clear route cache
    try {
      const [routeFiles] = await bucket.getFiles({ prefix: routeCachePrefix });
      const jsonFiles = routeFiles.filter(file => file.name.endsWith('.json'));
      sizeBefore += jsonFiles.length;

      const deletePromises = jsonFiles.map(file => file.delete());
      await Promise.all(deletePromises);

      console.log(`[clearSharedCache] Cleared ${jsonFiles.length} route cache entries`);
    } catch (error) {
      console.warn('[clearSharedCache] Error clearing route cache:', error);
    }

    // Clear tags mapping
    try {
      const tagsFile = bucket.file(tagsFilePath);
      const [exists] = await tagsFile.exists();
      if (exists) {
        await tagsFile.delete();
        console.log(`[clearSharedCache] Cleared tags mapping file`);
      }
    } catch (error) {
      console.warn('[clearSharedCache] Error clearing tags mapping:', error);
    }

    console.log(`[clearSharedCache] Total cleared: ${sizeBefore} cache entries`);
    return sizeBefore;
  } catch (error) {
    console.log(`[clearSharedCache] Error clearing cache:`, error);
    return 0;
  }
}