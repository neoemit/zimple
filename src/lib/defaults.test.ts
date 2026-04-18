import { describe, expect, it } from 'vitest'
import { defaultCrawlOptions, defaultSettings } from './defaults'

describe('defaults', () => {
  it('uses balanced crawl limits for blog-sized captures', () => {
    expect(defaultCrawlOptions.workers).toBe(4)
    expect(defaultCrawlOptions.limits.maxPages).toBe(1500)
    expect(defaultCrawlOptions.limits.maxDepth).toBe(5)
    expect(defaultCrawlOptions.limits.maxTotalSizeMb).toBe(4096)
    expect(defaultCrawlOptions.limits.maxAssetSizeMb).toBe(50)
    expect(defaultCrawlOptions.limits.timeoutMinutes).toBe(180)
    expect(defaultCrawlOptions.limits.retries).toBe(2)
  })

  it('enables auto-open by default', () => {
    expect(defaultSettings.autoOpenOnSuccess).toBe(true)
    expect(defaultSettings.outputDirectory).toBeNull()
  })
})
