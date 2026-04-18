import type { CrawlOptions, Settings } from './types'

export const defaultCrawlOptions: CrawlOptions = {
  respectRobots: true,
  workers: 4,
  includePatterns: [],
  excludePatterns: [],
  limits: {
    maxPages: 1500,
    maxDepth: 5,
    maxTotalSizeMb: 4096,
    maxAssetSizeMb: 50,
    timeoutMinutes: 180,
    retries: 2,
  },
}

export const defaultSettings: Settings = {
  outputDirectory: null,
  autoOpenOnSuccess: true,
}
