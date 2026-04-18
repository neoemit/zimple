import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { BackendClient } from './lib/backend'
import type {
  BackendCapabilities,
  JobDetail,
  JobSummary,
  ProgressEvent as JobProgressEvent,
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

const defaultCapabilities: BackendCapabilities = {
  platform: 'http',
  outputActionLabel: 'Download Output',
  supportsDirectoryPicker: false,
}

interface BackendOptions {
  settingsOverride?: Partial<Settings>
  capabilities?: BackendCapabilities
  jobs?: JobSummary[]
  details?: Record<string, JobDetail>
}

const makeBackend = (options: BackendOptions = {}): BackendClient => {
  const jobs: JobSummary[] = [...(options.jobs ?? [])]
  const details = new Map<string, JobDetail>(Object.entries(options.details ?? {}))
  const effectiveSettings: Settings = {
    ...settings,
    ...options.settingsOverride,
  }
  const capabilities = options.capabilities ?? defaultCapabilities

  let sequence = 0

  return {
    getCapabilities: vi.fn(() => capabilities),
    startJob: vi.fn(async (request: StartJobRequest): Promise<StartJobResponse> => {
      sequence += 1
      const id = `job-${sequence}`
      const summary: JobSummary = {
        id,
        url: request.url,
        state: 'queued',
        createdAt: new Date().toISOString(),
        attempt: 1,
        outputPath: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
      }

      jobs.unshift(summary)
      details.set(id, {
        summary,
        request,
        logs: [],
        progress: [],
      })

      return { jobId: id }
    }),
    listJobs: vi.fn(async () => [...jobs]),
    getJob: vi.fn(async (jobId: string): Promise<JobDetail> => {
      const seeded = details.get(jobId)
      if (seeded) {
        return structuredClone(seeded)
      }

      const summary =
        jobs.find((job) => job.id === jobId) ??
        ({
          id: jobId,
          url: 'https://example.com',
          state: 'queued',
          createdAt: new Date().toISOString(),
          attempt: 1,
        } as JobSummary)

      return {
        summary,
        request: {
          url: summary.url,
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
        },
        logs: [],
        progress: [],
      }
    }),
    cancelJob: vi.fn(async () => ({ cancelled: true })),
    pauseJob: vi.fn(async (jobId: string) => {
      const target = jobs.find((job) => job.id === jobId)
      if (!target || target.state !== 'running') {
        return {
          paused: false,
          message: 'Only running jobs can be paused.',
        }
      }

      target.state = 'paused'
      return { paused: true }
    }),
    resumeJob: vi.fn(async (jobId: string) => {
      const target = jobs.find((job) => job.id === jobId)
      if (!target || target.state !== 'paused') {
        return {
          resumed: false,
          message: 'Only paused jobs can be resumed.',
        }
      }

      target.state = 'queued'
      return { resumed: true }
    }),
    clearQueue: vi.fn(async () => {
      const removableIds = new Set(
        jobs
          .filter(
            (job) =>
              job.state === 'succeeded' ||
              job.state === 'failed' ||
              job.state === 'cancelled',
          )
          .map((job) => job.id),
      )
      const removed = removableIds.size
      for (const id of removableIds) {
        details.delete(id)
      }

      const remaining = jobs.filter((job) => !removableIds.has(job.id))
      jobs.splice(0, jobs.length, ...remaining)

      return { removed }
    }),
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

const mockMediaQueries = (options: { small: boolean; short?: boolean }): void => {
  const short = options.short ?? false
  const matchMedia = vi.fn((query: string) => ({
      matches: query.includes('max-width') ? options.small : short,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))

  vi.stubGlobal('matchMedia', matchMedia)
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: matchMedia,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: undefined,
  })
})

describe('App', () => {
  it('keeps Add Job in the queue sidebar and not in the header', async () => {
    render(<App backend={makeBackend()} />)

    const header = await screen.findByLabelText('app-header')
    expect(within(header).queryByRole('button', { name: 'Add Job' })).not.toBeInTheDocument()

    expect(screen.getByLabelText('job-queue')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add Job' })).toBeInTheDocument()
  })

  it('opens create-job modal and queues a job', async () => {
    const backend = makeBackend()

    render(<App backend={backend} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add Job' }))

    expect(await screen.findByLabelText('create-job-modal')).toBeInTheDocument()

    const urlInput = screen.getByLabelText('website-url')
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

    expect(await screen.findByText(/Job queued:/)).toBeInTheDocument()
  })

  it('does not render queue/detail tab switching controls', async () => {
    render(<App backend={makeBackend()} />)

    await screen.findByLabelText('app-header')
    expect(screen.queryByRole('tablist', { name: 'workspace-sections' })).not.toBeInTheDocument()
  })

  it('opens a collapsible queue side rail on narrow viewports', async () => {
    mockMediaQueries({ small: true })
    render(<App backend={makeBackend()} />)

    expect(await screen.findByLabelText('app-header')).toBeInTheDocument()
    expect(screen.queryByLabelText('job-queue')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Jobs' }))

    expect(await screen.findByLabelText('job-queue')).toBeInTheDocument()
    expect(screen.getByLabelText('job-detail')).toBeInTheDocument()
  })

  it('keeps optional fields collapsed by default in create flow', async () => {
    render(<App backend={makeBackend()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add Job' }))

    const optionalSummary = screen.getByText('Optional fields')
    const optionalDetails = optionalSummary.closest('details')
    expect(optionalDetails?.open).toBe(false)

    fireEvent.click(optionalSummary)

    expect(optionalDetails?.open).toBe(true)
  })

  it('shows advanced crawl controls only in capture settings modal', async () => {
    render(<App backend={makeBackend()} />)

    expect(screen.queryByLabelText('Workers')).not.toBeInTheDocument()

    fireEvent.click(await screen.findByRole('button', { name: 'Add Job' }))
    fireEvent.click(screen.getByRole('button', { name: 'Capture Settings' }))

    expect(await screen.findByLabelText('capture-settings-modal')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Limits and workers'))
    expect(await screen.findByLabelText('Workers')).toBeInTheDocument()
  })

  it('shows output directory only in app settings modal', async () => {
    render(<App backend={makeBackend()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add Job' }))
    expect(screen.queryByLabelText('default-output-directory')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('output-directory-override')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(await screen.findByLabelText('default-output-directory')).toBeInTheDocument()
  })

  it('saves app settings from the settings modal', async () => {
    const backend = makeBackend()

    render(<App backend={backend} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))

    const defaultDirInput = await screen.findByLabelText('default-output-directory')
    fireEvent.change(defaultDirInput, { target: { value: '/tmp/new-output' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }))

    await waitFor(() => {
      expect(backend.setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ outputDirectory: '/tmp/new-output' }),
      )
    })
  })

  it('keeps runtime logs collapsed for running jobs', async () => {
    const runningSummary: JobSummary = {
      id: 'job-running',
      url: 'https://example.com/docs',
      state: 'running',
      createdAt: new Date().toISOString(),
      attempt: 1,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outputPath: null,
      errorMessage: null,
    }

    const backend = makeBackend({
      jobs: [runningSummary],
      details: {
        'job-running': {
          summary: runningSummary,
          request: {
            url: runningSummary.url,
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
          },
          progress: [],
          logs: ['running log line'],
        },
      },
    })

    render(<App backend={backend} />)

    const runningLogsSummary = await screen.findByText('Runtime Logs')
    const runningLogsDetails = runningLogsSummary.closest('details')
    expect(runningLogsDetails?.open).toBe(false)
  })

  it('auto-expands runtime logs for failed jobs', async () => {
    const failedSummary: JobSummary = {
      id: 'job-failed',
      url: 'https://example.com/fail',
      state: 'failed',
      createdAt: new Date().toISOString(),
      attempt: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outputPath: null,
      errorMessage: 'boom',
    }

    const backend = makeBackend({
      jobs: [failedSummary],
      details: {
        'job-failed': {
          summary: failedSummary,
          request: {
            url: failedSummary.url,
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
          },
          progress: [],
          logs: ['failed log line'],
        },
      },
    })

    render(<App backend={backend} />)

    const failedLogsSummary = await screen.findByText('Runtime Logs')
    const failedLogsDetails = failedLogsSummary.closest('details')
    expect(failedLogsDetails?.open).toBe(true)
  })

  it('appends selected-job progress events without refetching full detail', async () => {
    const runningSummary: JobSummary = {
      id: 'job-running',
      url: 'https://example.com/blog',
      state: 'running',
      createdAt: new Date().toISOString(),
      attempt: 1,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outputPath: null,
      errorMessage: null,
    }

    const detail: JobDetail = {
      summary: runningSummary,
      request: {
        url: runningSummary.url,
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
      },
      progress: [],
      logs: [],
    }

    const getJobMock = vi.fn(async () => detail)
    const onJobProgressMock = vi.fn(
      async (handler: (event: JobProgressEvent) => void) => {
        void handler
        return () => {}
      },
    )
    const backend: BackendClient = {
      getCapabilities: vi.fn(() => defaultCapabilities),
      startJob: vi.fn(async () => ({ jobId: 'job-created' })),
      listJobs: vi.fn(async () => [runningSummary]),
      getJob: getJobMock,
      cancelJob: vi.fn(async () => ({ cancelled: true })),
      pauseJob: vi.fn(async () => ({ paused: true })),
      resumeJob: vi.fn(async () => ({ resumed: true })),
      clearQueue: vi.fn(async () => ({ removed: 0 })),
      openOutput: vi.fn(async () => ({ opened: true })),
      getRuntimeHealth: vi.fn(async () => runtimeHealth),
      getSettings: vi.fn(async () => settings),
      setSettings: vi.fn(async (nextSettings: Settings) => nextSettings),
      pickOutputDirectory: vi.fn(async () => settings.outputDirectory ?? null),
      onJobProgress: onJobProgressMock,
      onJobStateChanged: vi.fn(async () => () => {}),
      onRuntimeHealthChanged: vi.fn(async () => () => {}),
    }

    render(<App backend={backend} />)

    await screen.findByLabelText('job-detail')
    await waitFor(() => {
      expect(onJobProgressMock).toHaveBeenCalled()
      expect(backend.getJob).toHaveBeenCalled()
    })

    const callsBefore = getJobMock.mock.calls.length
    const latestProgressSubscription = onJobProgressMock.mock.calls.at(-1)
    const emitProgress = latestProgressSubscription?.[0] as
      | ((event: JobProgressEvent) => void)
      | undefined
    expect(emitProgress).toBeDefined()
    emitProgress?.({
      jobId: 'job-running',
      stage: 'log',
      message: 'Crawl progress: 12/100 crawled, 88 pending, 0 failed',
      timestamp: new Date().toISOString(),
      attempt: 1,
    })

    await waitFor(() => {
      expect(screen.getByText('12 / 100 pages')).toBeInTheDocument()
    })
    expect(getJobMock.mock.calls.length).toBe(callsBefore)
  })

  it('clears succeeded, failed, and cancelled jobs from queue via clear action', async () => {
    const now = new Date().toISOString()
    const runningSummary: JobSummary = {
      id: 'job-running',
      url: 'https://example.com/running',
      state: 'running',
      createdAt: now,
      attempt: 1,
      startedAt: now,
      finishedAt: null,
      outputPath: null,
      errorMessage: null,
    }
    const succeededSummary: JobSummary = {
      id: 'job-succeeded',
      url: 'https://example.com/succeeded',
      state: 'succeeded',
      createdAt: now,
      attempt: 1,
      startedAt: now,
      finishedAt: now,
      outputPath: '/tmp/zimple/succeeded.zim',
      errorMessage: null,
    }
    const failedSummary: JobSummary = {
      id: 'job-failed',
      url: 'https://example.com/failed',
      state: 'failed',
      createdAt: now,
      attempt: 1,
      startedAt: now,
      finishedAt: now,
      outputPath: null,
      errorMessage: 'boom',
    }
    const cancelledSummary: JobSummary = {
      id: 'job-cancelled',
      url: 'https://example.com/cancelled',
      state: 'cancelled',
      createdAt: now,
      attempt: 1,
      startedAt: now,
      finishedAt: now,
      outputPath: null,
      errorMessage: null,
    }

    const backend = makeBackend({
      jobs: [runningSummary, succeededSummary, failedSummary, cancelledSummary],
    })

    render(<App backend={backend} />)

    expect(await screen.findByText('https://example.com/succeeded')).toBeInTheDocument()
    expect(await screen.findByText('https://example.com/failed')).toBeInTheDocument()
    expect(screen.getByText('https://example.com/cancelled')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Clear Queue/ }))

    await waitFor(() => {
      expect(backend.clearQueue).toHaveBeenCalledTimes(1)
    })

    await waitFor(() => {
      expect(screen.queryByText('https://example.com/succeeded')).not.toBeInTheDocument()
      expect(screen.queryByText('https://example.com/failed')).not.toBeInTheDocument()
      expect(screen.queryByText('https://example.com/cancelled')).not.toBeInTheDocument()
    })

    expect(screen.getAllByText('https://example.com/running').length).toBeGreaterThan(0)
  })

  it('shows clear queue control even when there are no clearable jobs', async () => {
    const now = new Date().toISOString()
    const runningSummary: JobSummary = {
      id: 'job-running',
      url: 'https://example.com/running',
      state: 'running',
      createdAt: now,
      attempt: 1,
      startedAt: now,
      finishedAt: null,
      outputPath: null,
      errorMessage: null,
    }

    const backend = makeBackend({
      jobs: [runningSummary],
    })

    render(<App backend={backend} />)

    expect(await screen.findByLabelText('job-queue')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear Queue (0)' })).toBeInTheDocument()
  })

  it('supports pause and resume actions for running and paused jobs', async () => {
    const now = new Date().toISOString()
    const runningSummary: JobSummary = {
      id: 'job-running',
      url: 'https://example.com/running',
      state: 'running',
      createdAt: now,
      attempt: 1,
      startedAt: now,
      finishedAt: null,
      outputPath: null,
      errorMessage: null,
    }
    const pausedSummary: JobSummary = {
      id: 'job-paused',
      url: 'https://example.com/paused',
      state: 'paused',
      createdAt: now,
      attempt: 1,
      startedAt: now,
      finishedAt: null,
      outputPath: null,
      errorMessage: null,
    }

    const backend = makeBackend({
      jobs: [runningSummary, pausedSummary],
      details: {
        [runningSummary.id]: {
          summary: runningSummary,
          request: {
            url: runningSummary.url,
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
          },
          logs: [],
          progress: [],
        },
        [pausedSummary.id]: {
          summary: pausedSummary,
          request: {
            url: pausedSummary.url,
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
          },
          logs: [],
          progress: [],
        },
      },
    })

    render(<App backend={backend} />)

    const pauseButtons = await screen.findAllByRole('button', { name: 'Pause' })
    fireEvent.click(pauseButtons[0])

    await waitFor(() => {
      expect(backend.pauseJob).toHaveBeenCalledWith('job-running')
    })

    const pausedQueueRow = screen
      .getByText('https://example.com/paused')
      .closest('li')
    if (!pausedQueueRow) {
      throw new Error('Expected paused queue row to exist')
    }
    fireEvent.click(within(pausedQueueRow).getByRole('button', { name: 'Resume' }))
    await waitFor(() => {
      expect(backend.resumeJob).toHaveBeenCalledWith('job-paused')
    })
  })

  it('shows timeout insight below progress for running jobs', async () => {
    const now = Date.now()
    const startedAt = new Date(now - 90_000).toISOString()
    const runningSummary: JobSummary = {
      id: 'job-timeout-insight',
      url: 'https://example.com/insight',
      state: 'running',
      createdAt: startedAt,
      attempt: 1,
      startedAt,
      finishedAt: null,
      outputPath: null,
      errorMessage: null,
    }

    const backend = makeBackend({
      jobs: [runningSummary],
      details: {
        [runningSummary.id]: {
          summary: runningSummary,
          request: {
            url: runningSummary.url,
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
          },
          progress: [
            {
              jobId: runningSummary.id,
              stage: 'attempt',
              message: 'Attempt 1 of 3 started',
              timestamp: startedAt,
              attempt: 1,
            },
            {
              jobId: runningSummary.id,
              stage: 'log',
              message: 'Crawl progress: 14/210 crawled, 196 pending, 0 failed',
              timestamp: new Date(now - 20_000).toISOString(),
              attempt: 1,
            },
          ],
          logs: [],
        },
      },
    })

    render(<App backend={backend} />)

    await screen.findByLabelText('crawl-status')
    expect(screen.getByText(/Attempt runtime/)).toBeInTheDocument()
    expect(screen.getByText(/Last crawler activity/)).toBeInTheDocument()
  })

  it('shows runtime logs only, newest first, capped at five entries', async () => {
    const now = Date.now()
    const runningSummary: JobSummary = {
      id: 'job-logs',
      url: 'https://example.com/logs',
      state: 'running',
      createdAt: new Date(now).toISOString(),
      attempt: 1,
      startedAt: new Date(now - 120_000).toISOString(),
      finishedAt: null,
      outputPath: null,
      errorMessage: null,
    }

    const progress = Array.from({ length: 6 }).map((_, index) => ({
      jobId: runningSummary.id,
      stage: 'log',
      message: `log event ${index + 1}`,
      timestamp: new Date(now - (5 - index) * 1000).toISOString(),
      attempt: 1,
    }))

    const backend = makeBackend({
      jobs: [runningSummary],
      details: {
        [runningSummary.id]: {
          summary: runningSummary,
          request: {
            url: runningSummary.url,
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
          },
          progress,
          logs: [],
        },
      },
    })

    render(<App backend={backend} />)

    expect(screen.queryByText('Event Timeline')).not.toBeInTheDocument()
    const logsSummary = await screen.findByText('Runtime Logs')
    fireEvent.click(logsSummary)

    const logList = await screen.findByRole('log')
    const logItems = within(logList).getAllByRole('listitem')
    expect(logItems).toHaveLength(5)
    expect(logItems[0]).toHaveTextContent('log event 6')
    expect(screen.queryByText('log event 1')).not.toBeInTheDocument()
  })

  it('sends a web notification when a running job completes', async () => {
    const now = new Date().toISOString()
    const runningSummary: JobSummary = {
      id: 'job-notify',
      url: 'https://example.com/notify',
      state: 'running',
      createdAt: now,
      attempt: 1,
      startedAt: now,
      finishedAt: null,
      outputPath: null,
      errorMessage: null,
    }
    const succeededSummary: JobSummary = {
      ...runningSummary,
      state: 'succeeded',
      finishedAt: new Date().toISOString(),
      outputPath: '/tmp/notify.zim',
    }

    const notificationSpy = vi.fn()
    class NotificationMock {
      static permission: NotificationPermission = 'granted'

      static requestPermission = vi.fn(
        async (): Promise<NotificationPermission> => 'granted',
      )

      constructor(title: string, options?: NotificationOptions) {
        notificationSpy(title, options)
      }
    }
    vi.stubGlobal('Notification', NotificationMock as unknown as typeof Notification)

    let emitState: ((event: JobSummary) => void) | null = null
    const onJobStateChanged = vi.fn(
      async (handler: (event: JobSummary) => void) => {
        emitState = handler
        return () => {}
      },
    )

    const backend = makeBackend({
      jobs: [runningSummary],
      details: {
        [runningSummary.id]: {
          summary: runningSummary,
          request: {
            url: runningSummary.url,
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
          },
          logs: [],
          progress: [],
        },
      },
    })
    backend.onJobStateChanged = onJobStateChanged

    render(<App backend={backend} />)

    await waitFor(() => {
      expect(onJobStateChanged).toHaveBeenCalled()
      expect(emitState).not.toBeNull()
    })

    if (typeof emitState !== 'function') {
      throw new Error('Expected onJobStateChanged handler to be registered')
    }
    ;(emitState as (event: JobSummary) => void)(succeededSummary)

    await waitFor(() => {
      expect(notificationSpy).toHaveBeenCalledTimes(1)
      expect(notificationSpy).toHaveBeenCalledWith(
        expect.stringMatching(/succeeded/i),
        expect.objectContaining({
          tag: 'zimple-job-job-notify',
        }),
      )
    })
  })

  it.each([
    [
      {
        platform: 'mock',
        outputActionLabel: 'Open Output',
        supportsDirectoryPicker: false,
      } satisfies BackendCapabilities,
      'Open Output',
    ],
    [
      {
        platform: 'http',
        outputActionLabel: 'Download Output',
        supportsDirectoryPicker: false,
      } satisfies BackendCapabilities,
      'Download Output',
    ],
  ])('uses capability-driven output action labels', async (capabilities, expectedLabel) => {
    const succeededSummary: JobSummary = {
      id: `job-${capabilities.platform}`,
      url: 'https://example.com',
      state: 'succeeded',
      createdAt: new Date().toISOString(),
      attempt: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outputPath: '/tmp/example.zim',
      errorMessage: null,
    }

    const backend = makeBackend({
      capabilities,
      jobs: [succeededSummary],
      details: {
        [succeededSummary.id]: {
          summary: succeededSummary,
          request: {
            url: succeededSummary.url,
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
          },
          logs: [],
          progress: [],
        },
      },
    })

    render(<App backend={backend} />)

    const actions = await screen.findAllByRole('button', { name: expectedLabel })
    expect(actions.length).toBeGreaterThan(0)
    expect(screen.getByLabelText('job-queue')).toBeInTheDocument()
    expect(screen.getByLabelText('job-detail')).toBeInTheDocument()
  })
})
