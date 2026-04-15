import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from './App'
import type {
  BackendClient,
} from './lib/backend'
import type {
  JobDetail,
  JobSummary,
  RuntimeHealth,
  Settings,
  StartJobRequest,
  StartJobResponse,
} from './lib/types'

const runtimeHealth: RuntimeHealth = {
  dockerInstalled: true,
  dockerResponsive: true,
  zimitImagePresent: true,
  ready: true,
  message: null,
}

const settings: Settings = {
  outputDirectory: '/tmp/zimple',
  autoOpenOnSuccess: true,
}

const makeBackend = (overrides?: Partial<Settings>): BackendClient => {
  const jobs: JobSummary[] = []
  const effectiveSettings: Settings = {
    ...settings,
    ...overrides,
  }

  return {
    startJob: vi.fn(async (request: StartJobRequest): Promise<StartJobResponse> => {
      jobs.unshift({
        id: 'job-1',
        url: request.url,
        state: 'queued',
        createdAt: new Date().toISOString(),
        attempt: 1,
        outputPath: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
      })
      return { jobId: 'job-1' }
    }),
    listJobs: vi.fn(async () => jobs),
    getJob: vi.fn(async (jobId: string): Promise<JobDetail> => ({
      summary:
        jobs.find((job) => job.id === jobId) ??
        ({
          id: jobId,
          url: 'https://example.com',
          state: 'queued',
          createdAt: new Date().toISOString(),
          attempt: 1,
        } as JobSummary),
      request: {
        url: 'https://example.com',
        crawl: {
          respectRobots: true,
          workers: 4,
          includePatterns: [],
          excludePatterns: [],
          limits: {
            maxPages: 2000,
            maxDepth: 5,
            maxTotalSizeMb: 2048,
            maxAssetSizeMb: 50,
            timeoutMinutes: 120,
            retries: 3,
          },
        },
      },
      logs: [],
      progress: [],
    })),
    cancelJob: vi.fn(async () => ({ cancelled: true })),
    openOutput: vi.fn(async () => ({ opened: true })),
    getRuntimeHealth: vi.fn(async () => runtimeHealth),
    getSettings: vi.fn(async () => effectiveSettings),
    setSettings: vi.fn(async (nextSettings: Settings) => nextSettings),
    pickOutputDirectory: vi.fn(async () => effectiveSettings.outputDirectory ?? null),
    onJobProgress: vi.fn(async () => () => {}),
    onJobStateChanged: vi.fn(async () => () => {}),
    onRuntimeHealthChanged: vi.fn(async () => () => {}),
  }
}

describe('App', () => {
  it('submits a URL and queues a job', async () => {
    const backend = makeBackend()

    render(<App backend={backend} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add Job' }))

    const urlInput = await screen.findByLabelText('website-url')
    fireEvent.change(urlInput, { target: { value: 'https://example.com' } })

    fireEvent.click(screen.getByRole('button', { name: 'Start Processing' }))

    await waitFor(() => {
      expect(backend.startJob).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://example.com' }),
      )
    })

    expect(await screen.findByText(/Job queued:/)).toBeInTheDocument()
  })

  it('toggles advanced controls', async () => {
    render(<App backend={makeBackend()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add Job' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Show Advanced' }))

    expect(await screen.findByLabelText('advanced-options')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Hide Advanced' }))

    await waitFor(() => {
      expect(screen.queryByLabelText('advanced-options')).not.toBeInTheDocument()
    })
  })

  it('allows queueing when override and default output directories are blank in the UI', async () => {
    const backend = makeBackend({ outputDirectory: null })

    render(<App backend={backend} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add Job' }))

    const urlInput = await screen.findByLabelText('website-url')
    fireEvent.change(urlInput, { target: { value: 'https://example.com' } })

    fireEvent.click(screen.getByRole('button', { name: 'Start Processing' }))

    await waitFor(() => {
      expect(backend.startJob).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.com',
          outputDirectory: null,
        }),
      )
    })
  })
})
