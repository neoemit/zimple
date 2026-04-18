export type JobState = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled'

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

export interface PauseJobResponse {
  paused: boolean
  message?: string
}

export interface ResumeJobResponse {
  resumed: boolean
  message?: string
}

export interface ClearQueueResponse {
  removed: number
}

export interface OpenOutputResponse {
  opened: boolean
}

export interface WebApiConfig {
  bindAddress: string
  port: number
  outputDirectory: string
  dataDirectory: string
  dockerSocketPath: string
  zimitImage: string
  dockerHost: string | null
}
