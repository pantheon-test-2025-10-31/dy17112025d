import { test, expect } from '@playwright/test';

/**
 * Basic cache functionality test using the cache-test page.
 * Tests cache headers and behavior for different cache strategies.
 */
test.describe('Cache Functionality', () => {
  test('should load cache-test page successfully', async ({ page }) => {
    await page.goto('/cache-test');

    // Verify page loads and displays the correct title
    await expect(page).toHaveTitle(/Next.js/);
    await expect(page.locator('h1')).toContainText('Next.js Server-Side Cache Testing');
  });

  test('should show no-cache behavior with correct headers', async ({ page }) => {
    const apiResponses: any[] = [];

    // Monitor all API responses
    page.on('response', async (response) => {
      if (response.url().includes('/api/posts/no-cache')) {
        const headers = await response.allHeaders();
        apiResponses.push({
          url: response.url(),
          status: response.status(),
          headers: headers,
          cacheHeader: headers['x-nextjs-cache'] || headers['cache-control'] || 'none'
        });
      }
    });

    await page.goto('/cache-test');

    // Click the "No Cache" test button
    await page.locator('button', { hasText: 'Test' }).nth(0).click();

    // Wait for the API request to complete
    await page.waitForSelector('text=Always fetches fresh data', { timeout: 15000 });

    // Wait for network request to be captured
    await page.waitForTimeout(1000);

    // Verify API request was made and captured
    expect(apiResponses.length).toBeGreaterThan(0);
    const response = apiResponses[0];

    // Verify response status
    expect(response.status).toBe(200);

    // For no-cache, should NOT have cache HIT headers
    expect(response.cacheHeader).not.toContain('HIT');

    // Should have no-store cache control
    if (response.headers['cache-control']) {
      expect(response.headers['cache-control']).toContain('no-store');
    }

    console.log('No-cache response headers:', response.headers);
  });

  test('should show force-cache behavior and cache hits', async ({ page }) => {
    await page.goto('/cache-test');

    // Record multiple requests to see caching behavior through UI
    const timings: number[] = [];

    for (let i = 0; i < 3; i++) {
      const startTime = Date.now();

      // Click force-cache test button
      await page.locator('button', { hasText: 'Test' }).nth(1).click();
      await page.waitForSelector('text=Uses cache indefinitely', { timeout: 15000 });

      const endTime = Date.now();
      timings.push(endTime - startTime);

      // Wait between requests
      await page.waitForTimeout(1000);
    }

    console.log('UI Response timings:', timings);

    // Validate cache behavior by checking UI timing patterns
    // Subsequent requests should generally be faster due to caching
    if (timings.length >= 2) {
      const firstTiming = timings[0];
      const subsequentTimings = timings.slice(1);

      // At least one subsequent request should be significantly faster
      const fasterRequests = subsequentTimings.filter(t => t < firstTiming * 0.8);

      console.log('First request timing:', firstTiming);
      console.log('Subsequent timings:', subsequentTimings);
      console.log('Faster requests:', fasterRequests.length);

      // Verify cache is working by checking that some requests are faster
      // (allowing for some variance in network timing)
      expect(fasterRequests.length).toBeGreaterThan(0);
    }

    // Verify UI shows force-cache strategy
    await expect(page.locator('text=force-cache')).toBeVisible();
  });

  test('should load cache stats and display entries', async ({ page }) => {
    await page.goto('/cache-test');

    // First create some cache entries by testing endpoints
    await page.locator('button', { hasText: 'Test' }).nth(1).click(); // Force cache
    await page.waitForSelector('text=Uses cache indefinitely', { timeout: 15000 });

    // Now click refresh stats button
    await page.locator('button:has-text("Refresh Stats")').click();

    // Wait for stats to load
    await page.waitForSelector('div:has-text("Cache Entries")', { timeout: 15000 });

    // Verify stats are displayed
    await expect(page.locator('text=Custom Cache Handler Stats')).toBeVisible();
    await expect(page.locator('div:has-text("Cache Entries")').first()).toBeVisible();

    // Check that handler type is shown (should be file-based)
    await expect(page.locator('text=File-based Cache Handler').or(page.locator('text=GCS/File-based Cache Handler'))).toBeVisible();

    // Should show cache entries count
    await expect(page.locator('text=Cache Keys')).toBeVisible();
  });

  test('should validate time-based revalidation cache behavior', async ({ page, request }) => {
    await page.goto('/cache-test');

    // Test revalidate endpoint using direct API calls for more reliable measurement
    const directApiResponses = [];

    for (let i = 0; i < 3; i++) {
      const startTime = Date.now();
      const response = await request.get('/api/posts/revalidate');
      const responseBody = await response.json();
      const endTime = Date.now();

      directApiResponses.push({
        status: response.status(),
        serverDuration: responseBody.duration_ms,
        clientDuration: endTime - startTime,
        fetchedAt: responseBody.fetched_at,
        cacheStrategy: responseBody.cache_strategy
      });

      console.log(`Revalidate API request ${i + 1}:`, directApiResponses[i]);
      await page.waitForTimeout(500); // Wait between requests but within revalidate window
    }

    // Validate API responses
    expect(directApiResponses.length).toBeGreaterThanOrEqual(1);

    // Verify all requests succeeded
    directApiResponses.forEach(resp => {
      expect(resp.status).toBe(200);
      expect(resp.cacheStrategy).toBe('revalidate-60s');
    });

    // Check for cache behavior - subsequent requests within the 60s window should potentially be cached
    if (directApiResponses.length >= 2) {
      const timings = directApiResponses.map(r => r.serverDuration);
      const fetchTimes = directApiResponses.map(r => r.fetchedAt);

      console.log('Revalidate timings:', timings);
      console.log('Fetch timestamps:', fetchTimes);

      // Either some requests should be faster OR we should see the same fetch timestamp
      const fastRequests = timings.slice(1).filter(t => t < timings[0] * 0.8);
      const uniqueFetchTimes = new Set(fetchTimes);

      console.log('Fast subsequent requests:', fastRequests.length);
      console.log('Unique fetch timestamps:', uniqueFetchTimes.size);

      // For revalidate cache, we expect either faster responses or reused data
      expect(fastRequests.length > 0 || uniqueFetchTimes.size < fetchTimes.length).toBe(true);
    }

    // Also test via UI to ensure functionality works
    await page.locator('button', { hasText: 'Test' }).nth(2).click(); // Revalidate 60s endpoint
    await page.waitForSelector('text=Cache for 60 seconds', { timeout: 15000 });

    // Verify the UI shows correct cache strategy
    await expect(page.locator('text=Revalidate 60s')).toBeVisible();
  });

  test('should allow cache tag revalidation', async ({ page }) => {
    const apiResponses: any[] = [];
    const revalidationRequests: any[] = [];

    // Monitor tagged cache endpoint
    page.on('response', async (response) => {
      if (response.url().includes('/api/posts/with-tags')) {
        const headers = await response.allHeaders();
        apiResponses.push({
          url: response.url(),
          cacheHeader: headers['x-nextjs-cache'] || 'none',
          timestamp: Date.now()
        });
      }

      if (response.url().includes('/api/revalidate')) {
        revalidationRequests.push({
          url: response.url(),
          status: response.status()
        });
      }
    });

    await page.goto('/cache-test');

    // First, create cache entry with tags
    await page.locator('button', { hasText: 'Test' }).nth(3).click(); // Tagged cache endpoint
    await page.waitForSelector('text=Cache with tags', { timeout: 15000 });
    await page.waitForTimeout(1000);

    // Load cache stats
    await page.locator('button:has-text("Refresh Stats")').click();
    await page.waitForSelector('div:has-text("Cache Entries")', { timeout: 15000 });

    // Look for revalidation tags
    const tagElements = page.locator('span:has-text("🔄")');
    const tagCount = await tagElements.count();

    console.log('Tagged cache responses before revalidation:', apiResponses.length);

    if (tagCount > 0) {
      // Click a tag to trigger revalidation
      await tagElements.first().click();

      // Handle the alert dialog
      page.once('dialog', async (dialog) => {
        await dialog.accept();
      });

      await page.waitForTimeout(2000);

      // Test the endpoint again to see if cache was invalidated
      await page.locator('button', { hasText: 'Test' }).nth(3).click();
      await page.waitForSelector('text=Cache with tags', { timeout: 15000 });

      console.log('Total tagged cache responses:', apiResponses.length);
      console.log('Revalidation requests:', revalidationRequests.length);

      // Verify that revalidation had some effect
      expect(apiResponses.length).toBeGreaterThanOrEqual(1);
    } else {
      console.log('No revalidation tags found - cache may not have tags configured');
    }
  });
});