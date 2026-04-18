// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createServer } from './server.js'
import type { JobManager } from './job-manager.js'
import type { WebApiConfig } from './types.js'

const config: WebApiConfig = {
  bindAddress: '127.0.0.1',
  port: 8080,
  outputDirectory: '/tmp/zimple-output',
  dataDirectory: '/tmp/zimple-data',
  dockerSocketPath: '/var/run/docker.sock',
  zimitImage: 'ghcr.io/openzim/zimit',
  dockerHost: null,
}

describe('server progress endpoint', () => {
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
})
