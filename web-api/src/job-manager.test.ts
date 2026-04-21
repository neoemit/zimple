// @vitest-environment node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { JobManager } from './job-manager.js'
import type { RuntimeAdapter } from './job-manager.js'
import type { StartJobRequest, WebApiConfig } from './types.js'

const waitFor = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const makeRequest = (outputDirectory: string, url = 'https://example.com'): StartJobRequest => ({
  url,
  outputDirectory,
  outputFilename: 'example-capture',
  crawl: {
    respectRobots: true,
    workers: 1,
    includePatterns: [],
    excludePatterns: [],
    limits: {
      maxPages: 10,
      maxDepth: 1,
      maxTotalSizeMb: 256,
      maxAssetSizeMb: 10,
      timeoutMinutes: 5,
      retries: 0,
    },
  },
})

const makeConfig = (outputDirectory: string, dataDirectory: string): WebApiConfig => ({
  bindAddress: '127.0.0.1',
  port: 8000,
  outputDirectory,
  stagingDirectory: null,
  dataDirectory,
  dockerSocketPath: '/var/run/docker.sock',
  zimitImage: 'ghcr.io/openzim/zimit',
  dockerHost: null,
})

const waitForTerminalState = async (
  manager: JobManager,
  jobId: string,
  timeoutMs = 4000,
): Promise<string> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const detail = manager.getJob(jobId)
    const state = detail?.summary.state
    if (state && ['succeeded', 'failed', 'cancelled'].includes(state)) {
      return state
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for terminal state for ${jobId}`)
}

const waitForState = async (
  manager: JobManager,
  jobId: string,
  expectedState: string,
  timeoutMs = 4000,
): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const detail = manager.getJob(jobId)
    if (detail?.summary.state === expectedState) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  const current = manager.getJob(jobId)?.summary.state
  throw new Error(
    `Timed out waiting for ${jobId} to reach ${expectedState}. Current: ${current ?? 'missing'}`,
  )
}

describe('JobManager queue behavior', () => {
  it('processes queue jobs sequentially and stores generated output path', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-jobs-'))
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-data-'))

    const runtime: RuntimeAdapter = {
      checkRuntimeHealth: async () => ({
        dockerInstalled: true,
        dockerResponsive: true,
        zimitImagePresent: true,
        ready: true,
        message: 'ok',
      }),
      containerNameForJob: (jobId) => `zimple-${jobId.slice(0, 12)}`,
      ensureZimitImage: async () => false,
      runZimitOnce: async (
        _config,
        _request,
        outputDirectory,
        outputFilename,
        _containerName,
        onLog,
      ) => {
        onLog('Crawl progress: 1/1 crawled, 0 pending, 0 failed')
        await fs.writeFile(path.join(outputDirectory, `${outputFilename}.zim`), 'zim')
        return { success: true }
      },
      stopContainer: async () => true,
      sleepForRetry: async () => undefined,
    }

    const manager = await JobManager.create(makeConfig(outputDir, dataDir), runtime)

    const first = await manager.startJob(makeRequest(outputDir, 'https://example.com/docs'))
    const second = await manager.startJob(makeRequest(outputDir, 'https://example.com/blog'))

    expect(await waitForTerminalState(manager, first.jobId)).toBe('succeeded')
    expect(await waitForTerminalState(manager, second.jobId)).toBe('succeeded')

    const firstDetail = manager.getJob(first.jobId)
    const secondDetail = manager.getJob(second.jobId)

    expect(firstDetail?.summary.outputPath).toMatch(/\.zim$/)
    expect(secondDetail?.summary.outputPath).toMatch(/\.zim$/)

    await fs.rm(outputDir, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('uses staging output and copies archive to final output directory on success', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-final-'))
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-stage-'))
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-data-'))

    const runtime: RuntimeAdapter = {
      checkRuntimeHealth: async () => ({
        dockerInstalled: true,
        dockerResponsive: true,
        zimitImagePresent: true,
        ready: true,
        message: 'ok',
      }),
      containerNameForJob: (jobId) => `zimple-${jobId.slice(0, 12)}`,
      ensureZimitImage: async () => false,
      runZimitOnce: async (_config, _request, runtimeOutputDirectory, outputFilename) => {
        await fs.writeFile(path.join(runtimeOutputDirectory, `${outputFilename}.zim`), 'zim')
        return { success: true }
      },
      stopContainer: async () => true,
      sleepForRetry: async () => undefined,
    }

    const manager = await JobManager.create(
      {
        ...makeConfig(outputDir, dataDir),
        stagingDirectory: stagingDir,
      },
      runtime,
    )

    const started = await manager.startJob(makeRequest(outputDir, 'https://example.com/staged'))
    expect(await waitForTerminalState(manager, started.jobId)).toBe('succeeded')

    const detail = manager.getJob(started.jobId)
    expect(detail?.summary.outputPath).toBeTruthy()
    expect(path.dirname(detail?.summary.outputPath || '')).toBe(outputDir)

    const finalEntries = await fs.readdir(outputDir)
    expect(finalEntries.some((name) => name.toLowerCase().endsWith('.zim'))).toBe(true)

    const stagedEntries = await fs.readdir(stagingDir)
    expect(stagedEntries.some((name) => name.toLowerCase().endsWith('.zim'))).toBe(false)

    await fs.rm(outputDir, { recursive: true, force: true })
    await fs.rm(stagingDir, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('can cancel a queued job while another job is running', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-cancel-'))
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-data-'))
    let releaseFirstJob: (() => void) | undefined
    let firstJobGate: Promise<void> | null = null

    const runtime: RuntimeAdapter = {
      checkRuntimeHealth: async () => ({
        dockerInstalled: true,
        dockerResponsive: true,
        zimitImagePresent: true,
        ready: true,
        message: 'ok',
      }),
      containerNameForJob: (jobId) => `zimple-${jobId.slice(0, 12)}`,
      ensureZimitImage: async () => false,
      runZimitOnce: async (
        _config,
        _request,
        outputDirectory,
        outputFilename,
      ) => {
        if (!firstJobGate) {
          firstJobGate = new Promise<void>((resolve) => {
            releaseFirstJob = () => resolve()
          })
        }
        await firstJobGate
        await fs.writeFile(path.join(outputDirectory, `${outputFilename}.zim`), 'zim')
        return { success: true }
      },
      stopContainer: async () => true,
      sleepForRetry: async () => undefined,
    }

    const manager = await JobManager.create(makeConfig(outputDir, dataDir), runtime)

    const first = await manager.startJob(makeRequest(outputDir, 'https://example.com/one'))
    const second = await manager.startJob(makeRequest(outputDir, 'https://example.com/two'))
    await waitForState(manager, first.jobId, 'running')

    const cancelResponse = await manager.cancelJob(second.jobId)
    expect(cancelResponse.cancelled).toBe(true)

    const releaseDeadline = Date.now() + 1000
    while (typeof releaseFirstJob !== 'function' && Date.now() < releaseDeadline) {
      await waitFor(10)
    }
    if (typeof releaseFirstJob !== 'function') {
      throw new Error('Expected first job gate release function to be initialized')
    }
    releaseFirstJob()

    expect(await waitForTerminalState(manager, first.jobId)).toBe('succeeded')
    expect(await waitForTerminalState(manager, second.jobId)).toBe('cancelled')

    await fs.rm(outputDir, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('returns incremental progress deltas with cursor + limit', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-progress-'))
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-data-'))

    const runtime: RuntimeAdapter = {
      checkRuntimeHealth: async () => ({
        dockerInstalled: true,
        dockerResponsive: true,
        zimitImagePresent: true,
        ready: true,
        message: 'ok',
      }),
      containerNameForJob: (jobId) => `zimple-${jobId.slice(0, 12)}`,
      ensureZimitImage: async () => false,
      runZimitOnce: async (
        _config,
        _request,
        outputDirectory,
        outputFilename,
        _containerName,
        onLog,
      ) => {
        onLog('Starting page crawl: https://example.com')
        onLog('Crawl progress: 1/2 crawled, 1 pending, 0 failed')
        onLog('Crawl progress: 2/2 crawled, 0 pending, 0 failed')
        await fs.writeFile(path.join(outputDirectory, `${outputFilename}.zim`), 'zim')
        return { success: true }
      },
      stopContainer: async () => true,
      sleepForRetry: async () => undefined,
    }

    const manager = await JobManager.create(makeConfig(outputDir, dataDir), runtime)
    const { jobId } = await manager.startJob(makeRequest(outputDir))
    expect(await waitForTerminalState(manager, jobId)).toBe('succeeded')

    const firstDelta = manager.getJobProgressDelta(jobId, -1, 2)
    expect(firstDelta).not.toBeNull()
    expect(firstDelta?.progress.length).toBe(2)
    expect(firstDelta?.nextCursor).toBe(1)

    const secondDelta = manager.getJobProgressDelta(jobId, firstDelta?.nextCursor ?? -1, 2)
    expect(secondDelta).not.toBeNull()
    expect(secondDelta?.progress.length).toBeGreaterThan(0)
    expect((secondDelta?.nextCursor ?? -1) > (firstDelta?.nextCursor ?? -1)).toBe(true)

    const tailDelta = manager.getJobProgressDelta(jobId, secondDelta?.nextCursor ?? -1, 50)
    expect(tailDelta).not.toBeNull()
    expect(tailDelta?.progress.length).toBeGreaterThanOrEqual(0)

    await fs.rm(outputDir, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('does not retry non-retryable runtime failures', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-noretry-'))
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-data-'))
    let attempts = 0

    const runtime: RuntimeAdapter = {
      checkRuntimeHealth: async () => ({
        dockerInstalled: true,
        dockerResponsive: true,
        zimitImagePresent: true,
        ready: true,
        message: 'ok',
      }),
      containerNameForJob: (jobId) => `zimple-${jobId.slice(0, 12)}`,
      ensureZimitImage: async () => false,
      runZimitOnce: async () => {
        attempts += 1
        return {
          success: false,
          errorMessage: 'zimit container failed with exit code 3.',
          retryable: false,
          exitCode: 3,
        }
      },
      stopContainer: async () => true,
      sleepForRetry: async () => undefined,
    }

    const manager = await JobManager.create(makeConfig(outputDir, dataDir), runtime)
    const request = makeRequest(outputDir)
    request.crawl.limits.retries = 3
    const { jobId } = await manager.startJob(request)

    expect(await waitForTerminalState(manager, jobId)).toBe('failed')
    const detail = manager.getJob(jobId)
    expect(detail?.summary.attempt).toBe(1)
    expect(attempts).toBe(1)
    expect(detail?.summary.errorMessage).toContain('exit code 3')

    await fs.rm(outputDir, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('pauses a running job and resumes it from checkpointed crawl state', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-pause-resume-'))
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-data-'))
    const checkpointHostPath = path.join(
      outputDir,
      '.tmp-pause',
      'collections',
      'capture',
      'crawls',
      'resume.yaml',
    )
    const checkpointContainerPath = '/output/.tmp-pause/collections/capture/crawls/resume.yaml'
    let stopRequested = false
    let runCount = 0
    const resumeConfigPaths: string[] = []

    const runtime: RuntimeAdapter = {
      checkRuntimeHealth: async () => ({
        dockerInstalled: true,
        dockerResponsive: true,
        zimitImagePresent: true,
        ready: true,
        message: 'ok',
      }),
      containerNameForJob: (jobId) => `zimple-${jobId.slice(0, 12)}`,
      ensureZimitImage: async () => false,
      runZimitOnce: async (
        _config,
        _request,
        outputDirectory,
        outputFilename,
        _containerName,
        onLog,
        onProcess,
        options,
      ) => {
        runCount += 1
        resumeConfigPaths.push(options?.resumeConfigPath ?? '')
        onProcess({ kill: () => undefined } as never)

        if (runCount === 1) {
          onLog('Output to tempdir: /output/.tmp-pause - will delete')
          await fs.mkdir(path.dirname(checkpointHostPath), { recursive: true })
          await fs.writeFile(checkpointHostPath, 'resume-state', 'utf8')
          onLog(`Saving crawl state to: ${checkpointContainerPath}`)

          while (!stopRequested) {
            await waitFor(25)
          }

          return {
            success: false,
            errorMessage: 'zimit container failed with exit code 15.',
            retryable: false,
            exitCode: 15,
          }
        }

        await fs.writeFile(path.join(outputDirectory, `${outputFilename}.zim`), 'zim')
        return { success: true }
      },
      stopContainer: async () => {
        stopRequested = true
        return true
      },
      sleepForRetry: async () => undefined,
    }

    const manager = await JobManager.create(makeConfig(outputDir, dataDir), runtime)
    const { jobId } = await manager.startJob(makeRequest(outputDir, 'https://example.com/blog'))

    await waitForState(manager, jobId, 'running')
    const pauseResponse = await manager.pauseJob(jobId)
    expect(pauseResponse.paused).toBe(true)
    await waitForState(manager, jobId, 'paused')

    const persistedRaw = await fs.readFile(path.join(dataDir, 'jobs-state.json'), 'utf8')
    expect(persistedRaw).toContain('"state": "paused"')
    expect(persistedRaw).toContain(checkpointHostPath)

    const resumeResponse = await manager.resumeJob(jobId)
    expect(resumeResponse.resumed).toBe(true)

    expect(await waitForTerminalState(manager, jobId)).toBe('succeeded')
    expect(resumeConfigPaths.some((value) => value === checkpointHostPath)).toBe(true)

    await fs.rm(outputDir, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('fails resume when checkpoint is missing and provides guidance', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-resume-missing-'))
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-data-'))
    const checkpointHostPath = path.join(
      outputDir,
      '.tmp-missing',
      'collections',
      'capture',
      'crawls',
      'resume.yaml',
    )
    let stopRequested = false

    const runtime: RuntimeAdapter = {
      checkRuntimeHealth: async () => ({
        dockerInstalled: true,
        dockerResponsive: true,
        zimitImagePresent: true,
        ready: true,
        message: 'ok',
      }),
      containerNameForJob: (jobId) => `zimple-${jobId.slice(0, 12)}`,
      ensureZimitImage: async () => false,
      runZimitOnce: async (
        _config,
        _request,
        _outputDirectory,
        _outputFilename,
        _containerName,
        onLog,
      ) => {
        onLog('Output to tempdir: /output/.tmp-missing - will delete')
        await fs.mkdir(path.dirname(checkpointHostPath), { recursive: true })
        await fs.writeFile(checkpointHostPath, 'resume-state', 'utf8')
        onLog('Saving crawl state to: /output/.tmp-missing/collections/capture/crawls/resume.yaml')

        while (!stopRequested) {
          await waitFor(25)
        }

        return {
          success: false,
          errorMessage: 'zimit container failed with exit code 15.',
          retryable: false,
          exitCode: 15,
        }
      },
      stopContainer: async () => {
        stopRequested = true
        return true
      },
      sleepForRetry: async () => undefined,
    }

    const manager = await JobManager.create(makeConfig(outputDir, dataDir), runtime)
    const { jobId } = await manager.startJob(makeRequest(outputDir, 'https://example.com/path'))

    await waitForState(manager, jobId, 'running')
    expect((await manager.pauseJob(jobId)).paused).toBe(true)
    await waitForState(manager, jobId, 'paused')

    await fs.rm(checkpointHostPath, { force: true })

    const resume = await manager.resumeJob(jobId)
    expect(resume.resumed).toBe(false)
    expect(resume.message).toMatch(/checkpoint/i)
    await waitForState(manager, jobId, 'failed')

    await fs.rm(outputDir, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('recovers interrupted running jobs on restart as paused when checkpoint exists', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-recover-output-'))
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-recover-data-'))
    const now = new Date().toISOString()
    const checkpointHostPath = path.join(
      outputDir,
      '.tmp-recover',
      'collections',
      'capture',
      'crawls',
      'resume.yaml',
    )
    await fs.mkdir(path.dirname(checkpointHostPath), { recursive: true })
    await fs.writeFile(checkpointHostPath, 'resume-state', 'utf8')

    const baseRequest = makeRequest(outputDir)
    const runningResumableId = 'job-running-resumable'
    const runningLostId = 'job-running-lost'

    const stateFile = {
      version: 1,
      updatedAt: now,
      queue: [],
      jobs: [
        {
          summary: {
            id: runningResumableId,
            url: 'https://example.com/resumable',
            state: 'running',
            createdAt: now,
            startedAt: now,
            finishedAt: null,
            outputPath: null,
            errorMessage: null,
            attempt: 1,
          },
          request: baseRequest,
          logs: [],
          progress: [],
          outputDirectory: outputDir,
          outputFilename: 'resumable',
          containerName: 'zimple-resumable',
          resumeState: {
            tempDirectory: path.join(outputDir, '.tmp-recover'),
            checkpointPath: checkpointHostPath,
          },
        },
        {
          summary: {
            id: runningLostId,
            url: 'https://example.com/lost',
            state: 'running',
            createdAt: now,
            startedAt: now,
            finishedAt: null,
            outputPath: null,
            errorMessage: null,
            attempt: 1,
          },
          request: baseRequest,
          logs: [],
          progress: [],
          outputDirectory: outputDir,
          outputFilename: 'lost',
          containerName: 'zimple-lost',
          resumeState: {
            tempDirectory: path.join(outputDir, '.tmp-lost'),
            checkpointPath: path.join(
              outputDir,
              '.tmp-lost',
              'collections',
              'capture',
              'crawls',
              'missing.yaml',
            ),
          },
        },
      ],
    }

    await fs.writeFile(
      path.join(dataDir, 'jobs-state.json'),
      JSON.stringify(stateFile, null, 2),
      'utf8',
    )

    const runtime: RuntimeAdapter = {
      checkRuntimeHealth: async () => ({
        dockerInstalled: true,
        dockerResponsive: true,
        zimitImagePresent: true,
        ready: true,
        message: 'ok',
      }),
      containerNameForJob: (jobId) => `zimple-${jobId.slice(0, 12)}`,
      ensureZimitImage: async () => false,
      runZimitOnce: async () => ({ success: true }),
      stopContainer: async () => true,
      sleepForRetry: async () => undefined,
    }

    const manager = await JobManager.create(makeConfig(outputDir, dataDir), runtime)

    expect(manager.getJob(runningResumableId)?.summary.state).toBe('paused')
    expect(manager.getJob(runningLostId)?.summary.state).toBe('failed')
    expect(manager.getJob(runningLostId)?.summary.errorMessage).toMatch(/restart/i)

    await fs.rm(outputDir, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('clearQueue removes succeeded/failed/cancelled while keeping queued/running', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-jobs-'))
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-data-'))

    let releaseSlow: (() => void) | null = null
    let slowGate: Promise<void> | null = null

    const runtime: RuntimeAdapter = {
      checkRuntimeHealth: async () => ({
        dockerInstalled: true,
        dockerResponsive: true,
        zimitImagePresent: true,
        ready: true,
        message: 'ok',
      }),
      containerNameForJob: (jobId) => `zimple-${jobId.slice(0, 12)}`,
      ensureZimitImage: async () => false,
      runZimitOnce: async (_config, request, outputDirectory, outputFilename) => {
        if (request.url.includes('/fail')) {
          return {
            success: false,
            errorMessage: 'forced failure',
            retryable: false,
            exitCode: 2,
          }
        }

        if (request.url.includes('/slow')) {
          if (!slowGate) {
            slowGate = new Promise<void>((resolve) => {
              releaseSlow = () => resolve()
            })
          }
          await slowGate
        }

        await fs.writeFile(path.join(outputDirectory, `${outputFilename}.zim`), 'zim')
        return { success: true }
      },
      stopContainer: async () => true,
      sleepForRetry: async () => undefined,
    }

    const manager = await JobManager.create(makeConfig(outputDir, dataDir), runtime)

    const succeeded = await manager.startJob(makeRequest(outputDir, 'https://example.com/ok'))
    expect(await waitForTerminalState(manager, succeeded.jobId)).toBe('succeeded')

    const failed = await manager.startJob(makeRequest(outputDir, 'https://example.com/fail'))
    expect(await waitForTerminalState(manager, failed.jobId)).toBe('failed')

    const running = await manager.startJob(makeRequest(outputDir, 'https://example.com/slow'))
    await waitForState(manager, running.jobId, 'running')

    const cancelled = await manager.startJob(makeRequest(outputDir, 'https://example.com/cancel'))
    expect((await manager.cancelJob(cancelled.jobId)).cancelled).toBe(true)
    expect(await waitForTerminalState(manager, cancelled.jobId)).toBe('cancelled')

    const queued = await manager.startJob(makeRequest(outputDir, 'https://example.com/queued'))
    await waitForState(manager, queued.jobId, 'queued')

    const clearResult = manager.clearQueue()
    expect(clearResult.removed).toBe(3)

    expect(manager.getJob(succeeded.jobId)).toBeNull()
    expect(manager.getJob(failed.jobId)).toBeNull()
    expect(manager.getJob(cancelled.jobId)).toBeNull()
    expect(manager.getJob(running.jobId)?.summary.state).toBe('running')
    expect(manager.getJob(queued.jobId)?.summary.state).toBe('queued')

    if (releaseSlow) {
      releaseSlow()
      expect(await waitForTerminalState(manager, running.jobId)).toBe('succeeded')
    }

    await fs.rm(outputDir, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('continues processing queued jobs when an unexpected worker-loop error occurs', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-jobs-'))
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-web-data-'))

    const runtime: RuntimeAdapter = {
      checkRuntimeHealth: async () => ({
        dockerInstalled: true,
        dockerResponsive: true,
        zimitImagePresent: true,
        ready: true,
        message: 'ok',
      }),
      containerNameForJob: (jobId) => `zimple-${jobId.slice(0, 12)}`,
      ensureZimitImage: async () => false,
      runZimitOnce: async (_config, _request, runtimeOutputDirectory, outputFilename) => {
        await fs.writeFile(path.join(runtimeOutputDirectory, `${outputFilename}.zim`), 'zim')
        return { success: true }
      },
      stopContainer: async () => true,
      sleepForRetry: async () => undefined,
    }

    const manager = await JobManager.create(makeConfig(outputDir, dataDir), runtime)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const originalRecordProgress = (manager as any).recordProgress.bind(manager)
    let injectFailure = true
    ;(manager as any).recordProgress = (...args: unknown[]) => {
      const stage = args[1]
      if (injectFailure && stage === 'running') {
        injectFailure = false
        throw new Error('synthetic worker-loop failure')
      }
      return originalRecordProgress(...args)
    }

    const first = await manager.startJob(makeRequest(outputDir, 'https://example.com/first'))
    const second = await manager.startJob(makeRequest(outputDir, 'https://example.com/second'))

    expect(await waitForTerminalState(manager, first.jobId)).toBe('failed')
    expect(await waitForTerminalState(manager, second.jobId)).toBe('succeeded')
    expect(errorSpy).toHaveBeenCalled()

    errorSpy.mockRestore()
    await fs.rm(outputDir, { recursive: true, force: true })
    await fs.rm(dataDir, { recursive: true, force: true })
  })
})
