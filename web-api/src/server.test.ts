// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createServer } from './server.js'
import type { JobManager } from './job-manager.js'
import type { WebApiConfig } from './types.js'

const config: WebApiConfig = {
  bindAddress: '127.0.0.1',
  port: 8000,
  outputDirectory: '/tmp/zimple-output',
  stagingDirectory: null,
  dataDirectory: '/tmp/zimple-data',
  dockerSocketPath: '/var/run/docker.sock',
  zimitImage: 'ghcr.io/openzim/zimit',
  dockerHost: null,
}

describe('server api endpoints', () => {
  it('returns progress deltas with cursor query parameters', async () => {
    const getJobProgressDelta = vi.fn(() => ({
      summary: {
        id: 'job-1',
        url: 'https://example.com',
        state: 'running',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        finishedAt: null,
        outputPath: null,
        errorMessage: null,
        attempt: 1,
      },
      progress: [
        {
          jobId: 'job-1',
          stage: 'log',
          message: 'Crawl progress: 10/200 crawled, 190 pending, 0 failed',
          timestamp: new Date().toISOString(),
        },
      ],
      nextCursor: 11,
    }))

    const manager = {
      getRuntimeHealth: vi.fn(),
      getSettings: vi.fn(),
      setSettings: vi.fn(),
      startJob: vi.fn(),
      listJobs: vi.fn(),
      getJob: vi.fn(),
      getJobProgressDelta,
      cancelJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      clearQueue: vi.fn(() => ({ removed: 2 })),
      getOutputPath: vi.fn(),
      getOutputFilename: vi.fn(),
      getOutputMimeType: vi.fn(),
    } as unknown as JobManager

    const app = await createServer(config, { manager })

    const response = await app.inject({
      method: 'GET',
      url: '/api/jobs/job-1/progress?after=10&limit=30',
    })

    expect(response.statusCode).toBe(200)
    expect(getJobProgressDelta).toHaveBeenCalledWith('job-1', 10, 30)

    const payload = response.json()
    expect(payload.nextCursor).toBe(11)
    expect(payload.progress).toHaveLength(1)

    await app.close()
  })

  it('clears completed and terminal jobs', async () => {
    const clearQueue = vi.fn(() => ({ removed: 3 }))
    const manager = {
      getRuntimeHealth: vi.fn(),
      getSettings: vi.fn(),
      setSettings: vi.fn(),
      startJob: vi.fn(),
      listJobs: vi.fn(),
      getJob: vi.fn(),
      getJobProgressDelta: vi.fn(),
      cancelJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      clearQueue,
      getOutputPath: vi.fn(),
      getOutputFilename: vi.fn(),
      getOutputMimeType: vi.fn(),
    } as unknown as JobManager

    const app = await createServer(config, { manager })
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs/clear-terminal',
    })

    expect(response.statusCode).toBe(200)
    expect(clearQueue).toHaveBeenCalledTimes(1)
    expect(response.json()).toEqual({ removed: 3 })

    await app.close()
  })

  it('routes pause and resume job actions', async () => {
    const pauseJob = vi.fn(async () => ({ paused: true }))
    const resumeJob = vi.fn(async () => ({ resumed: true }))
    const manager = {
      getRuntimeHealth: vi.fn(),
      getSettings: vi.fn(),
      setSettings: vi.fn(),
      startJob: vi.fn(),
      listJobs: vi.fn(),
      getJob: vi.fn(),
      getJobProgressDelta: vi.fn(),
      cancelJob: vi.fn(),
      pauseJob,
      resumeJob,
      clearQueue: vi.fn(() => ({ removed: 0 })),
      getOutputPath: vi.fn(),
      getOutputFilename: vi.fn(),
      getOutputMimeType: vi.fn(),
    } as unknown as JobManager

    const app = await createServer(config, { manager })

    const pauseResponse = await app.inject({
      method: 'POST',
      url: '/api/jobs/job-1/pause',
    })
    expect(pauseResponse.statusCode).toBe(200)
    expect(pauseJob).toHaveBeenCalledWith('job-1')
    expect(pauseResponse.json()).toEqual({ paused: true })

    const resumeResponse = await app.inject({
      method: 'POST',
      url: '/api/jobs/job-1/resume',
    })
    expect(resumeResponse.statusCode).toBe(200)
    expect(resumeJob).toHaveBeenCalledWith('job-1')
    expect(resumeResponse.json()).toEqual({ resumed: true })

    await app.close()
  })
})
