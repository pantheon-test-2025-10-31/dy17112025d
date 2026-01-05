export interface CacheContext {
  revalidate?: number;
  tags?: string[];
  fetchCache?: boolean;
}

const cache = new Map()

// Export the cache Map so it can be accessed from outside
export { cache }

export default class CacheHandler {
  // Make cache a static property so all instances share the same cache
  static cache = cache
  constructor(options: any) {
    console.log('[CacheHandler] Initializing cache handler')
  }

  async get(key: string) {
    console.log(`[CacheHandler] GET: ${key}`)
    const entry = cache.get(key)

    if (entry === undefined) {
      console.log(`[CacheHandler] MISS: ${key}`)
      return null
    }

    console.log(`[CacheHandler] HIT: ${key}`)
    // Return only the value property, not the wrapper
    return entry
  }

  async set(key: string, data: any, ctx: CacheContext) {
    console.log(`[CacheHandler] SET: ${key}`, {
      revalidate: ctx?.revalidate,
      tags: ctx?.tags
    })

    cache.set(key, {
      value: data,
      lastModified: Date.now(),
      tags: ctx?.tags || [],
    })
    console.log(`[CacheHandler] Cache size: ${cache.size} entries`)
  }

  async revalidateTag(tags: string | string[]) {
    console.log(`[CacheHandler] REVALIDATE TAG: ${tags}`)
    // tags is either a string or an array of strings
    const tagArray = [tags].flat()
    let deletedCount = 0

    // Iterate over all entries in the cache
    for (let [key, entry] of cache) {
      // If the entry's tags include the specified tag, delete this entry
      if (entry.tags && Array.isArray(entry.tags) && entry.tags.some((tag: string) => tagArray.includes(tag))) {
        cache.delete(key)
        deletedCount++
        console.log(`[CacheHandler] Deleted cache entry: ${key}`)
      }
    }
    console.log(`[CacheHandler] Revalidated ${deletedCount} entries for tags: ${tagArray.join(', ')}`)
  }

  // Additional helper methods
  getCacheStats() {
    console.log(`[CacheHandler] Getting cache stats - Size: ${cache.size}`)
    console.log(`[CacheHandler] Cache keys:`, Array.from(cache.keys()))
    return {
      size: cache.size,
      keys: Array.from(cache.keys())
    }
  }

  async clearCache() {
    console.log(`[CacheHandler] CLEAR ALL: Clearing ${cache.size} entries`)
    cache.clear()
  }
}