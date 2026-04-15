import { describe, expect, it } from 'vitest'
import { defaultCrawlOptions, defaultSettings } from './defaults'

describe('defaults', () => {
  it('uses conservative crawl limits', () => {
    expect(defaultCrawlOptions.limits.maxPages).toBe(2000)
    expect(defaultCrawlOptions.limits.maxDepth).toBe(5)
    expect(defaultCrawlOptions.limits.maxTotalSizeMb).toBe(2048)
    expect(defaultCrawlOptions.limits.maxAssetSizeMb).toBe(50)
    expect(defaultCrawlOptions.limits.timeoutMinutes).toBe(120)
    expect(defaultCrawlOptions.limits.retries).toBe(3)
  })

  it('enables auto-open by default', () => {
    expect(defaultSettings.autoOpenOnSuccess).toBe(true)
    expect(defaultSettings.outputDirectory).toBeNull()
  })
})
