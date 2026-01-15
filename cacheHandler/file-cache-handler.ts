import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type {
  CacheData,
  CacheStats,
  CacheEntryInfo,
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
  private tagsDir: string;
  private tagsMapFile: string;

  constructor(context: FileSystemCacheContext) {
    console.log('[FileCacheHandler] Initializing file-based cache handler');
    // Create separate cache directories for different cache types
    this.baseDir = path.join(process.cwd(), '.next', 'cache');
    this.fetchCacheDir = path.join(this.baseDir, 'fetch-cache');
    this.routeCacheDir = path.join(this.baseDir, 'route-cache');
    this.buildMetaFile = path.join(this.baseDir, 'build-meta.json');
    this.tagsDir = path.join(this.baseDir, 'tags');
    this.tagsMapFile = path.join(this.tagsDir, 'tags.json');

    // Ensure cache directory exists
    this.ensureCacheDir();

    // Initialize tags mapping file
    this.initializeTagsMapping();

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
      await mkdir(this.tagsDir, { recursive: true });
    } catch (error) {
      // Directory might already exist, that's fine
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        console.error('[FileCacheHandler] Error creating cache directories:', error);
      }
    }
  }

  private initializeTagsMapping(): void {
    try {
      if (!fs.existsSync(this.tagsMapFile)) {
        console.log('[FileCacheHandler] Creating initial tags mapping file');
        const emptyTagsMapping = {};
        fs.writeFileSync(this.tagsMapFile, JSON.stringify(emptyTagsMapping, null, 2), 'utf-8');
      } else {
        console.log('[FileCacheHandler] Tags mapping file already exists');
      }
    } catch (error) {
      console.error('[FileCacheHandler] Error initializing tags mapping:', error);
    }
  }

  private readTagsMapping(): Record<string, string[]> {
    try {
      if (!fs.existsSync(this.tagsMapFile)) {
        return {};
      }

      const data = fs.readFileSync(this.tagsMapFile, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      console.warn('[FileCacheHandler] Error reading tags mapping:', error);
      return {};
    }
  }

  private writeTagsMapping(tagsMapping: Record<string, string[]>): void {
    try {
      fs.writeFileSync(this.tagsMapFile, JSON.stringify(tagsMapping, null, 2), 'utf-8');
    } catch (error) {
      console.error('[FileCacheHandler] Error writing tags mapping:', error);
    }
  }

  private updateTagsMapping(cacheKey: string, tags: string[], isDelete = false): void {
    try {
      const tagsMapping = this.readTagsMapping();

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

      this.writeTagsMapping(tagsMapping);
    } catch (error) {
      console.error('[FileCacheHandler] Error updating tags mapping:', error);
    }
  }

  private updateTagsMappingBulkDelete(cacheKeysToDelete: string[]): void {
    try {
      const tagsMapping = this.readTagsMapping();

      // Remove all deleted cache keys from all tag mappings
      for (const tag of Object.keys(tagsMapping)) {
        tagsMapping[tag] = tagsMapping[tag].filter(key => !cacheKeysToDelete.includes(key));
        // Remove empty tag entries
        if (tagsMapping[tag].length === 0) {
          delete tagsMapping[tag];
        }
      }

      this.writeTagsMapping(tagsMapping);
    } catch (error) {
      console.error('[FileCacheHandler] Error bulk updating tags mapping:', error);
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

      // Update tags mapping if there are tags
      if (tags.length > 0) {
        this.updateTagsMapping(cacheKey, tags);
        console.log(`[FileCacheHandler] Updated tags mapping for ${cacheKey} with tags:`, tags);
      }

      console.log(`[FileCacheHandler] Cached ${cacheKey} in ${cacheType} cache`);
    } catch (error) {
      console.error(`[FileCacheHandler] Error setting cache for key ${cacheKey}:`, error);
    }
  }

  async revalidateTag(tag: CacheHandlerParametersRevalidateTag[0]): Promise<void> {
    console.log(`[FileCacheHandler] REVALIDATE TAG: ${tag}`);

    const tagArray = [tag].flat();
    let deletedCount = 0;
    const deletedKeys: string[] = [];

    // Read the current tags mapping
    const tagsMapping = this.readTagsMapping();

    // Process each tag
    for (const currentTag of tagArray) {
      const cacheKeysForTag = tagsMapping[currentTag] || [];

      if (cacheKeysForTag.length === 0) {
        console.log(`[FileCacheHandler] No cache entries found for tag: ${currentTag}`);
        continue;
      }

      console.log(`[FileCacheHandler] Found ${cacheKeysForTag.length} cache entries for tag: ${currentTag}`);

      // Delete each cache entry for this tag
      for (const cacheKey of cacheKeysForTag) {
        // Determine cache type - we need to check both locations since we don't store the type in the mapping
        let deleted = false;

        // Try fetch cache first
        try {
          await this.deleteCacheEntry(cacheKey, 'fetch');
          deleted = true;
          console.log(`[FileCacheHandler] Deleted fetch cache entry: ${cacheKey}`);
        } catch (error) {
          // Entry might not exist in fetch cache, try route cache
        }

        // Try route cache if not found in fetch cache
        if (!deleted) {
          try {
            await this.deleteCacheEntry(cacheKey, 'route');
            deleted = true;
            console.log(`[FileCacheHandler] Deleted route cache entry: ${cacheKey}`);
          } catch (error) {
            console.warn(`[FileCacheHandler] Cache entry not found in either cache: ${cacheKey}`);
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
      this.updateTagsMappingBulkDelete(deletedKeys);
      console.log(`[FileCacheHandler] Updated tags mapping after deleting ${deletedKeys.length} entries`);
    }

    console.log(`[FileCacheHandler] Revalidated ${deletedCount} entries for tags: ${tagArray.join(', ')}`);
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
  const entries: CacheEntryInfo[] = [];

  try {
    // Process fetch cache files
    try {
      const fetchFiles = await fs.promises.readdir(fetchCacheDir);
      const jsonFiles = fetchFiles.filter(file => file.endsWith('.json'));

      for (const file of jsonFiles) {
        try {
          const cacheKey = file.replace('.json', '').replace(/_/g, '-');
          const displayKey = `fetch:${cacheKey}`;
          keys.push(displayKey);

          // Read the cache file to extract tags
          const filePath = path.join(fetchCacheDir, file);
          const data = await fs.promises.readFile(filePath, 'utf-8');
          const cacheData = JSON.parse(data);

          entries.push({
            key: displayKey,
            tags: cacheData.tags || [],
            lastModified: cacheData.lastModified || Date.now(),
            type: 'fetch'
          });
        } catch (fileError) {
          console.warn(`[getSharedCacheStats] Error reading fetch cache file ${file}:`, fileError);
          // Add entry with empty tags if file can't be read
          const cacheKey = file.replace('.json', '').replace(/_/g, '-');
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
      // Directory might not exist
    }

    // Process route cache files
    try {
      const routeFiles = await fs.promises.readdir(routeCacheDir);
      const jsonFiles = routeFiles.filter(file => file.endsWith('.json'));

      for (const file of jsonFiles) {
        try {
          const cacheKey = file.replace('.json', '').replace(/_/g, '-');
          const displayKey = `route:${cacheKey}`;
          keys.push(displayKey);

          // Read the cache file to extract tags
          const filePath = path.join(routeCacheDir, file);
          const data = await fs.promises.readFile(filePath, 'utf-8');
          const cacheData = JSON.parse(data);

          entries.push({
            key: displayKey,
            tags: cacheData.tags || [],
            lastModified: cacheData.lastModified || Date.now(),
            type: 'route'
          });
        } catch (fileError) {
          console.warn(`[getSharedCacheStats] Error reading route cache file ${file}:`, fileError);
          // Add entry with empty tags if file can't be read
          const cacheKey = file.replace('.json', '').replace(/_/g, '-');
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
      // Directory might not exist
    }

    console.log(`[getSharedCacheStats] Found ${keys.length} cache entries (${keys.filter(k => k.startsWith('fetch:')).length} fetch, ${keys.filter(k => k.startsWith('route:')).length} route)`);

    return {
      size: keys.length,
      keys: keys,
      entries: entries
    };
  } catch (error) {
    console.log(`[getSharedCacheStats] Error reading cache directories:`, error);
    return { size: 0, keys: [], entries: [] };
  }
}

export async function clearSharedCache(): Promise<number> {
  const fetchCacheDir = path.join(process.cwd(), '.next', 'cache', 'fetch-cache');
  const routeCacheDir = path.join(process.cwd(), '.next', 'cache', 'route-cache');
  const tagsFilePath = path.join(process.cwd(), '.next', 'cache', 'tags', 'tags.json');

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

    // Clear tags mapping
    try {
      if (await fs.promises.access(tagsFilePath).then(() => true).catch(() => false)) {
        await fs.promises.unlink(tagsFilePath);
        console.log(`[clearSharedCache] Cleared tags mapping file`);
      }
    } catch (error) {
      console.warn('[clearSharedCache] Error clearing tags mapping:', error);
    }

    console.log(`[clearSharedCache] Total cleared: ${sizeBefore} cache entries`);
    return sizeBefore;
  } catch (error) {
    console.log(`[clearSharedCache] Error clearing cache directories:`, error);
    return 0;
  }
}