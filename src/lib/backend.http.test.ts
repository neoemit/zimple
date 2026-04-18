import { describe, expect, it, vi } from 'vitest'
import { HttpBackendClient } from './backend'
import type { StartJobRequest } from './types'

const request: StartJobRequest = {
  url: 'https://example.com',
  outputDirectory: '/tmp/zimple-output',
  outputFilename: 'example',
  crawl: {
    respectRobots: true,
    workers: 4,
    includePatterns: [],
    excludePatterns: [],
    limits: {
      maxPages: 1500,
      maxDepth: 5,
      maxTotalSizeMb: 4096,
      maxAssetSizeMb: 50,
      timeoutMinutes: 180,
      retries: 2,
    },
  },
}

describe('HttpBackendClient', () => {
  it('submits jobs through the HTTP API', async () => {
    const client = new HttpBackendClient('http://127.0.0.1:8080')
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ jobId: 'job-123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

    vi.stubGlobal('fetch', fetchMock)

    const response = await client.startJob(request)
    expect(response.jobId).toBe('job-123')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/api/jobs',
      expect.objectContaining({
        method: 'POST',
      }),
    )
  })

  it('opens output downloads through the API endpoint', async () => {
    const client = new HttpBackendClient('http://127.0.0.1:8080')
    const openMock = vi.fn(() => ({ closed: false }))
    vi.stubGlobal('open', openMock)
    window.open = openMock as unknown as typeof window.open

    const response = await client.openOutput('job-999')
    expect(response.opened).toBe(true)
    expect(openMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/api/jobs/job-999/output',
      '_blank',
      'noopener,noreferrer',
    )
  })

  it('calls clear-terminal endpoint for queue cleanup', async () => {
    const client = new HttpBackendClient('http://127.0.0.1:8080')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ removed: 4 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await client.clearQueue()
    expect(response.removed).toBe(4)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/api/jobs/clear-terminal',
      expect.objectContaining({
        method: 'POST',
      }),
    )
  })

  it('calls pause endpoint for running jobs', async () => {
    const client = new HttpBackendClient('http://127.0.0.1:8080')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ paused: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await client.pauseJob('job-7')
    expect(response.paused).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/api/jobs/job-7/pause',
      expect.objectContaining({
        method: 'POST',
      }),
    )
  })

  it('calls resume endpoint for paused jobs', async () => {
    const client = new HttpBackendClient('http://127.0.0.1:8080')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ resumed: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await client.resumeJob('job-8')
    expect(response.resumed).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/api/jobs/job-8/resume',
      expect.objectContaining({
        method: 'POST',
      }),
    )
  })
})
