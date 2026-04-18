// @vitest-environment node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { JobManager } from './job-manager.js'
import type { RuntimeAdapter } from './job-manager.js'
import type { StartJobRequest, WebApiConfig } from './types.js'

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
  port: 8080,
  outputDirectory,
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

    const cancelResponse = await manager.cancelJob(second.jobId)
    expect(cancelResponse.cancelled).toBe(true)

    if (typeof releaseFirstJob === 'function') {
      releaseFirstJob()
    }

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
})
