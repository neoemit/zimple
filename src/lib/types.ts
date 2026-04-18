export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type BackendPlatform = 'http' | 'mock'
export type ThemeMode = 'system' | 'light' | 'dark'

export interface BackendCapabilities {
  platform: BackendPlatform
  outputActionLabel: string
  supportsDirectoryPicker: boolean
}

export interface CrawlLimits {
  maxPages: number
  maxDepth: number
  maxTotalSizeMb: number
  maxAssetSizeMb: number
  timeoutMinutes: number
  retries: number
}

export interface CrawlOptions {
  respectRobots: boolean
  workers: number
  includePatterns: string[]
  excludePatterns: string[]
  limits: CrawlLimits
}

export interface StartJobRequest {
  url: string
  outputDirectory?: string | null
  outputFilename?: string | null
  crawl: CrawlOptions
}

export interface StartJobResponse {
  jobId: string
}

export interface JobSummary {
  id: string
  url: string
  state: JobState
  createdAt: string
  startedAt?: string | null
  finishedAt?: string | null
  outputPath?: string | null
  errorMessage?: string | null
  attempt: number
}

export interface ProgressEvent {
  jobId: string
  stage: string
  message: string
  timestamp: string
  attempt?: number
  percent?: number
}

export interface JobDetail {
  summary: JobSummary
  request: StartJobRequest
  logs: string[]
  progress: ProgressEvent[]
}

export interface JobProgressDeltaResponse {
  summary: JobSummary
  progress: ProgressEvent[]
  nextCursor: number
}

export interface RuntimeHealth {
  dockerInstalled: boolean
  dockerResponsive: boolean
  zimitImagePresent: boolean
  ready: boolean
  message?: string | null
}

export interface Settings {
  outputDirectory?: string | null
  autoOpenOnSuccess: boolean
}

export interface CancelJobResponse {
  cancelled: boolean
}

export interface OpenOutputResponse {
  opened: boolean
}
