import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  JobSummary,
  ProgressEvent,
  StartJobRequest,
  WebApiConfig,
} from './types.js'

const JOBS_STORE_VERSION = 1

const jobsStatePath = (config: WebApiConfig): string =>
  path.join(config.dataDirectory, 'jobs-state.json')

export interface StoredResumeState {
  tempDirectory: string | null
  checkpointPath: string | null
}

export interface StoredJobRecord {
  summary: JobSummary
  request: StartJobRequest
  logs: string[]
  progress: ProgressEvent[]
  outputDirectory: string
  targetOutputDirectory?: string
  outputFilename: string
  containerName: string
  resumeState: StoredResumeState
}

export interface StoredJobsState {
  queue: string[]
  jobs: StoredJobRecord[]
}

interface StoredJobsPayload {
  version: number
  updatedAt: string
  queue: string[]
  jobs: StoredJobRecord[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object'

const toStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((entry): entry is string => typeof entry === 'string')
}

const normalizeProgressEvent = (input: unknown): ProgressEvent | null => {
  if (!isObject(input)) {
    return null
  }

  if (
    typeof input.jobId !== 'string' ||
    typeof input.stage !== 'string' ||
    typeof input.message !== 'string' ||
    typeof input.timestamp !== 'string'
  ) {
    return null
  }

  return {
    jobId: input.jobId,
    stage: input.stage,
    message: input.message,
    timestamp: input.timestamp,
    attempt: typeof input.attempt === 'number' ? input.attempt : undefined,
    percent: typeof input.percent === 'number' ? input.percent : undefined,
  }
}

const normalizeSummary = (input: unknown): JobSummary | null => {
  if (!isObject(input)) {
    return null
  }

  if (
    typeof input.id !== 'string' ||
    typeof input.url !== 'string' ||
    typeof input.state !== 'string' ||
    typeof input.createdAt !== 'string' ||
    typeof input.attempt !== 'number'
  ) {
    return null
  }

  return {
    id: input.id,
    url: input.url,
    state: input.state as JobSummary['state'],
    createdAt: input.createdAt,
    attempt: input.attempt,
    startedAt:
      typeof input.startedAt === 'string' || input.startedAt === null
        ? input.startedAt
        : null,
    finishedAt:
      typeof input.finishedAt === 'string' || input.finishedAt === null
        ? input.finishedAt
        : null,
    outputPath:
      typeof input.outputPath === 'string' || input.outputPath === null
        ? input.outputPath
        : null,
    errorMessage:
      typeof input.errorMessage === 'string' || input.errorMessage === null
        ? input.errorMessage
        : null,
  }
}

const normalizeRequest = (input: unknown): StartJobRequest | null => {
  if (!isObject(input)) {
    return null
  }

  if (typeof input.url !== 'string' || !isObject(input.crawl)) {
    return null
  }

  const crawl = input.crawl
  if (
    typeof crawl.respectRobots !== 'boolean' ||
    typeof crawl.workers !== 'number' ||
    !Array.isArray(crawl.includePatterns) ||
    !Array.isArray(crawl.excludePatterns) ||
    !isObject(crawl.limits)
  ) {
    return null
  }

  const limits = crawl.limits
  if (
    typeof limits.maxPages !== 'number' ||
    typeof limits.maxDepth !== 'number' ||
    typeof limits.maxTotalSizeMb !== 'number' ||
    typeof limits.maxAssetSizeMb !== 'number' ||
    typeof limits.timeoutMinutes !== 'number' ||
    typeof limits.retries !== 'number'
  ) {
    return null
  }

  return {
    url: input.url,
    outputDirectory:
      typeof input.outputDirectory === 'string' || input.outputDirectory === null
        ? input.outputDirectory
        : null,
    outputFilename:
      typeof input.outputFilename === 'string' || input.outputFilename === null
        ? input.outputFilename
        : null,
    title:
      typeof input.title === 'string' || input.title === null
        ? input.title
        : null,
    description:
      typeof input.description === 'string' || input.description === null
        ? input.description
        : null,
    faviconUrl:
      typeof input.faviconUrl === 'string' || input.faviconUrl === null
        ? input.faviconUrl
        : null,
    crawl: {
      respectRobots: crawl.respectRobots,
      workers: crawl.workers,
      includePatterns: crawl.includePatterns.filter(
        (pattern): pattern is string => typeof pattern === 'string',
      ),
      excludePatterns: crawl.excludePatterns.filter(
        (pattern): pattern is string => typeof pattern === 'string',
      ),
      limits: {
        maxPages: limits.maxPages,
        maxDepth: limits.maxDepth,
        maxTotalSizeMb: limits.maxTotalSizeMb,
        maxAssetSizeMb: limits.maxAssetSizeMb,
        timeoutMinutes: limits.timeoutMinutes,
        retries: limits.retries,
      },
    },
  }
}

const normalizeResumeState = (input: unknown): StoredResumeState => {
  if (!isObject(input)) {
    return {
      tempDirectory: null,
      checkpointPath: null,
    }
  }

  return {
    tempDirectory:
      typeof input.tempDirectory === 'string' || input.tempDirectory === null
        ? input.tempDirectory
        : null,
    checkpointPath:
      typeof input.checkpointPath === 'string' || input.checkpointPath === null
        ? input.checkpointPath
        : null,
  }
}

const normalizeStoredRecord = (input: unknown): StoredJobRecord | null => {
  if (!isObject(input)) {
    return null
  }

  const summary = normalizeSummary(input.summary)
  const request = normalizeRequest(input.request)
  if (!summary || !request) {
    return null
  }

  const progress = Array.isArray(input.progress)
    ? input.progress
        .map((event) => normalizeProgressEvent(event))
        .filter((event): event is ProgressEvent => Boolean(event))
    : []

  return {
    summary,
    request,
    logs: toStringList(input.logs),
    progress,
    outputDirectory: typeof input.outputDirectory === 'string' ? input.outputDirectory : '',
    targetOutputDirectory:
      typeof input.targetOutputDirectory === 'string'
        ? input.targetOutputDirectory
        : typeof input.outputDirectory === 'string'
          ? input.outputDirectory
          : '',
    outputFilename: typeof input.outputFilename === 'string' ? input.outputFilename : 'site',
    containerName: typeof input.containerName === 'string' ? input.containerName : '',
    resumeState: normalizeResumeState(input.resumeState),
  }
}

export const loadJobsState = async (config: WebApiConfig): Promise<StoredJobsState | null> => {
  await fs.mkdir(config.dataDirectory, { recursive: true })

  try {
    const raw = await fs.readFile(jobsStatePath(config), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredJobsPayload>
    if (!parsed || parsed.version !== JOBS_STORE_VERSION) {
      return null
    }

    const jobs = Array.isArray(parsed.jobs)
      ? parsed.jobs
          .map((entry) => normalizeStoredRecord(entry))
          .filter((entry): entry is StoredJobRecord => Boolean(entry))
      : []
    const jobIdSet = new Set(jobs.map((job) => job.summary.id))
    const queue = toStringList(parsed.queue).filter((jobId) => jobIdSet.has(jobId))

    return {
      queue,
      jobs,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw new Error(`Unable to load job state: ${(error as Error).message}`)
  }
}

export const saveJobsState = async (
  config: WebApiConfig,
  state: StoredJobsState,
): Promise<void> => {
  await fs.mkdir(config.dataDirectory, { recursive: true })

  const file = jobsStatePath(config)
  const temporaryFile = `${file}.tmp`
  const payload: StoredJobsPayload = {
    version: JOBS_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    queue: [...state.queue],
    jobs: state.jobs.map((job) => ({
      summary: { ...job.summary },
      request: structuredClone(job.request),
      logs: [...job.logs],
      progress: job.progress.map((event) => ({ ...event })),
      outputDirectory: job.outputDirectory,
      targetOutputDirectory: job.targetOutputDirectory || job.outputDirectory,
      outputFilename: job.outputFilename,
      containerName: job.containerName,
      resumeState: {
        tempDirectory: job.resumeState.tempDirectory,
        checkpointPath: job.resumeState.checkpointPath,
      },
    })),
  }

  await fs.writeFile(temporaryFile, JSON.stringify(payload, null, 2), 'utf8')
  await fs.rename(temporaryFile, file)
}
