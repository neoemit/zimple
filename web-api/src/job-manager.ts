import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import {
  checkRuntimeHealth,
  containerNameForJob,
  ensureZimitImage,
  runZimitOnce,
  sleepForRetry,
  stopContainer,
  zimitAttemptTimeoutMs,
} from './runtime.js'
import { loadSettings, saveSettings } from './settings-store.js'
import { normalizeStartJobRequest, nowIso } from './validation.js'
import type {
  JobDetail,
  JobProgressDeltaResponse,
  JobSummary,
  JobState,
  ProgressEvent,
  RuntimeHealth,
  Settings,
  StartJobRequest,
  WebApiConfig,
} from './types.js'

interface JobRecord {
  summary: JobSummary
  request: StartJobRequest
  logs: string[]
  progress: ProgressEvent[]
  outputDirectory: string
  outputFilename: string
  containerName: string
  cancelRequested: boolean
  activeProcess: ChildProcess | null
}

export interface RuntimeAdapter {
  checkRuntimeHealth(config: WebApiConfig): Promise<RuntimeHealth>
  containerNameForJob(jobId: string): string
  ensureZimitImage(config: WebApiConfig, timeoutMs: number): Promise<boolean>
  runZimitOnce(
    config: WebApiConfig,
    request: StartJobRequest,
    outputDirectory: string,
    outputFilename: string,
    containerName: string,
    onLog: (line: string) => void,
    onProcess: (child: ChildProcess) => void,
  ): Promise<{
    success: boolean
    errorMessage?: string
    retryable?: boolean
    exitCode?: number | null
  }>
  stopContainer(config: WebApiConfig, containerName: string): Promise<boolean>
  sleepForRetry(attemptIndex: number): Promise<void>
}

const defaultRuntimeAdapter: RuntimeAdapter = {
  checkRuntimeHealth,
  containerNameForJob,
  ensureZimitImage,
  runZimitOnce,
  stopContainer,
  sleepForRetry,
}

const isAbsolutePath = (value: string): boolean =>
  path.isAbsolute(value) || /^[A-Za-z]:\\/.test(value)

const addProgressEvent = (
  job: JobRecord,
  stage: string,
  message: string,
  attempt?: number,
): void => {
  const event: ProgressEvent = {
    jobId: job.summary.id,
    stage,
    message,
    timestamp: nowIso(),
    attempt,
  }

  job.logs.push(message)
  job.progress.push(event)
}

const listZimFiles = (outputDirectory: string): Set<string> => {
  const found = new Set<string>()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(outputDirectory, { withFileTypes: true })
  } catch {
    return found
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }
    if (!entry.name.toLowerCase().endsWith('.zim')) {
      continue
    }
    found.add(path.join(outputDirectory, entry.name))
  }

  return found
}

const ensureAvailableOutputFilename = (
  outputDirectory: string,
  preferredName: string,
): string => {
  let candidate = preferredName
  let suffix = 1

  while (fs.existsSync(path.join(outputDirectory, `${candidate}.zim`))) {
    candidate = `${preferredName}-${suffix}`
    suffix += 1
  }

  return candidate
}

const resolveOutputPath = (
  outputDirectory: string,
  previousZims: Set<string>,
  preferredName: string,
): string | null => {
  const preferredPath = path.join(outputDirectory, `${preferredName}.zim`)
  if (fs.existsSync(preferredPath)) {
    return preferredPath
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(outputDirectory, { withFileTypes: true })
  } catch {
    return null
  }

  const candidates: Array<{ filePath: string; modified: number }> = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.zim')) {
      continue
    }

    const filePath = path.join(outputDirectory, entry.name)
    if (previousZims.has(filePath)) {
      continue
    }

    let modified = 0
    try {
      modified = fs.statSync(filePath).mtimeMs
    } catch {
      modified = 0
    }
    candidates.push({ filePath, modified })
  }

  candidates.sort((a, b) => b.modified - a.modified)
  return candidates[0]?.filePath || null
}

const updateJobState = (
  job: JobRecord,
  nextState: JobState,
  updates?: Partial<JobSummary>,
): void => {
  job.summary.state = nextState
  Object.assign(job.summary, updates || {})
}

export class JobManager {
  private readonly config: WebApiConfig

  private readonly runtime: RuntimeAdapter

  private settings: Settings

  private readonly jobs = new Map<string, JobRecord>()

  private readonly queue: string[] = []

  private workerRunning = false

  private constructor(
    config: WebApiConfig,
    settings: Settings,
    runtime: RuntimeAdapter,
  ) {
    this.config = config
    this.settings = settings
    this.runtime = runtime
  }

  static async create(
    config: WebApiConfig,
    runtime: RuntimeAdapter = defaultRuntimeAdapter,
  ): Promise<JobManager> {
    const settings = await loadSettings(config)
    return new JobManager(config, settings, runtime)
  }

  getSettings(): Settings {
    return { ...this.settings }
  }

  async setSettings(nextSettings: Settings): Promise<Settings> {
    if (
      typeof nextSettings.outputDirectory === 'string' &&
      nextSettings.outputDirectory.trim().length > 0 &&
      !isAbsolutePath(nextSettings.outputDirectory)
    ) {
      throw new Error(
        `Output directory must be absolute for Docker socket mode. Received: ${nextSettings.outputDirectory}`,
      )
    }

    const saved = await saveSettings(this.config, nextSettings)
    this.settings = saved
    return { ...saved }
  }

  async startJob(request: StartJobRequest): Promise<{ jobId: string }> {
    const { normalized, outputFilename } = normalizeStartJobRequest(request)
    const configuredOutputDir =
      normalized.outputDirectory?.trim() ||
      this.settings.outputDirectory?.trim() ||
      this.config.outputDirectory
    if (!configuredOutputDir) {
      throw new Error(
        'No output directory configured. Set one in settings before starting jobs.',
      )
    }
    if (!isAbsolutePath(configuredOutputDir)) {
      throw new Error(
        `Output directory must be absolute for Docker socket mode. Received: ${configuredOutputDir}`,
      )
    }

    await fsp.mkdir(configuredOutputDir, { recursive: true })

    const jobId = randomUUID()
    const containerName = this.runtime.containerNameForJob(jobId)

    const summary: JobSummary = {
      id: jobId,
      url: normalized.url,
      state: 'queued',
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      outputPath: null,
      errorMessage: null,
      attempt: 0,
    }

    this.jobs.set(jobId, {
      summary,
      request: normalized,
      logs: ['Job queued'],
      progress: [],
      outputDirectory: configuredOutputDir,
      outputFilename,
      containerName,
      cancelRequested: false,
      activeProcess: null,
    })
    this.queue.push(jobId)
    this.ensureWorker()

    return { jobId }
  }

  listJobs(): JobSummary[] {
    return Array.from(this.jobs.values())
      .map((record) => ({ ...record.summary }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  getJob(jobId: string): JobDetail | null {
    const job = this.jobs.get(jobId)
    if (!job) {
      return null
    }

    return {
      summary: { ...job.summary },
      request: { ...job.request },
      logs: [...job.logs],
      progress: [...job.progress],
    }
  }

  getJobProgressDelta(
    jobId: string,
    afterCursor = -1,
    limit = 120,
  ): JobProgressDeltaResponse | null {
    const job = this.jobs.get(jobId)
    if (!job) {
      return null
    }

    const maxIndex = job.progress.length - 1
    const safeAfter = Number.isFinite(afterCursor)
      ? Math.min(Math.max(Math.floor(afterCursor), -1), maxIndex)
      : -1
    const safeLimit = Number.isFinite(limit)
      ? Math.min(Math.max(Math.floor(limit), 1), 500)
      : 120

    const start = safeAfter + 1
    const endExclusive = Math.min(start + safeLimit, job.progress.length)
    const progress = job.progress.slice(start, endExclusive)
    const nextCursor = progress.length > 0 ? endExclusive - 1 : safeAfter

    return {
      summary: { ...job.summary },
      progress: progress.map((event) => ({ ...event })),
      nextCursor,
    }
  }

  async cancelJob(jobId: string): Promise<{ cancelled: boolean }> {
    const queuedIndex = this.queue.findIndex((queuedId) => queuedId === jobId)
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1)
      const queuedJob = this.jobs.get(jobId)
      if (!queuedJob) {
        return { cancelled: false }
      }

      updateJobState(queuedJob, 'cancelled', { finishedAt: nowIso() })
      addProgressEvent(queuedJob, 'cancelled', 'Job cancelled while queued')
      return { cancelled: true }
    }

    const activeJob = this.jobs.get(jobId)
    if (!activeJob || activeJob.summary.state !== 'running') {
      return { cancelled: false }
    }

    activeJob.cancelRequested = true
    updateJobState(activeJob, 'cancelled', {
      finishedAt: activeJob.summary.finishedAt || nowIso(),
    })
    addProgressEvent(activeJob, 'cancel', 'Cancellation requested. Stopping container...')

    const stopPromise = this.runtime.stopContainer(this.config, activeJob.containerName)
    if (activeJob.activeProcess) {
      activeJob.activeProcess.kill('SIGTERM')
    }
    await stopPromise.catch(() => undefined)

    return { cancelled: true }
  }

  getOutputPath(jobId: string): string | null {
    const job = this.jobs.get(jobId)
    return job?.summary.outputPath || null
  }

  getOutputFilename(jobId: string): string | null {
    const outputPath = this.getOutputPath(jobId)
    return outputPath ? path.basename(outputPath) : null
  }

  getOutputMimeType(jobId: string): string {
    const outputPath = this.getOutputPath(jobId) || ''
    return outputPath.toLowerCase().endsWith('.zim')
      ? 'application/octet-stream'
      : 'application/octet-stream'
  }

  async getRuntimeHealth(): Promise<RuntimeHealth> {
    return this.runtime.checkRuntimeHealth(this.config)
  }

  private ensureWorker(): void {
    if (this.workerRunning) {
      return
    }

    this.workerRunning = true
    void this.workerLoop()
  }

  private async workerLoop(): Promise<void> {
    while (this.queue.length > 0) {
      const jobId = this.queue.shift()
      if (!jobId) {
        continue
      }

      const job = this.jobs.get(jobId)
      if (!job) {
        continue
      }

      updateJobState(job, 'running', {
        startedAt: job.summary.startedAt || nowIso(),
      })
      addProgressEvent(job, 'running', 'Job started')

      try {
        await this.processJob(jobId)
      } catch (error) {
        updateJobState(job, 'failed', {
          finishedAt: nowIso(),
          errorMessage: `Unexpected failure: ${(error as Error).message}`,
        })
        addProgressEvent(job, 'failed', 'ZIM build failed')
      } finally {
        job.activeProcess = null
      }
    }

    this.workerRunning = false
  }

  private async processJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId)
    if (!job) {
      return
    }

    const resolvedOutputFilename = ensureAvailableOutputFilename(
      job.outputDirectory,
      job.outputFilename,
    )
    if (resolvedOutputFilename !== job.outputFilename) {
      addProgressEvent(
        job,
        'runtime',
        `Output file ${job.outputFilename}.zim already exists. Using ${resolvedOutputFilename}.zim for this run.`,
      )
      job.outputFilename = resolvedOutputFilename
    }

    if (!job.request.crawl.respectRobots) {
      addProgressEvent(
        job,
        'runtime',
        'Robots override is not directly enforceable in zimit; crawler policy remains zimit-default.',
      )
    }
    if (job.request.crawl.limits.maxAssetSizeMb > 0) {
      addProgressEvent(
        job,
        'runtime',
        'Per-asset size cap is not directly enforceable in zimit; using total size hard limit.',
      )
    }

    addProgressEvent(job, 'runtime', 'Checking zimit runtime image...')
    try {
      const pulled = await this.runtime.ensureZimitImage(this.config, 20 * 60 * 1000)
      addProgressEvent(
        job,
        'runtime',
        pulled ? 'Runtime image prepared.' : 'Runtime image ready.',
      )
    } catch (error) {
      if (job.cancelRequested) {
        updateJobState(job, 'cancelled', {
          finishedAt: job.summary.finishedAt || nowIso(),
        })
        addProgressEvent(job, 'cancelled', 'Job cancelled during runtime preparation')
      } else {
        updateJobState(job, 'failed', {
          finishedAt: nowIso(),
          errorMessage: (error as Error).message,
        })
        addProgressEvent(job, 'error', (error as Error).message)
      }
      return
    }

    const retries = Math.max(0, job.request.crawl.limits.retries)

    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      if (job.cancelRequested) {
        updateJobState(job, 'cancelled', {
          finishedAt: job.summary.finishedAt || nowIso(),
        })
        addProgressEvent(job, 'cancelled', 'Job cancelled before attempt', attempt)
        return
      }

      job.summary.attempt = attempt
      addProgressEvent(job, 'attempt', `Attempt ${attempt} of ${retries + 1} started`, attempt)
      addProgressEvent(job, 'runtime', 'Launching zimit capture engine...', attempt)

      const previousZims = listZimFiles(job.outputDirectory)
      const timeoutMs = zimitAttemptTimeoutMs(job.request.crawl.limits.timeoutMinutes)

      let heartbeatHandle: NodeJS.Timeout | null = null
      let timeoutHandle: NodeJS.Timeout | null = null
      let timedOut = false
      let result:
        | {
            success: boolean
            errorMessage?: string
            retryable?: boolean
            exitCode?: number | null
          }
        | null = null

      try {
        heartbeatHandle = setInterval(() => {
          if (!job.cancelRequested) {
            addProgressEvent(job, 'heartbeat', `Attempt ${attempt} still running...`, attempt)
          }
        }, 15_000)

        result = await Promise.race([
          this.runtime.runZimitOnce(
            this.config,
            job.request,
            job.outputDirectory,
            job.outputFilename,
            job.containerName,
            (line) => {
              if (!job.cancelRequested) {
                addProgressEvent(job, 'log', line, attempt)
              }
            },
            (child) => {
              job.activeProcess = child
            },
          ),
          new Promise<null>((resolve) => {
            timeoutHandle = setTimeout(() => {
              timedOut = true
              resolve(null)
            }, timeoutMs)
          }),
        ])
      } finally {
        if (heartbeatHandle) {
          clearInterval(heartbeatHandle)
        }
        if (timeoutHandle) {
          clearTimeout(timeoutHandle)
        }
        job.activeProcess = null
      }

      if (job.cancelRequested) {
        await this.runtime
          .stopContainer(this.config, job.containerName)
          .catch(() => undefined)
        updateJobState(job, 'cancelled', {
          finishedAt: job.summary.finishedAt || nowIso(),
        })
        addProgressEvent(job, 'cancelled', 'Job cancelled', attempt)
        return
      }

      if (timedOut || result === null) {
        await this.runtime
          .stopContainer(this.config, job.containerName)
          .catch(() => undefined)
        const message = `Attempt ${attempt} timed out after ${job.request.crawl.limits.timeoutMinutes} minutes plus conversion headroom.`
        addProgressEvent(job, 'timeout', message, attempt)

        if (attempt <= retries) {
          addProgressEvent(job, 'retry', 'Retrying after timeout', attempt)
          await this.runtime.sleepForRetry(attempt)
          continue
        }

        updateJobState(job, 'failed', {
          finishedAt: nowIso(),
          errorMessage: message,
        })
        addProgressEvent(job, 'failed', 'ZIM build failed', attempt)
        return
      }

      if (result.success) {
        const outputPath = resolveOutputPath(
          job.outputDirectory,
          previousZims,
          job.outputFilename,
        )
        if (outputPath) {
          updateJobState(job, 'succeeded', {
            finishedAt: nowIso(),
            outputPath,
            errorMessage: null,
          })
          addProgressEvent(job, 'completed', 'ZIM build completed', attempt)
          addProgressEvent(job, 'output', `Generated output: ${outputPath}`, attempt)
          return
        }

        const missingOutput =
          'zimit completed without writing a .zim file into the output directory.'
        addProgressEvent(job, 'error', missingOutput, attempt)
        if (attempt <= retries) {
          addProgressEvent(
            job,
            'retry',
            `Attempt ${attempt} produced no output archive. Retrying...`,
            attempt,
          )
          await this.runtime.sleepForRetry(attempt)
          continue
        }

        updateJobState(job, 'failed', {
          finishedAt: nowIso(),
          errorMessage: missingOutput,
        })
        addProgressEvent(job, 'failed', 'ZIM build failed', attempt)
        return
      }

      if (result.retryable === false) {
        updateJobState(job, 'failed', {
          finishedAt: nowIso(),
          errorMessage: result.errorMessage || 'zimit execution failed.',
        })
        addProgressEvent(
          job,
          'failed',
          `Non-retryable runtime failure${result.exitCode !== undefined ? ` (exit ${result.exitCode ?? 'signal'})` : ''}.`,
          attempt,
        )
        return
      }

      if (attempt <= retries) {
        addProgressEvent(
          job,
          'retry',
          `Attempt ${attempt} failed: ${result.errorMessage || 'unknown error'}. Retrying...`,
          attempt,
        )
        await this.runtime.sleepForRetry(attempt)
        continue
      }

      updateJobState(job, 'failed', {
        finishedAt: nowIso(),
        errorMessage: result.errorMessage || 'zimit execution failed.',
      })
      addProgressEvent(job, 'failed', 'ZIM build failed', attempt)
      return
    }
  }
}
