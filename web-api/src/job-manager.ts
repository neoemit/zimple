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
  stopContainerGracefully,
  zimitAttemptTimeoutMs,
} from './runtime.js'
import type { ZimitRunOptions } from './runtime.js'
import { loadSettings, saveSettings } from './settings-store.js'
import { loadJobsState, saveJobsState } from './jobs-store.js'
import type { StoredJobRecord } from './jobs-store.js'
import { normalizeStartJobRequest, nowIso } from './validation.js'
import type {
  CancelJobResponse,
  ClearQueueResponse,
  JobDetail,
  JobProgressDeltaResponse,
  JobSummary,
  JobState,
  PauseJobResponse,
  ProgressEvent,
  ResumeJobResponse,
  RuntimeHealth,
  Settings,
  StartJobRequest,
  WebApiConfig,
} from './types.js'

interface ResumeState {
  tempDirectory: string | null
  checkpointPath: string | null
}

interface JobRecord {
  summary: JobSummary
  request: StartJobRequest
  logs: string[]
  progress: ProgressEvent[]
  outputDirectory: string
  outputFilename: string
  containerName: string
  cancelRequested: boolean
  pauseRequested: boolean
  resumeState: ResumeState
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
    options?: ZimitRunOptions,
  ): Promise<{
    success: boolean
    errorMessage?: string
    retryable?: boolean
    exitCode?: number | null
  }>
  stopContainer(config: WebApiConfig, containerName: string): Promise<boolean>
  stopContainerGracefully?: (
    config: WebApiConfig,
    containerName: string,
    timeoutSeconds?: number,
  ) => Promise<boolean>
  sleepForRetry(attemptIndex: number): Promise<void>
}

const defaultRuntimeAdapter: RuntimeAdapter = {
  checkRuntimeHealth,
  containerNameForJob,
  ensureZimitImage,
  runZimitOnce,
  stopContainer,
  stopContainerGracefully,
  sleepForRetry,
}

const MAX_PERSISTED_LOGS = 320
const MAX_PERSISTED_PROGRESS = 640
const PERSIST_DEBOUNCE_MS = 350
const HEARTBEAT_INTERVAL_MS = 15_000
const PAUSE_WAIT_TIMEOUT_MS = 12_000

const tempDirectoryPattern = /Output to tempdir:\s*([^\s|]+)/i
const checkpointPattern = /Saving crawl state to:\s*([^\s|]+)/i

const isAbsolutePath = (value: string): boolean =>
  path.isAbsolute(value) || /^[A-Za-z]:\\/.test(value)

const isPathWithin = (baseDirectory: string, targetPath: string): boolean => {
  const relative = path.relative(baseDirectory, targetPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const outputContainerPathToHostPath = (
  outputDirectory: string,
  containerPath: string,
): string | null => {
  if (!containerPath.startsWith('/output')) {
    return null
  }

  const relative = containerPath.replace(/^\/output\/?/, '')
  const normalized = relative.length > 0 ? relative.split('/').join(path.sep) : ''
  const hostPath = path.resolve(outputDirectory, normalized)

  if (!isPathWithin(outputDirectory, hostPath)) {
    return null
  }

  return hostPath
}

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

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

export class JobManager {
  private readonly config: WebApiConfig

  private readonly runtime: RuntimeAdapter

  private settings: Settings

  private readonly jobs = new Map<string, JobRecord>()

  private readonly queue: string[] = []

  private workerRunning = false

  private persistTimer: NodeJS.Timeout | null = null

  private persistChain: Promise<void> = Promise.resolve()

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
    const manager = new JobManager(config, settings, runtime)
    await manager.restorePersistedJobs()
    manager.ensureWorker()
    return manager
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
      pauseRequested: false,
      resumeState: {
        tempDirectory: null,
        checkpointPath: null,
      },
      activeProcess: null,
    })
    this.queue.push(jobId)

    await this.flushPersistNow()
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

  async cancelJob(jobId: string): Promise<CancelJobResponse> {
    const queuedIndex = this.queue.findIndex((queuedId) => queuedId === jobId)
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1)
      const queuedJob = this.jobs.get(jobId)
      if (!queuedJob) {
        return { cancelled: false }
      }

      updateJobState(queuedJob, 'cancelled', { finishedAt: nowIso() })
      this.recordProgress(queuedJob, 'cancelled', 'Job cancelled while queued', undefined, true)
      await this.cleanupTemporaryDirectory(queuedJob)
      await this.flushPersistNow()
      return { cancelled: true }
    }

    const job = this.jobs.get(jobId)
    if (!job) {
      return { cancelled: false }
    }

    if (job.summary.state === 'paused') {
      updateJobState(job, 'cancelled', { finishedAt: nowIso() })
      this.recordProgress(job, 'cancelled', 'Paused job was cancelled')
      await this.cleanupTemporaryDirectory(job)
      await this.flushPersistNow()
      return { cancelled: true }
    }

    if (job.summary.state !== 'running') {
      return { cancelled: false }
    }

    job.cancelRequested = true
    job.pauseRequested = false
    updateJobState(job, 'cancelled', {
      finishedAt: job.summary.finishedAt || nowIso(),
    })
    this.recordProgress(job, 'cancel', 'Cancellation requested. Stopping container...')

    const stopPromise = this.runtime.stopContainer(this.config, job.containerName)
    if (job.activeProcess) {
      job.activeProcess.kill('SIGTERM')
    }
    await stopPromise.catch(() => undefined)

    await this.flushPersistNow()
    return { cancelled: true }
  }

  async pauseJob(jobId: string): Promise<PauseJobResponse> {
    const job = this.jobs.get(jobId)
    if (!job) {
      return {
        paused: false,
        message: `Unknown job id: ${jobId}`,
      }
    }

    if (job.summary.state === 'paused') {
      return {
        paused: true,
        message: 'Job is already paused.',
      }
    }

    if (job.summary.state !== 'running') {
      return {
        paused: false,
        message: 'Only running jobs can be paused.',
      }
    }

    job.pauseRequested = true
    job.cancelRequested = false
    this.recordProgress(job, 'pause', 'Pause requested. Stopping container...')

    await this.stopContainerForPause(job)

    const reached = await this.waitForState(jobId, ['paused', 'failed', 'cancelled'])
    if (reached === 'paused') {
      return { paused: true }
    }

    if (reached === 'failed') {
      return {
        paused: false,
        message:
          job.summary.errorMessage ||
          'Pause failed because a resumable checkpoint could not be confirmed.',
      }
    }

    if (reached === 'cancelled') {
      return {
        paused: false,
        message: 'Pause request was interrupted because the job was cancelled.',
      }
    }

    return {
      paused: false,
      message: 'Pause was requested but the runtime has not stopped yet. Refresh shortly.',
    }
  }

  async resumeJob(jobId: string): Promise<ResumeJobResponse> {
    const job = this.jobs.get(jobId)
    if (!job) {
      return {
        resumed: false,
        message: `Unknown job id: ${jobId}`,
      }
    }

    if (job.summary.state !== 'paused') {
      return {
        resumed: false,
        message: 'Only paused jobs can be resumed.',
      }
    }

    const validation = await this.validateResumeCheckpoint(job)
    if (!validation.ok) {
      updateJobState(job, 'failed', {
        finishedAt: nowIso(),
        errorMessage: validation.message,
      })
      this.recordProgress(job, 'failed', validation.message, undefined, true)
      await this.cleanupTemporaryDirectory(job)
      await this.flushPersistNow()
      return {
        resumed: false,
        message: validation.message,
      }
    }

    if (!this.queue.includes(job.summary.id)) {
      this.queue.push(job.summary.id)
    }

    job.pauseRequested = false
    job.cancelRequested = false
    updateJobState(job, 'queued', {
      finishedAt: null,
      errorMessage: null,
    })
    this.recordProgress(job, 'resume', 'Resume requested. Job queued from saved checkpoint.')

    await this.flushPersistNow()
    this.ensureWorker()

    return { resumed: true }
  }

  clearQueue(): ClearQueueResponse {
    let removed = 0
    const removedIds = new Set<string>()

    for (const [jobId, job] of this.jobs.entries()) {
      if (
        job.summary.state === 'succeeded' ||
        job.summary.state === 'failed' ||
        job.summary.state === 'cancelled'
      ) {
        this.jobs.delete(jobId)
        removedIds.add(jobId)
        removed += 1

        if (job.resumeState.tempDirectory) {
          void fsp.rm(job.resumeState.tempDirectory, {
            recursive: true,
            force: true,
          })
        }
      }
    }

    if (removedIds.size > 0) {
      const remainingQueue = this.queue.filter((jobId) => !removedIds.has(jobId))
      this.queue.splice(0, this.queue.length, ...remainingQueue)
      void this.flushPersistNow()
    }

    return { removed }
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

  private async restorePersistedJobs(): Promise<void> {
    const stored = await loadJobsState(this.config)
    if (!stored) {
      return
    }

    for (const storedJob of stored.jobs) {
      const record = this.recordFromStored(storedJob)
      this.jobs.set(record.summary.id, record)
    }

    const queuedSet = new Set<string>()
    for (const jobId of stored.queue) {
      const queuedJob = this.jobs.get(jobId)
      if (!queuedJob || queuedSet.has(jobId)) {
        continue
      }
      if (queuedJob.summary.state !== 'queued') {
        continue
      }

      this.queue.push(jobId)
      queuedSet.add(jobId)
    }

    for (const job of this.jobs.values()) {
      if (job.summary.state === 'queued' && !queuedSet.has(job.summary.id)) {
        this.queue.push(job.summary.id)
        queuedSet.add(job.summary.id)
      }
    }

    let changed = false

    for (const job of this.jobs.values()) {
      if (job.summary.state === 'running') {
        if (await this.ensureCheckpointPath(job)) {
          updateJobState(job, 'paused', {
            finishedAt: null,
            errorMessage: null,
          })
          this.recordProgress(
            job,
            'paused',
            'Service restart detected while running. Job restored as paused and can be resumed.',
            undefined,
            true,
          )
        } else {
          const message =
            'Service restart interrupted a running capture and no resumable checkpoint was found. Start a new job to retry.'
          updateJobState(job, 'failed', {
            finishedAt: nowIso(),
            errorMessage: message,
          })
          this.recordProgress(job, 'failed', message, undefined, true)
          await this.cleanupTemporaryDirectory(job)
        }
        changed = true
      }

      if (
        (job.summary.state === 'succeeded' ||
          job.summary.state === 'failed' ||
          job.summary.state === 'cancelled') &&
        job.resumeState.tempDirectory
      ) {
        await this.cleanupTemporaryDirectory(job)
        changed = true
      }
    }

    this.pruneQueue()

    if (changed) {
      await this.flushPersistNow()
    }
  }

  private recordFromStored(stored: StoredJobRecord): JobRecord {
    const containerName =
      stored.containerName.trim().length > 0
        ? stored.containerName
        : this.runtime.containerNameForJob(stored.summary.id)

    return {
      summary: {
        ...stored.summary,
      },
      request: {
        ...stored.request,
      },
      logs: [...stored.logs],
      progress: stored.progress.map((event) => ({ ...event })),
      outputDirectory: stored.outputDirectory,
      outputFilename: stored.outputFilename,
      containerName,
      cancelRequested: false,
      pauseRequested: false,
      resumeState: {
        tempDirectory: stored.resumeState.tempDirectory,
        checkpointPath: stored.resumeState.checkpointPath,
      },
      activeProcess: null,
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      return
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persistNow()
    }, PERSIST_DEBOUNCE_MS)
  }

  private async flushPersistNow(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }

    await this.persistNow()
  }

  private async persistNow(): Promise<void> {
    const snapshotJobs = Array.from(this.jobs.values()).map((job) => ({
      summary: { ...job.summary },
      request: {
        ...job.request,
      },
      logs: job.logs.slice(-MAX_PERSISTED_LOGS),
      progress: job.progress.slice(-MAX_PERSISTED_PROGRESS).map((event) => ({ ...event })),
      outputDirectory: job.outputDirectory,
      outputFilename: job.outputFilename,
      containerName: job.containerName,
      resumeState: {
        tempDirectory: job.resumeState.tempDirectory,
        checkpointPath: job.resumeState.checkpointPath,
      },
    }))

    const snapshotQueue = this.queue.filter((jobId, index) => {
      if (this.queue.indexOf(jobId) !== index) {
        return false
      }
      const job = this.jobs.get(jobId)
      return Boolean(job && job.summary.state === 'queued')
    })

    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await saveJobsState(this.config, {
            queue: snapshotQueue,
            jobs: snapshotJobs,
          })
        } catch (error) {
          console.error('Failed to persist job state:', error)
        }
      })

    await this.persistChain
  }

  private pruneQueue(): void {
    const seen = new Set<string>()
    const nextQueue = this.queue.filter((jobId) => {
      if (seen.has(jobId)) {
        return false
      }
      seen.add(jobId)

      const job = this.jobs.get(jobId)
      return Boolean(job && job.summary.state === 'queued')
    })

    this.queue.splice(0, this.queue.length, ...nextQueue)
  }

  private recordProgress(
    job: JobRecord,
    stage: string,
    message: string,
    attempt?: number,
    persistImmediately = false,
  ): void {
    addProgressEvent(job, stage, message, attempt)
    if (persistImmediately) {
      void this.flushPersistNow()
    } else {
      this.schedulePersist()
    }
  }

  private captureResumeMetadata(job: JobRecord, line: string): void {
    const checkpointMatch = checkpointPattern.exec(line)
    if (checkpointMatch?.[1]) {
      const hostPath = outputContainerPathToHostPath(job.outputDirectory, checkpointMatch[1])
      if (hostPath) {
        job.resumeState.checkpointPath = hostPath
        this.schedulePersist()
      }
    }

    const tempDirectoryMatch = tempDirectoryPattern.exec(line)
    if (tempDirectoryMatch?.[1]) {
      const hostPath = outputContainerPathToHostPath(job.outputDirectory, tempDirectoryMatch[1])
      if (hostPath) {
        job.resumeState.tempDirectory = hostPath
        this.schedulePersist()
      }
    }
  }

  private async ensureCheckpointPath(
    job: JobRecord,
    waitForDiscoveryMs = 0,
  ): Promise<boolean> {
    const deadline = Date.now() + waitForDiscoveryMs
    let firstPass = true
    while (firstPass || Date.now() <= deadline) {
      firstPass = false
      const checkpointPath = job.resumeState.checkpointPath
      if (checkpointPath && isPathWithin(job.outputDirectory, checkpointPath)) {
        try {
          const stat = await fsp.stat(checkpointPath)
          if (stat.isFile()) {
            return true
          }
        } catch {
          job.resumeState.checkpointPath = null
        }
      }

      const discoveredPath = await this.findCheckpointInTempDirectory(job)
      if (discoveredPath) {
        job.resumeState.checkpointPath = discoveredPath
        this.schedulePersist()
        return true
      }

      if (Date.now() <= deadline) {
        await wait(250)
      }
    }
    return false
  }

  private async findCheckpointInTempDirectory(job: JobRecord): Promise<string | null> {
    const tempDirectory = job.resumeState.tempDirectory
    if (!tempDirectory || !isPathWithin(job.outputDirectory, tempDirectory)) {
      return null
    }

    const stack: string[] = [tempDirectory]
    const candidates: Array<{ filePath: string; modified: number }> = []

    while (stack.length > 0) {
      const directoryPath = stack.pop()
      if (!directoryPath) {
        continue
      }

      let entries: fs.Dirent[]
      try {
        entries = await fsp.readdir(directoryPath, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        const fullPath = path.join(directoryPath, entry.name)
        if (!isPathWithin(tempDirectory, fullPath)) {
          continue
        }

        if (entry.isDirectory()) {
          stack.push(fullPath)
          continue
        }

        if (!entry.isFile() || !/\\.ya?ml$/i.test(entry.name)) {
          continue
        }

        if (!fullPath.includes(`${path.sep}crawls${path.sep}`)) {
          continue
        }

        try {
          const stat = await fsp.stat(fullPath)
          candidates.push({
            filePath: fullPath,
            modified: stat.mtimeMs,
          })
        } catch {
          continue
        }
      }
    }

    candidates.sort((left, right) => right.modified - left.modified)
    return candidates[0]?.filePath ?? null
  }

  private async validateResumeCheckpoint(
    job: JobRecord,
  ): Promise<{ ok: true; configPath: string } | { ok: false; message: string }> {
    const hasCheckpoint = await this.ensureCheckpointPath(job)
    if (!hasCheckpoint || !job.resumeState.checkpointPath) {
      return {
        ok: false,
        message:
          'Resume is unavailable because no crawl checkpoint was recorded. Pause again after the crawler has emitted a saved state.',
      }
    }

    const checkpointPath = job.resumeState.checkpointPath
    if (!isPathWithin(job.outputDirectory, checkpointPath)) {
      return {
        ok: false,
        message:
          'Resume checkpoint is outside the configured output directory and cannot be trusted.',
      }
    }

    try {
      const stat = await fsp.stat(checkpointPath)
      if (!stat.isFile()) {
        return {
          ok: false,
          message: `Resume checkpoint is missing: ${checkpointPath}`,
        }
      }
    } catch {
      return {
        ok: false,
        message:
          `Resume checkpoint was not found on disk: ${checkpointPath}. Keep paused temp data and retry, or start a new job.`,
      }
    }

    return {
      ok: true,
      configPath: checkpointPath,
    }
  }

  private async stopContainerForPause(job: JobRecord): Promise<void> {
    const gracefulStopped = await (this.runtime.stopContainerGracefully
      ? this.runtime
          .stopContainerGracefully(this.config, job.containerName, 30)
          .catch(() => false)
      : Promise.resolve(false))

    if (gracefulStopped) {
      return
    }

    if (job.activeProcess) {
      job.activeProcess.kill('SIGTERM')
    }

    await this.runtime
      .stopContainer(this.config, job.containerName)
      .catch(() => undefined)
  }

  private async cleanupTemporaryDirectory(job: JobRecord): Promise<void> {
    const tempDirectory = job.resumeState.tempDirectory
    if (
      !tempDirectory ||
      !isPathWithin(job.outputDirectory, tempDirectory) ||
      job.summary.state === 'paused'
    ) {
      return
    }

    await fsp.rm(tempDirectory, {
      recursive: true,
      force: true,
    }).catch(() => undefined)

    job.resumeState.tempDirectory = null
    job.resumeState.checkpointPath = null
    this.schedulePersist()
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
      if (!job || job.summary.state !== 'queued') {
        continue
      }

      updateJobState(job, 'running', {
        startedAt: job.summary.startedAt || nowIso(),
        finishedAt: null,
      })
      this.recordProgress(job, 'running', 'Job started', undefined, true)

      try {
        await this.processJob(jobId)
      } catch (error) {
        updateJobState(job, 'failed', {
          finishedAt: nowIso(),
          errorMessage: `Unexpected failure: ${(error as Error).message}`,
        })
        this.recordProgress(job, 'failed', 'ZIM build failed', undefined, true)
        await this.cleanupTemporaryDirectory(job)
      } finally {
        job.activeProcess = null
        job.cancelRequested = false
        job.pauseRequested = false
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
      this.recordProgress(
        job,
        'runtime',
        `Output file ${job.outputFilename}.zim already exists. Using ${resolvedOutputFilename}.zim for this run.`,
      )
      job.outputFilename = resolvedOutputFilename
    }

    if (job.request.crawl.limits.maxAssetSizeMb > 0) {
      this.recordProgress(
        job,
        'runtime',
        'Per-asset size cap is not directly enforceable in zimit; using total size hard limit.',
      )
    }

    this.recordProgress(job, 'runtime', 'Checking zimit runtime image...')
    try {
      const pulled = await this.runtime.ensureZimitImage(this.config, 20 * 60 * 1000)
      this.recordProgress(
        job,
        'runtime',
        pulled ? 'Runtime image prepared.' : 'Runtime image ready.',
      )
    } catch (error) {
      if (job.cancelRequested) {
        updateJobState(job, 'cancelled', {
          finishedAt: job.summary.finishedAt || nowIso(),
        })
        this.recordProgress(job, 'cancelled', 'Job cancelled during runtime preparation')
        await this.cleanupTemporaryDirectory(job)
      } else if (job.pauseRequested) {
        const paused = await this.ensureCheckpointPath(job, 6_000)
        if (paused) {
          updateJobState(job, 'paused', {
            finishedAt: null,
            errorMessage: null,
          })
          this.recordProgress(job, 'paused', 'Job paused. Resume when ready.')
        } else {
          const message =
            'Pause request completed but no checkpoint was saved yet. Retry pause after progress events appear.'
          updateJobState(job, 'failed', {
            finishedAt: nowIso(),
            errorMessage: message,
          })
          this.recordProgress(job, 'failed', message)
          await this.cleanupTemporaryDirectory(job)
        }
      } else {
        updateJobState(job, 'failed', {
          finishedAt: nowIso(),
          errorMessage: (error as Error).message,
        })
        this.recordProgress(job, 'error', (error as Error).message)
        await this.cleanupTemporaryDirectory(job)
      }
      await this.flushPersistNow()
      return
    }

    const retries = Math.max(0, job.request.crawl.limits.retries)

    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      if (job.cancelRequested) {
        updateJobState(job, 'cancelled', {
          finishedAt: job.summary.finishedAt || nowIso(),
        })
        this.recordProgress(job, 'cancelled', 'Job cancelled before attempt', attempt)
        await this.cleanupTemporaryDirectory(job)
        await this.flushPersistNow()
        return
      }

      if (job.pauseRequested) {
        const checkpointSaved = await this.ensureCheckpointPath(job, 4_000)
        if (checkpointSaved) {
          updateJobState(job, 'paused', {
            finishedAt: null,
            errorMessage: null,
          })
          this.recordProgress(job, 'paused', 'Job paused. Resume when ready.', attempt)
        } else {
          const message =
            'Pause request completed but no checkpoint was confirmed. Retry pause after crawler state has been saved.'
          updateJobState(job, 'failed', {
            finishedAt: nowIso(),
            errorMessage: message,
          })
          this.recordProgress(job, 'failed', message, attempt)
          await this.cleanupTemporaryDirectory(job)
        }
        await this.flushPersistNow()
        return
      }

      job.summary.attempt = attempt
      this.recordProgress(job, 'attempt', `Attempt ${attempt} of ${retries + 1} started`, attempt)
      this.recordProgress(job, 'runtime', 'Launching zimit capture engine...', attempt)

      const previousZims = listZimFiles(job.outputDirectory)
      const timeoutMs = zimitAttemptTimeoutMs(job.request.crawl.limits.timeoutMinutes)

      const resumeValidation = await this.validateResumeCheckpoint(job)
      if (!resumeValidation.ok && job.resumeState.checkpointPath) {
        updateJobState(job, 'failed', {
          finishedAt: nowIso(),
          errorMessage: resumeValidation.message,
        })
        this.recordProgress(job, 'failed', resumeValidation.message, attempt)
        await this.cleanupTemporaryDirectory(job)
        await this.flushPersistNow()
        return
      }

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

      const runOptions: ZimitRunOptions = {
        saveStateIntervalSeconds: 15,
        resumeConfigPath: resumeValidation.ok ? resumeValidation.configPath : null,
      }

      try {
        heartbeatHandle = setInterval(() => {
          if (!job.cancelRequested && !job.pauseRequested) {
            this.recordProgress(job, 'heartbeat', `Attempt ${attempt} still running...`, attempt)
          }
        }, HEARTBEAT_INTERVAL_MS)

        result = await Promise.race([
          this.runtime.runZimitOnce(
            this.config,
            job.request,
            job.outputDirectory,
            job.outputFilename,
            job.containerName,
            (line) => {
              this.captureResumeMetadata(job, line)
              if (!job.cancelRequested) {
                this.recordProgress(job, 'log', line, attempt)
              }
            },
            (child) => {
              job.activeProcess = child
            },
            runOptions,
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
        this.recordProgress(job, 'cancelled', 'Job cancelled', attempt)
        await this.cleanupTemporaryDirectory(job)
        await this.flushPersistNow()
        return
      }

      if (job.pauseRequested) {
        await this.stopContainerForPause(job)

        const checkpointSaved = await this.ensureCheckpointPath(job, 6_000)
        if (checkpointSaved) {
          updateJobState(job, 'paused', {
            finishedAt: null,
            errorMessage: null,
          })
          this.recordProgress(job, 'paused', 'Job paused. Resume when ready.', attempt)
        } else {
          const message =
            'Pause request completed but no checkpoint was saved. Wait for crawl state logs and try again.'
          updateJobState(job, 'failed', {
            finishedAt: nowIso(),
            errorMessage: message,
          })
          this.recordProgress(job, 'failed', message, attempt)
          await this.cleanupTemporaryDirectory(job)
        }
        await this.flushPersistNow()
        return
      }

      if (timedOut || result === null) {
        await this.runtime
          .stopContainer(this.config, job.containerName)
          .catch(() => undefined)
        const message = `Attempt ${attempt} timed out after ${job.request.crawl.limits.timeoutMinutes} minutes plus conversion headroom.`
        this.recordProgress(job, 'timeout', message, attempt)

        if (attempt <= retries) {
          this.recordProgress(job, 'retry', 'Retrying after timeout', attempt)
          await this.runtime.sleepForRetry(attempt)
          continue
        }

        updateJobState(job, 'failed', {
          finishedAt: nowIso(),
          errorMessage: message,
        })
        this.recordProgress(job, 'failed', 'ZIM build failed', attempt)
        await this.cleanupTemporaryDirectory(job)
        await this.flushPersistNow()
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
          this.recordProgress(job, 'completed', 'ZIM build completed', attempt)
          this.recordProgress(job, 'output', `Generated output: ${outputPath}`, attempt)
          await this.cleanupTemporaryDirectory(job)
          await this.flushPersistNow()
          return
        }

        const missingOutput =
          'zimit completed without writing a .zim file into the output directory.'
        this.recordProgress(job, 'error', missingOutput, attempt)
        if (attempt <= retries) {
          this.recordProgress(
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
        this.recordProgress(job, 'failed', 'ZIM build failed', attempt)
        await this.cleanupTemporaryDirectory(job)
        await this.flushPersistNow()
        return
      }

      if (result.retryable === false) {
        updateJobState(job, 'failed', {
          finishedAt: nowIso(),
          errorMessage: result.errorMessage || 'zimit execution failed.',
        })
        this.recordProgress(
          job,
          'failed',
          `Non-retryable runtime failure${result.exitCode !== undefined ? ` (exit ${result.exitCode ?? 'signal'})` : ''}.`,
          attempt,
        )
        await this.cleanupTemporaryDirectory(job)
        await this.flushPersistNow()
        return
      }

      if (attempt <= retries) {
        this.recordProgress(
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
      this.recordProgress(job, 'failed', 'ZIM build failed', attempt)
      await this.cleanupTemporaryDirectory(job)
      await this.flushPersistNow()
      return
    }
  }

  private async waitForState(
    jobId: string,
    targets: JobState[],
    timeoutMs = PAUSE_WAIT_TIMEOUT_MS,
  ): Promise<JobState | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = this.jobs.get(jobId)?.summary.state
      if (state && targets.includes(state)) {
        return state
      }
      await wait(80)
    }

    return null
  }
}
