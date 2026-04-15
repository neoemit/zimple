import type { CrawlOptions, Settings } from './types'

export const defaultCrawlOptions: CrawlOptions = {
  respectRobots: true,
  workers: 4,
  includePatterns: [],
  excludePatterns: [],
  limits: {
    maxPages: 2000,
    maxDepth: 5,
    maxTotalSizeMb: 2048,
    maxAssetSizeMb: 50,
    timeoutMinutes: 120,
    retries: 3,
  },
}

export const defaultSettings: Settings = {
  outputDirectory: null,
  autoOpenOnSuccess: true,
}
