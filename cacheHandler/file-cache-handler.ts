import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type { CacheContext, CacheData, CacheStats } from './types';

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const mkdir = promisify(fs.mkdir);

export default class FileCacheHandler {
  private cacheDir: string;
  private cacheFile: string;

  constructor(options: any) {
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

  async get(key: string) {
    console.log(`[FileCacheHandler] GET: ${key}`);

    try {
      const cacheData = await this.readCacheData();
      const entry = cacheData[key];

      if (entry === undefined) {
        console.log(`[FileCacheHandler] MISS: ${key}`);
        return null;
      }

      console.log(`[FileCacheHandler] HIT: ${key}`);
      // Return the entry as Next.js expects it
      return entry;
    } catch (error) {
      console.error(`[FileCacheHandler] Error reading cache for key ${key}:`, error);
      return null;
    }
  }

  async set(key: string, data: any, ctx: CacheContext) {
    console.log(`[FileCacheHandler] SET: ${key}`, {
      tags: ctx?.tags,
      data: data,
      ctx: ctx
    });

    try {
      const cacheData = await this.readCacheData();

      cacheData[key] = {
        value: data,
        lastModified: Date.now(),
        tags: ctx?.tags || [],
      };

      await this.writeCacheData(cacheData);

      const cacheSize = Object.keys(cacheData).length;
      console.log(`[FileCacheHandler] Cache size: ${cacheSize} entries`);
    } catch (error) {
      console.error(`[FileCacheHandler] Error setting cache for key ${key}:`, error);
    }
  }

  async revalidateTag(tags: string | string[]) {
    console.log(`[FileCacheHandler] REVALIDATE TAG: ${tags}`);

    try {
      const tagArray = [tags].flat();
      const cacheData = await this.readCacheData();
      let deletedCount = 0;

      // Iterate over all entries in the cache
      for (const [key, entry] of Object.entries(cacheData)) {
        // If the entry's tags include the specified tag, delete this entry
        if (entry.tags && Array.isArray(entry.tags) && entry.tags.some((tag: string) => tagArray.includes(tag))) {
          delete cacheData[key];
          deletedCount++;
          console.log(`[FileCacheHandler] Deleted cache entry: ${key}`);
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
}

// Export a shared instance of the cache data access functions for the API
export async function getSharedCacheStats(): Promise<CacheStats> {
  const cacheFile = path.join(process.cwd(), '.next', 'cache-data', 'cache.json');

  try {
    const data = await readFile(cacheFile, 'utf-8');
    const cacheData: CacheData = JSON.parse(data);
    const keys = Object.keys(cacheData);

    return {
      size: keys.length,
      keys: keys
    };
  } catch (error) {
    // File doesn't exist or is invalid
    return { size: 0, keys: [] };
  }
}

export async function clearSharedCache(): Promise<number> {
  const cacheFile = path.join(process.cwd(), '.next', 'cache-data', 'cache.json');

  try {
    const data = await readFile(cacheFile, 'utf-8');
    const cacheData: CacheData = JSON.parse(data);
    const sizeBefore = Object.keys(cacheData).length;

    await writeFile(cacheFile, JSON.stringify({}, null, 2), 'utf-8');

    return sizeBefore;
  } catch (error) {
    // File doesn't exist, nothing to clear
    return 0;
  }
}