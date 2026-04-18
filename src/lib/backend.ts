import { defaultCrawlOptions, defaultSettings } from './defaults'
import type {
  BackendCapabilities,
  CancelJobResponse,
  ClearQueueResponse,
  JobDetail,
  JobProgressDeltaResponse,
  JobSummary,
  OpenOutputResponse,
  PauseJobResponse,
  ProgressEvent,
  ResumeJobResponse,
  RuntimeHealth,
  Settings,
  StartJobRequest,
  StartJobResponse,
} from './types'

export interface BackendClient {
  getCapabilities(): BackendCapabilities
  startJob(request: StartJobRequest): Promise<StartJobResponse>
  listJobs(): Promise<JobSummary[]>
  getJob(jobId: string): Promise<JobDetail>
  cancelJob(jobId: string): Promise<CancelJobResponse>
  pauseJob(jobId: string): Promise<PauseJobResponse>
  resumeJob(jobId: string): Promise<ResumeJobResponse>
  clearQueue(): Promise<ClearQueueResponse>
  openOutput(jobId: string): Promise<OpenOutputResponse>
  getRuntimeHealth(): Promise<RuntimeHealth>
  getSettings(): Promise<Settings>
  setSettings(settings: Settings): Promise<Settings>
  pickOutputDirectory(): Promise<string | null>
  onJobProgress(handler: (event: ProgressEvent) => void): Promise<() => void>
  onJobStateChanged(handler: (event: JobSummary) => void): Promise<() => void>
  onRuntimeHealthChanged(handler: (event: RuntimeHealth) => void): Promise<() => void>
}

type BackendMode = 'http' | 'mock'

const getConfiguredBackendMode = (): BackendMode | null => {
  const configured = String(import.meta.env.VITE_ZIMPLE_BACKEND ?? '')
    .trim()
    .toLowerCase()

  if (configured === 'http' || configured === 'mock') {
    return configured
  }
  return null
}

const getHttpApiBaseUrl = (): string => {
  const configured = String(import.meta.env.VITE_ZIMPLE_API_BASE_URL ?? '').trim()
  if (configured.length > 0) {
    return configured.replace(/\/+$/, '')
  }

  if (typeof window !== 'undefined') {
    return window.location.origin.replace(/\/+$/, '')
  }

  return 'http://127.0.0.1:8080'
}

const startIntervalPoller = (
  intervalMs: number,
  poll: () => Promise<void>,
): (() => void) => {
  let active = true
  let inFlight = false
  const run = async (): Promise<void> => {
    if (!active || inFlight) {
      return
    }
    inFlight = true
    try {
      await poll()
    } catch (error) {
      console.error(error)
    } finally {
      inFlight = false
    }
  }

  void run()
  const intervalHandle = window.setInterval(() => {
    void run()
  }, intervalMs)

  return () => {
    active = false
    window.clearInterval(intervalHandle)
  }
}

class MockBackendClient implements BackendClient {
  private readonly jobs = new Map<string, JobDetail>()
  private readonly progressHandlers = new Set<(event: ProgressEvent) => void>()
  private readonly stateHandlers = new Set<(event: JobSummary) => void>()
  private readonly runtimeHandlers = new Set<(event: RuntimeHealth) => void>()
  private settings: Settings = { ...defaultSettings }

  getCapabilities(): BackendCapabilities {
    return {
      platform: 'mock',
      outputActionLabel: 'Download Output',
      supportsDirectoryPicker: false,
    }
  }

  async startJob(request: StartJobRequest): Promise<StartJobResponse> {
    const now = new Date().toISOString()
    const id = `mock-${Date.now()}`

    const summary: JobSummary = {
      id,
      url: request.url,
      state: 'queued',
      createdAt: now,
      attempt: 1,
      startedAt: null,
      finishedAt: null,
      outputPath: null,
      errorMessage: null,
    }

    this.jobs.set(id, {
      summary,
      request,
      logs: ['[mock] Job queued'],
      progress: [],
    })

    this.emitState(summary)

    window.setTimeout(() => {
      const job = this.jobs.get(id)
      if (!job || job.summary.state !== 'queued') {
        return
      }

      job.summary.state = 'running'
      job.summary.startedAt = new Date().toISOString()
      job.logs.push('[mock] Processing started')
      this.emitState({ ...job.summary })

      const progressEvent: ProgressEvent = {
        jobId: id,
        stage: 'crawl',
        message: 'Mock crawl is running. Start `npm run dev:web:api` for real jobs.',
        timestamp: new Date().toISOString(),
        percent: 50,
      }

      job.progress.push(progressEvent)
      this.emitProgress(progressEvent)

      window.setTimeout(() => {
        const target = this.jobs.get(id)
        if (!target || target.summary.state !== 'running') {
          return
        }

        target.summary.state = 'succeeded'
        target.summary.finishedAt = new Date().toISOString()
        target.summary.outputPath = `${this.settings.outputDirectory ?? '/tmp'}/mock-output.zim`
        target.logs.push('[mock] Completed')

        this.emitProgress({
          jobId: id,
          stage: 'done',
          message: 'Mock output generated',
          timestamp: new Date().toISOString(),
          percent: 100,
        })
        this.emitState({ ...target.summary })
      }, 1200)
    }, 600)

    return { jobId: id }
  }

  async listJobs(): Promise<JobSummary[]> {
    return Array.from(this.jobs.values())
      .map((job) => ({ ...job.summary }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async getJob(jobId: string): Promise<JobDetail> {
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new Error(`Job not found: ${jobId}`)
    }

    return {
      summary: { ...job.summary },
      request: { ...job.request },
      logs: [...job.logs],
      progress: [...job.progress],
    }
  }

  async cancelJob(jobId: string): Promise<CancelJobResponse> {
    const job = this.jobs.get(jobId)
    if (!job) {
      return { cancelled: false }
    }

    job.summary.state = 'cancelled'
    job.summary.finishedAt = new Date().toISOString()
    job.logs.push('[mock] Cancelled by user')
    this.emitState({ ...job.summary })
    return { cancelled: true }
  }

  async pauseJob(jobId: string): Promise<PauseJobResponse> {
    const job = this.jobs.get(jobId)
    if (!job) {
      return { paused: false, message: `Unknown job id: ${jobId}` }
    }

    if (job.summary.state !== 'running') {
      return { paused: false, message: 'Only running jobs can be paused.' }
    }

    job.summary.state = 'paused'
    job.logs.push('[mock] Paused by user')
    this.emitState({ ...job.summary })
    return { paused: true }
  }

  async resumeJob(jobId: string): Promise<ResumeJobResponse> {
    const job = this.jobs.get(jobId)
    if (!job) {
      return { resumed: false, message: `Unknown job id: ${jobId}` }
    }

    if (job.summary.state !== 'paused') {
      return { resumed: false, message: 'Only paused jobs can be resumed.' }
    }

    job.summary.state = 'queued'
    job.logs.push('[mock] Resume requested')
    this.emitState({ ...job.summary })

    window.setTimeout(() => {
      const target = this.jobs.get(jobId)
      if (!target || target.summary.state !== 'queued') {
        return
      }

      target.summary.state = 'running'
      target.logs.push('[mock] Resumed processing')
      this.emitState({ ...target.summary })
    }, 200)

    return { resumed: true }
  }

  async clearQueue(): Promise<ClearQueueResponse> {
    let removed = 0

    for (const [jobId, job] of this.jobs.entries()) {
      if (job.summary.state === 'failed' || job.summary.state === 'cancelled') {
        this.jobs.delete(jobId)
        removed += 1
      }
    }

    return { removed }
  }

  async openOutput(jobId: string): Promise<OpenOutputResponse> {
    const job = this.jobs.get(jobId)
    return { opened: Boolean(job?.summary.outputPath) }
  }

  async getRuntimeHealth(): Promise<RuntimeHealth> {
    const health: RuntimeHealth = {
      dockerInstalled: false,
      dockerResponsive: false,
      zimitImagePresent: false,
      ready: false,
      message: 'Running in mock mode. Start `npm run dev:web:api` for real jobs.',
    }

    this.emitRuntime(health)
    return health
  }

  async getSettings(): Promise<Settings> {
    return { ...this.settings }
  }

  async setSettings(settings: Settings): Promise<Settings> {
    this.settings = { ...settings }
    return { ...this.settings }
  }

  async pickOutputDirectory(): Promise<string | null> {
    return this.settings.outputDirectory ?? null
  }

  async onJobProgress(handler: (event: ProgressEvent) => void): Promise<() => void> {
    this.progressHandlers.add(handler)
    return () => this.progressHandlers.delete(handler)
  }

  async onJobStateChanged(handler: (event: JobSummary) => void): Promise<() => void> {
    this.stateHandlers.add(handler)
    return () => this.stateHandlers.delete(handler)
  }

  async onRuntimeHealthChanged(handler: (event: RuntimeHealth) => void): Promise<() => void> {
    this.runtimeHandlers.add(handler)
    return () => this.runtimeHandlers.delete(handler)
  }

  private emitProgress(event: ProgressEvent): void {
    for (const handler of this.progressHandlers) {
      handler(event)
    }
  }

  private emitState(event: JobSummary): void {
    for (const handler of this.stateHandlers) {
      handler(event)
    }
  }

  private emitRuntime(event: RuntimeHealth): void {
    for (const handler of this.runtimeHandlers) {
      handler(event)
    }
  }
}

export class HttpBackendClient implements BackendClient {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  getCapabilities(): BackendCapabilities {
    return {
      platform: 'http',
      outputActionLabel: 'Download Output',
      supportsDirectoryPicker: false,
    }
  }

  async startJob(request: StartJobRequest): Promise<StartJobResponse> {
    return this.request<StartJobResponse>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }

  async listJobs(): Promise<JobSummary[]> {
    return this.request<JobSummary[]>('/api/jobs')
  }

  async getJob(jobId: string): Promise<JobDetail> {
    return this.request<JobDetail>(`/api/jobs/${encodeURIComponent(jobId)}`)
  }

  async cancelJob(jobId: string): Promise<CancelJobResponse> {
    return this.request<CancelJobResponse>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    })
  }

  async pauseJob(jobId: string): Promise<PauseJobResponse> {
    return this.request<PauseJobResponse>(`/api/jobs/${encodeURIComponent(jobId)}/pause`, {
      method: 'POST',
    })
  }

  async resumeJob(jobId: string): Promise<ResumeJobResponse> {
    return this.request<ResumeJobResponse>(`/api/jobs/${encodeURIComponent(jobId)}/resume`, {
      method: 'POST',
    })
  }

  async clearQueue(): Promise<ClearQueueResponse> {
    return this.request<ClearQueueResponse>('/api/jobs/clear-terminal', {
      method: 'POST',
    })
  }

  async openOutput(jobId: string): Promise<OpenOutputResponse> {
    if (typeof window === 'undefined') {
      return { opened: false }
    }

    const outputUrl = `${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}/output`
    const popup = window.open(outputUrl, '_blank', 'noopener,noreferrer')
    return { opened: popup !== null }
  }

  async getRuntimeHealth(): Promise<RuntimeHealth> {
    return this.request<RuntimeHealth>('/api/runtime-health')
  }

  async getSettings(): Promise<Settings> {
    return this.request<Settings>('/api/settings')
  }

  async setSettings(settings: Settings): Promise<Settings> {
    return this.request<Settings>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    })
  }

  async pickOutputDirectory(): Promise<string | null> {
    const settings = await this.getSettings()
    return settings.outputDirectory ?? null
  }

  async onJobProgress(handler: (event: ProgressEvent) => void): Promise<() => void> {
    const cursors = new Map<string, number>()

    return startIntervalPoller(1500, async () => {
      const jobs = await this.listJobs()

      const jobsById = new Map(jobs.map((job) => [job.id, job]))
      const pollingIds = new Set<string>()

      for (const job of jobs) {
        if (job.state === 'running') {
          pollingIds.add(job.id)
        }
      }
      for (const existingId of cursors.keys()) {
        pollingIds.add(existingId)
      }

      for (const jobId of pollingIds) {
        const after = cursors.get(jobId) ?? -1
        let delta: JobProgressDeltaResponse
        try {
          delta = await this.getJobProgressDelta(jobId, after, 160)
        } catch {
          cursors.delete(jobId)
          continue
        }
        for (const event of delta.progress) {
          handler(event)
        }
        cursors.set(jobId, delta.nextCursor)

        const summary = jobsById.get(jobId)
        if (!summary || summary.state !== 'running') {
          cursors.delete(jobId)
        }
      }
    })
  }

  async onJobStateChanged(handler: (event: JobSummary) => void): Promise<() => void> {
    const fingerprints = new Map<string, string>()

    return startIntervalPoller(3000, async () => {
      const jobs = await this.listJobs()
      const seen = new Set<string>()

      for (const job of jobs) {
        seen.add(job.id)
        const fingerprint = [
          job.state,
          job.attempt,
          job.startedAt ?? '',
          job.finishedAt ?? '',
          job.outputPath ?? '',
          job.errorMessage ?? '',
        ].join('|')
        if (fingerprints.get(job.id) !== fingerprint) {
          fingerprints.set(job.id, fingerprint)
          handler(job)
        }
      }

      for (const knownId of fingerprints.keys()) {
        if (!seen.has(knownId)) {
          fingerprints.delete(knownId)
        }
      }
    })
  }

  async onRuntimeHealthChanged(handler: (event: RuntimeHealth) => void): Promise<() => void> {
    return startIntervalPoller(5000, async () => {
      handler(await this.getRuntimeHealth())
    })
  }

  private async request<T>(pathSuffix: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    if (!headers.has('Content-Type') && init?.body) {
      headers.set('Content-Type', 'application/json')
    }

    const response = await fetch(`${this.baseUrl}${pathSuffix}`, {
      ...init,
      headers,
    })

    const contentType = response.headers.get('content-type') || ''
    const payload = contentType.includes('application/json')
      ? ((await response.json()) as Record<string, unknown>)
      : {}

    if (!response.ok) {
      const message =
        typeof payload.message === 'string'
          ? payload.message
          : `Request failed with status ${response.status}.`
      throw new Error(message)
    }

    return payload as T
  }

  private async getJobProgressDelta(
    jobId: string,
    after: number,
    limit: number,
  ): Promise<JobProgressDeltaResponse> {
    return this.request<JobProgressDeltaResponse>(
      `/api/jobs/${encodeURIComponent(jobId)}/progress?after=${encodeURIComponent(String(after))}&limit=${encodeURIComponent(String(limit))}`,
    )
  }
}

let backendSingleton: BackendClient | null = null

export const getBackendClient = (): BackendClient => {
  if (backendSingleton) {
    return backendSingleton
  }

  const configuredMode = getConfiguredBackendMode()
  if (configuredMode === 'mock') {
    backendSingleton = new MockBackendClient()
    return backendSingleton
  }

  backendSingleton = new HttpBackendClient(getHttpApiBaseUrl())
  return backendSingleton
}

export const createDefaultStartJobRequest = (): StartJobRequest => ({
  url: '',
  outputFilename: null,
  outputDirectory: null,
  crawl: structuredClone(defaultCrawlOptions),
})
