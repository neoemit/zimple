import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Plus, Settings as SettingsIcon, FolderOpen, PlayCircle, XCircle,
  X, CheckCircle, Loader2
} from 'lucide-react'
import './App.css'
import {
  createDefaultStartJobRequest,
  getBackendClient,
  type BackendClient,
} from './lib/backend'
import { defaultSettings } from './lib/defaults'
import type {
  CrawlOptions,
  JobDetail,
  ProgressEvent,
  JobSummary,
  RuntimeHealth,
  Settings,
  StartJobRequest,
} from './lib/types'

interface AppProps {
  backend?: BackendClient
}

type ThemeMode = 'system' | 'light' | 'dark'

const themeStorageKey = 'zimple.theme.mode'

const toPatternText = (patterns: string[]): string => patterns.join('\n')

const fromPatternText = (value: string): string[] =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

const formatTimestamp = (value?: string | null): string => {
  if (!value) {
    return '-'
  }

  return new Date(value).toLocaleString()
}

const statusLabel = (state: JobSummary['state']): string =>
  state.charAt(0).toUpperCase() + state.slice(1)

const compareJobsByCreated = (a: JobSummary, b: JobSummary): number =>
  b.createdAt.localeCompare(a.createdAt)

interface CrawlSnapshot {
  currentPage: string | null
  processed: number | null
  total: number | null
  pending: number | null
  failed: number | null
  percent: number | null
  statusText: string
  isTerminal: boolean
}

const crawlProgressPattern =
  /Crawl progress:\s*(\d+)\s*\/\s*(\d+)\s*crawled,\s*(\d+)\s*pending,\s*(\d+)\s*failed/i
const pageStartPattern = /^Starting page crawl:\s*(.+)$/i

const deriveCrawlSnapshot = (
  progress: ProgressEvent[],
  summary: JobSummary,
): CrawlSnapshot => {
  let currentPage: string | null = null
  let processed: number | null = null
  let total: number | null = null
  let pending: number | null = null
  let failed: number | null = null
  let percent: number | null = null

  for (let index = progress.length - 1; index >= 0; index -= 1) {
    const event = progress[index]

    if (percent === null && typeof event.percent === 'number') {
      percent = Math.max(0, Math.min(100, event.percent))
    }

    if (!currentPage) {
      const pageMatch = pageStartPattern.exec(event.message)
      if (pageMatch?.[1]) {
        currentPage = pageMatch[1].trim()
      }
    }

    if (processed === null || total === null || pending === null || failed === null) {
      const match = crawlProgressPattern.exec(event.message)
      if (match) {
        processed = Number(match[1])
        total = Number(match[2])
        pending = Number(match[3])
        failed = Number(match[4])
      }
    }

    if (
      currentPage &&
      processed !== null &&
      total !== null &&
      pending !== null &&
      failed !== null &&
      percent !== null
    ) {
      break
    }
  }

  if (percent === null && processed !== null && total !== null && total > 0) {
    percent = Math.max(0, Math.min(100, (processed / total) * 100))
  }

  const isTerminal =
    summary.state === 'succeeded' ||
    summary.state === 'failed' ||
    summary.state === 'cancelled'

  if (summary.state === 'succeeded') {
    percent = 100
  }

  if (percent === null && isTerminal) {
    percent = summary.state === 'succeeded' ? 100 : 0
  }

  let statusText = 'Waiting for crawl metrics...'
  if (summary.state === 'queued') {
    statusText = 'Queued and waiting for worker slot.'
  } else if (summary.state === 'running') {
    if (processed !== null && total !== null) {
      statusText = `${processed} / ${total} pages processed`
    } else {
      statusText = 'Crawling in progress...'
    }
  } else if (summary.state === 'succeeded') {
    statusText = 'Capture completed successfully.'
  } else if (summary.state === 'failed') {
    statusText = 'Capture failed.'
  } else if (summary.state === 'cancelled') {
    statusText = 'Capture was cancelled.'
  }

  return {
    currentPage,
    processed,
    total,
    pending,
    failed,
    percent,
    statusText,
    isTerminal,
  }
}

const readThemeMode = (): ThemeMode => {
  if (typeof window === 'undefined') {
    return 'system'
  }

  const stored = window.localStorage.getItem(themeStorageKey)
  if (stored === 'system' || stored === 'light' || stored === 'dark') {
    return stored
  }

  return 'system'
}

function App({ backend = getBackendClient() }: AppProps) {
  const [request, setRequest] = useState<StartJobRequest>(() =>
    createDefaultStartJobRequest(),
  )
  const [settings, setSettings] = useState<Settings>({ ...defaultSettings })
  const [settingsDraft, setSettingsDraft] = useState<string>('')
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [selectedJob, setSelectedJob] = useState<JobDetail | null>(null)
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth | null>(null)
  const [showCreateJob, setShowCreateJob] = useState<boolean>(false)
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [infoMessage, setInfoMessage] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<boolean>(false)
  const [savingSettings, setSavingSettings] = useState<boolean>(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode)
  const autoOpenedJobs = useRef(new Set<string>())
  const knownJobStates = useRef<Map<string, JobSummary['state']>>(new Map())

  const activeJobCount = useMemo(
    () => jobs.filter((job) => job.state === 'running').length,
    [jobs],
  )

  const queuedJobCount = useMemo(
    () => jobs.filter((job) => job.state === 'queued').length,
    [jobs],
  )

  const refreshJobs = useCallback(async (): Promise<void> => {
    const nextJobs = await backend.listJobs()
    nextJobs.sort(compareJobsByCreated)
    setJobs(nextJobs)

    if (!selectedJobId && nextJobs.length > 0) {
      setSelectedJobId(nextJobs[0].id)
    }

    if (selectedJobId) {
      const stillExists = nextJobs.some((job) => job.id === selectedJobId)
      if (!stillExists) {
        setSelectedJobId(nextJobs[0]?.id ?? null)
      }
    }
  }, [backend, selectedJobId])

  const refreshSelectedJob = useCallback(async (jobId: string): Promise<void> => {
    const detail = await backend.getJob(jobId)
    setSelectedJob(detail)
  }, [backend])

  const refreshRuntimeHealth = useCallback(async (): Promise<void> => {
    const nextHealth = await backend.getRuntimeHealth()
    setRuntimeHealth(nextHealth)
  }, [backend])

  useEffect(() => {
    let mounted = true
    let intervalId: number | null = null

    const bootstrap = async (): Promise<void> => {
      try {
        const [initialSettings] = await Promise.all([
          backend.getSettings(),
          refreshJobs(),
          refreshRuntimeHealth(),
        ])

        if (!mounted) {
          return
        }

        setSettings(initialSettings)
        setSettingsDraft(initialSettings.outputDirectory ?? '')
      } catch (error) {
        if (!mounted) {
          return
        }

        setErrorMessage((error as Error).message)
      }
    }

    void bootstrap()

    const unlisteners: Array<() => void> = []

    const registerListeners = async (): Promise<void> => {
      unlisteners.push(
        await backend.onJobProgress(async (event) => {
          if (!mounted) {
            return
          }

          if (selectedJobId && event.jobId === selectedJobId) {
            await refreshSelectedJob(selectedJobId)
          }
        }),
      )

      unlisteners.push(
        await backend.onJobStateChanged(async (nextSummary) => {
          if (!mounted) {
            return
          }

          setJobs((current) => {
            const merged = [...current]
            const index = merged.findIndex((job) => job.id === nextSummary.id)
            if (index >= 0) {
              merged[index] = nextSummary
            } else {
              merged.unshift(nextSummary)
            }

            merged.sort(compareJobsByCreated)
            return merged
          })

          if (selectedJobId === nextSummary.id) {
            await refreshSelectedJob(nextSummary.id)
          }

          if (
            nextSummary.state === 'succeeded' &&
            settings.autoOpenOnSuccess &&
            !autoOpenedJobs.current.has(nextSummary.id)
          ) {
            autoOpenedJobs.current.add(nextSummary.id)
            void backend.openOutput(nextSummary.id)
          }
        }),
      )

      unlisteners.push(
        await backend.onRuntimeHealthChanged((event) => {
          if (!mounted) {
            return
          }

          setRuntimeHealth(event)
        }),
      )
    }

    void registerListeners()

    intervalId = window.setInterval(() => {
      void refreshJobs()
      void refreshRuntimeHealth()
      if (selectedJobId) {
        void refreshSelectedJob(selectedJobId)
      }
    }, 5000)

    return () => {
      mounted = false
      if (intervalId !== null) {
        window.clearInterval(intervalId)
      }
      for (const unlisten of unlisteners) {
        unlisten()
      }
    }
  }, [
    backend,
    refreshJobs,
    refreshRuntimeHealth,
    refreshSelectedJob,
    selectedJobId,
    settings.autoOpenOnSuccess,
  ])

  useEffect(() => {
    if (!selectedJobId) {
      setSelectedJob(null)
      return
    }

    void refreshSelectedJob(selectedJobId)
  }, [refreshSelectedJob, selectedJobId])

  useEffect(() => {
    const seenIds = new Set<string>()

    for (const job of jobs) {
      seenIds.add(job.id)
      const previousState = knownJobStates.current.get(job.id)

      if (
        previousState &&
        previousState !== 'succeeded' &&
        job.state === 'succeeded' &&
        settings.autoOpenOnSuccess &&
        !autoOpenedJobs.current.has(job.id)
      ) {
        autoOpenedJobs.current.add(job.id)
        void backend.openOutput(job.id)
      }

      knownJobStates.current.set(job.id, job.state)
    }

    for (const knownId of knownJobStates.current.keys()) {
      if (!seenIds.has(knownId)) {
        knownJobStates.current.delete(knownId)
      }
    }
  }, [backend, jobs, settings.autoOpenOnSuccess])

  useEffect(() => {
    if (!infoMessage) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setInfoMessage(null)
    }, 5000)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [infoMessage])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem(themeStorageKey, themeMode)
  }, [themeMode])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const root = document.documentElement

    if (typeof window.matchMedia !== 'function') {
      root.dataset.theme = themeMode === 'dark' ? 'dark' : 'light'
      root.dataset.themeMode = themeMode
      return
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const applyTheme = (): void => {
      const effectiveTheme =
        themeMode === 'system'
          ? mediaQuery.matches
            ? 'dark'
            : 'light'
          : themeMode
      root.dataset.theme = effectiveTheme
      root.dataset.themeMode = themeMode
    }

    applyTheme()

    if (themeMode !== 'system') {
      return
    }

    const onSchemeChange = (): void => {
      applyTheme()
    }

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', onSchemeChange)
      return () => mediaQuery.removeEventListener('change', onSchemeChange)
    }

    mediaQuery.addListener(onSchemeChange)
    return () => mediaQuery.removeListener(onSchemeChange)
  }, [themeMode])

  useEffect(() => {
    if (!showAdvanced && !showCreateJob) {
      return
    }

    document.body.classList.add('modal-open')

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (showAdvanced) {
          setShowAdvanced(false)
        } else if (showCreateJob) {
          setShowCreateJob(false)
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.classList.remove('modal-open')
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [showAdvanced, showCreateJob])

  const onUrlChange = (value: string): void => {
    setRequest((current) => ({ ...current, url: value }))
  }

  const updateCrawlOptions = (nextCrawl: CrawlOptions): void => {
    setRequest((current) => ({ ...current, crawl: nextCrawl }))
  }

  const updateLimits = (
    field: keyof CrawlOptions['limits'],
    value: number,
  ): void => {
    updateCrawlOptions({
      ...request.crawl,
      limits: {
        ...request.crawl.limits,
        [field]: value,
      },
    })
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()

    setErrorMessage(null)
    setInfoMessage(null)

    setSubmitting(true)

    try {
      const outputDirectory = request.outputDirectory?.trim() || null
      const response = await backend.startJob({
        ...request,
        outputDirectory,
      })

      setInfoMessage(`Job queued: ${response.jobId}`)
      setRequest((current) => ({ ...current, url: '' }))
      await refreshJobs()
      setSelectedJobId(response.jobId)
      setShowCreateJob(false)
    } catch (error) {
      setErrorMessage((error as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const onCancelJob = async (jobId: string): Promise<void> => {
    try {
      const response = await backend.cancelJob(jobId)
      if (!response.cancelled) {
        setInfoMessage('Job was already finished or unavailable.')
      }
      await refreshJobs()
      if (selectedJobId === jobId) {
        await refreshSelectedJob(jobId)
      }
    } catch (error) {
      setErrorMessage((error as Error).message)
    }
  }

  const onOpenOutput = async (jobId: string): Promise<void> => {
    try {
      const response = await backend.openOutput(jobId)
      if (!response.opened) {
        setErrorMessage('No output file is available for this job yet.')
      }
    } catch (error) {
      setErrorMessage((error as Error).message)
    }
  }

  const onSaveSettings = async (): Promise<void> => {
    setSavingSettings(true)
    setErrorMessage(null)
    setInfoMessage(null)

    try {
      const nextSettings = await backend.setSettings({
        outputDirectory: settingsDraft.trim() || null,
        autoOpenOnSuccess: settings.autoOpenOnSuccess,
      })
      setSettings(nextSettings)
      setInfoMessage('Settings saved.')
    } catch (error) {
      setErrorMessage((error as Error).message)
    } finally {
      setSavingSettings(false)
    }
  }

  const onBrowseDirectory = async (): Promise<void> => {
    setErrorMessage(null)

    try {
      const selected = await backend.pickOutputDirectory()
      if (selected) {
        setSettingsDraft(selected)
      }
    } catch (error) {
      setErrorMessage((error as Error).message)
    }
  }

  const crawlSnapshot = useMemo(() => {
    if (!selectedJob) {
      return null
    }

    return deriveCrawlSnapshot(selectedJob.progress, selectedJob.summary)
  }, [selectedJob])

  const crawlProgress = useMemo(() => {
    if (!selectedJob || !crawlSnapshot) {
      return {
        value: 0,
        indeterminate: false,
      }
    }

    const value =
      crawlSnapshot.percent !== null
        ? Math.round(crawlSnapshot.percent)
        : selectedJob.summary.state === 'succeeded'
          ? 100
          : 0

    return {
      value: Math.max(0, Math.min(100, value)),
      indeterminate:
        selectedJob.summary.state === 'running' &&
        crawlSnapshot.percent === null &&
        !crawlSnapshot.isTerminal,
    }
  }, [crawlSnapshot, selectedJob])

  const toasts = useMemo(
    () =>
      [
        infoMessage
          ? {
              id: 'info',
              type: 'info',
              text: infoMessage,
            }
          : null,
        errorMessage
          ? {
              id: 'error',
              type: 'error',
              text: errorMessage,
            }
          : null,
      ].filter((toast): toast is { id: 'info' | 'error'; type: 'info' | 'error'; text: string } =>
        Boolean(toast),
      ),
    [errorMessage, infoMessage],
  )

  return (
    <div className="app-shell">
      <section className="top-row" aria-label="app-overview">
        <header className="hero">
          <p className="eyebrow">Offline Publishing Studio</p>
          <h1>Zimple</h1>
          <p className="lead">
            Convert websites into Kiwix-ready ZIM files with a queued, policy-aware
            desktop pipeline.
          </p>
        </header>

        <section className="panel status-strip" aria-label="runtime-status">
          <div className="status-item">
            <p className="label">Runtime</p>
            <p>
              {runtimeHealth?.ready
                ? 'Ready'
                : runtimeHealth?.message ?? 'Checking Docker + zimit runtime...'}
            </p>
          </div>
          <div className="status-item">
            <p className="label">Active</p>
            <p>{activeJobCount}</p>
          </div>
          <div className="status-item">
            <p className="label">Queued</p>
            <p>{queuedJobCount}</p>
          </div>
        </section>
      </section>

      <div className="workspace workspace-single">
        <section className="panel jobs-panel">
          <div className="section-head">
            <h2>Job Queue</h2>
            <div className="section-actions">
              <button type="button" onClick={() => setShowCreateJob(true)}>
                <Plus size={18} /> Add Job
              </button>
            </div>
          </div>

          <div className="jobs-layout">
            <ul className="job-list">
              {jobs.length === 0 && (
                <li className="empty empty-block">
                  <p>No jobs yet.</p>
                  <button type="button" onClick={() => setShowCreateJob(true)}>
                    <Plus size={18} /> Add Your First Job
                  </button>
                </li>
              )}
              {jobs.map((job) => (
                <li key={job.id}>
                  <button
                    className={`job-item ${selectedJobId === job.id ? 'selected' : ''}`}
                    onClick={() => setSelectedJobId(job.id)}
                    type="button"
                  >
                    <span className={`badge ${job.state}`}>{statusLabel(job.state)}</span>
                    <strong>{job.url}</strong>
                    <small>Created: {formatTimestamp(job.createdAt)}</small>
                  </button>
                  <div className="job-actions">
                    {(job.state === 'queued' || job.state === 'running') && (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => void onCancelJob(job.id)}
                      >
                        <XCircle size={16} /> Cancel
                      </button>
                    )}
                    {job.state === 'succeeded' && (
                      <button type="button" onClick={() => void onOpenOutput(job.id)}>
                        <FolderOpen size={16} /> Open Output
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <article className="job-detail" aria-live="polite">
              {!selectedJob && <p className="empty">Select a job to inspect details.</p>}
              {selectedJob && (
                <>
                  <div className="job-detail-head">
                    <h3 className="job-url">{selectedJob.summary.url}</h3>
                    <div className="job-meta">
                      <span className={`badge ${selectedJob.summary.state}`}>
                        {statusLabel(selectedJob.summary.state)}
                      </span>
                      <p>Attempt: {selectedJob.summary.attempt}</p>
                      <p>Started: {formatTimestamp(selectedJob.summary.startedAt)}</p>
                      <p>Finished: {formatTimestamp(selectedJob.summary.finishedAt)}</p>
                      <p>Output: {selectedJob.summary.outputPath ?? 'Not generated yet'}</p>
                    </div>
                    {selectedJob.summary.errorMessage && (
                      <p className="error">Error: {selectedJob.summary.errorMessage}</p>
                    )}
                  </div>

                  {crawlSnapshot && (
                    <section className="crawl-status-panel" aria-label="crawl-status">
                      <div className="crawl-status-head">
                        <h4>Crawl Status</h4>
                        <span className={`badge ${selectedJob.summary.state}`}>
                          {statusLabel(selectedJob.summary.state)}
                        </span>
                      </div>
                      <p className="crawl-status-text">{crawlSnapshot.statusText}</p>

                      <div
                        className="progress-track"
                        role="progressbar"
                        aria-label="Crawl completion"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={crawlProgress.value}
                        aria-valuetext={`${crawlProgress.value}% complete`}
                      >
                        <span
                          className={`progress-fill ${crawlProgress.indeterminate ? 'indeterminate' : ''}`}
                          style={
                            !crawlProgress.indeterminate
                              ? {
                                  width: `${crawlProgress.value}%`,
                                }
                              : undefined
                          }
                        />
                      </div>

                      <div className="crawl-stats-grid">
                        <p>
                          <span>Processed</span>
                          <strong>
                            {crawlSnapshot.processed !== null ? crawlSnapshot.processed : '-'}
                          </strong>
                        </p>
                        <p>
                          <span>Total</span>
                          <strong>
                            {crawlSnapshot.total !== null ? crawlSnapshot.total : '-'}
                          </strong>
                        </p>
                        <p>
                          <span>Pending</span>
                          <strong>
                            {crawlSnapshot.pending !== null ? crawlSnapshot.pending : '-'}
                          </strong>
                        </p>
                        <p>
                          <span>Failed</span>
                          <strong>
                            {crawlSnapshot.failed !== null ? crawlSnapshot.failed : '-'}
                          </strong>
                        </p>
                      </div>

                      <p className="current-page">
                        Current page:{' '}
                        <strong>{crawlSnapshot.currentPage ?? 'Detecting current page...'}</strong>
                      </p>
                    </section>
                  )}
                </>
              )}
            </article>
          </div>
        </section>
      </div>

      {showCreateJob && (
        <div
          className="modal-backdrop create-job-backdrop"
          role="presentation"
          onClick={() => setShowCreateJob(false)}
        >
          <section
            className="modal-card create-job-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-job-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="create-job-title">New Capture Job</h2>
              <button
                type="button"
                className="ghost"
                onClick={() => setShowCreateJob(false)}
              >
                <X size={18} /> Close
              </button>
            </div>

            <div className="modal-content">
              <form className="job-form" onSubmit={(event) => void onSubmit(event)}>
                <label>
                  Website URL
                  <input
                    aria-label="website-url"
                    type="url"
                    placeholder="https://example.com"
                    value={request.url}
                    onChange={(event) => onUrlChange(event.target.value)}
                    required
                  />
                </label>

                <div className="job-grid">
                  <label>
                    Output Filename (optional)
                    <input
                      aria-label="output-filename"
                      type="text"
                      placeholder="example-archive"
                      value={request.outputFilename ?? ''}
                      onChange={(event) =>
                        setRequest((current) => ({
                          ...current,
                          outputFilename: event.target.value || null,
                        }))
                      }
                    />
                  </label>

                  <label>
                    Override Output Directory (optional)
                    <input
                      aria-label="output-directory-override"
                      type="text"
                      placeholder={settings.outputDirectory ?? 'Uses default output directory'}
                      value={request.outputDirectory ?? ''}
                      onChange={(event) =>
                        setRequest((current) => ({
                          ...current,
                          outputDirectory: event.target.value || null,
                        }))
                      }
                    />
                  </label>
                </div>

                <div className="form-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setShowCreateJob(false)}
                  >
                    <XCircle size={18} /> Cancel
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setShowAdvanced(true)}
                  >
                    <SettingsIcon size={18} /> Show Advanced
                  </button>
                  <button type="submit" disabled={submitting}>
                    {submitting ? (
                      <><Loader2 size={18} className="spin" /> Queueing...</>
                    ) : (
                      <><PlayCircle size={18} /> Start Processing</>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </section>
        </div>
      )}

      {showAdvanced && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setShowAdvanced(false)}
        >
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="advanced-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="advanced-title">Advanced Capture Controls</h2>
              <button
                type="button"
                className="ghost"
                onClick={() => setShowAdvanced(false)}
              >
                <SettingsIcon size={18} /> Hide Advanced
              </button>
            </div>

            <div className="modal-content">
              <div className="advanced" aria-label="advanced-options">
                <div className="advanced-grid">
                  <label>
                    Workers
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={request.crawl.workers}
                      onChange={(event) =>
                        updateCrawlOptions({
                          ...request.crawl,
                          workers: Number(event.target.value),
                        })
                      }
                    />
                  </label>

                  <label>
                    Max Pages
                    <input
                      type="number"
                      min={1}
                      value={request.crawl.limits.maxPages}
                      onChange={(event) =>
                        updateLimits('maxPages', Number(event.target.value))
                      }
                    />
                  </label>

                  <label>
                    Max Depth
                    <input
                      type="number"
                      min={1}
                      value={request.crawl.limits.maxDepth}
                      onChange={(event) =>
                        updateLimits('maxDepth', Number(event.target.value))
                      }
                    />
                  </label>

                  <label>
                    Total Size (MB)
                    <input
                      type="number"
                      min={64}
                      value={request.crawl.limits.maxTotalSizeMb}
                      onChange={(event) =>
                        updateLimits('maxTotalSizeMb', Number(event.target.value))
                      }
                    />
                  </label>

                  <label>
                    Per Asset (MB)
                    <input
                      type="number"
                      min={1}
                      value={request.crawl.limits.maxAssetSizeMb}
                      onChange={(event) =>
                        updateLimits('maxAssetSizeMb', Number(event.target.value))
                      }
                    />
                  </label>

                  <label>
                    Timeout (minutes)
                    <input
                      type="number"
                      min={5}
                      value={request.crawl.limits.timeoutMinutes}
                      onChange={(event) =>
                        updateLimits('timeoutMinutes', Number(event.target.value))
                      }
                    />
                  </label>

                  <label>
                    Retries
                    <input
                      type="number"
                      min={0}
                      max={6}
                      value={request.crawl.limits.retries}
                      onChange={(event) =>
                        updateLimits('retries', Number(event.target.value))
                      }
                    />
                  </label>
                </div>

                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={request.crawl.respectRobots}
                    onChange={(event) =>
                      updateCrawlOptions({
                        ...request.crawl,
                        respectRobots: event.target.checked,
                      })
                    }
                  />
                  Respect robots.txt by default
                </label>

                <div className="pattern-grid">
                  <label>
                    Include Patterns (one per line)
                    <textarea
                      value={toPatternText(request.crawl.includePatterns)}
                      onChange={(event) =>
                        updateCrawlOptions({
                          ...request.crawl,
                          includePatterns: fromPatternText(event.target.value),
                        })
                      }
                    />
                  </label>

                  <label>
                    Exclude Patterns (one per line)
                    <textarea
                      value={toPatternText(request.crawl.excludePatterns)}
                      onChange={(event) =>
                        updateCrawlOptions({
                          ...request.crawl,
                          excludePatterns: fromPatternText(event.target.value),
                        })
                      }
                    />
                  </label>
                </div>

                <div className="advanced-storage">
                  <h3>Storage Settings</h3>
                  <div className="settings-row">
                    <label>
                      Default Output Directory
                      <input
                        aria-label="default-output-directory"
                        type="text"
                        value={settingsDraft}
                        placeholder="Choose where generated .zim files should be saved"
                        onChange={(event) => setSettingsDraft(event.target.value)}
                      />
                    </label>
                    <div className="settings-actions">
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => void onBrowseDirectory()}
                      >
                        <FolderOpen size={18} /> Browse
                      </button>
                      <button
                        type="button"
                        disabled={savingSettings}
                        onClick={() => void onSaveSettings()}
                      >
                        {savingSettings ? (
                          <><Loader2 size={18} className="spin" /> Saving...</>
                        ) : (
                          <><CheckCircle size={18} /> Save</>
                        )}
                      </button>
                    </div>
                  </div>
                  <label>
                    Theme
                    <select
                      aria-label="theme-mode"
                      value={themeMode}
                      onChange={(event) =>
                        setThemeMode(event.target.value as ThemeMode)
                      }
                    >
                      <option value="system">System (Default)</option>
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </select>
                    <small className="setting-hint">
                      System follows your OS appearance automatically.
                    </small>
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.autoOpenOnSuccess}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          autoOpenOnSuccess: event.target.checked,
                        }))
                      }
                    />
                    Auto-open generated ZIM files when a job succeeds
                  </label>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}

      {toasts.length > 0 && (
        <div className="toast-stack" aria-live="polite" aria-atomic="true">
          {toasts.map((toast) => (
            <section
              key={toast.id}
              className={`toast toast-${toast.type}`}
              role={toast.type === 'error' ? 'alert' : 'status'}
            >
              <p>{toast.text}</p>
              <button
                type="button"
                className="ghost toast-dismiss"
                onClick={() => {
                  if (toast.id === 'info') {
                    setInfoMessage(null)
                  } else {
                    setErrorMessage(null)
                  }
                }}
              >
                <X size={16} />
              </button>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

export default App
