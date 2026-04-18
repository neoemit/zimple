import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'
import AppHeader from './components/AppHeader'
import AppSettingsModal from './components/AppSettingsModal'
import CaptureSettingsModal from './components/CaptureSettingsModal'
import CreateJobModal from './components/CreateJobModal'
import JobDetailPane from './components/JobDetailPane'
import QueuePane from './components/QueuePane'
import ToastStack from './components/ToastStack'
import { useMediaQuery } from './hooks/useMediaQuery'
import {
  createDefaultStartJobRequest,
  getBackendClient,
  type BackendClient,
} from './lib/backend'
import {
  ensureCompletionNotificationPermission,
  sendJobCompletionNotification,
} from './lib/browserNotifications'
import { defaultSettings } from './lib/defaults'
import { summarizeErrorForToast } from './lib/errorPresentation'
import { compareJobsByCreated } from './lib/presentation'
import type {
  JobDetail,
  JobSummary,
  ProgressEvent,
  RuntimeHealth,
  Settings,
  StartJobRequest,
  ThemeMode,
} from './lib/types'

interface AppProps {
  backend?: BackendClient
}

const themeStorageKey = 'zimple.theme.mode'

const isTerminalState = (state: JobSummary['state']): boolean =>
  state === 'succeeded' || state === 'failed' || state === 'cancelled'

const appendProgressToDetail = (
  current: JobDetail,
  event: ProgressEvent,
): JobDetail => {
  const lastProgress = current.progress[current.progress.length - 1]
  const isDuplicateProgress =
    Boolean(lastProgress) &&
    lastProgress.timestamp === event.timestamp &&
    lastProgress.stage === event.stage &&
    lastProgress.message === event.message &&
    lastProgress.attempt === event.attempt

  if (isDuplicateProgress) {
    return current
  }

  const lastLog = current.logs[current.logs.length - 1]
  const shouldAppendLog = lastLog !== event.message

  return {
    ...current,
    progress: [...current.progress, event],
    logs: shouldAppendLog ? [...current.logs, event.message] : current.logs,
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [infoMessage, setInfoMessage] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<boolean>(false)
  const [clearingQueue, setClearingQueue] = useState<boolean>(false)
  const [savingSettings, setSavingSettings] = useState<boolean>(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode)
  const [showCreateJobModal, setShowCreateJobModal] = useState<boolean>(false)
  const [showCaptureSettingsModal, setShowCaptureSettingsModal] = useState<boolean>(false)
  const [showAppSettingsModal, setShowAppSettingsModal] = useState<boolean>(false)
  const [queueRailOpen, setQueueRailOpen] = useState<boolean>(false)

  const autoOpenedJobs = useRef(new Set<string>())
  const completionNotifiedJobs = useRef(new Set<string>())
  const knownJobStates = useRef<Map<string, JobSummary['state']>>(new Map())

  const formatErrorMessage = useCallback((error: unknown): string => {
    if (error instanceof Error) {
      return summarizeErrorForToast(error.message)
    }

    return summarizeErrorForToast(String(error))
  }, [])

  const capabilities = useMemo(() => backend.getCapabilities(), [backend])

  const isSmallViewport = useMediaQuery('(max-width: 1099px)')
  const usesQueueOverlay = isSmallViewport

  const activeJobCount = useMemo(
    () => jobs.filter((job) => job.state === 'running').length,
    [jobs],
  )

  const queuedJobCount = useMemo(
    () => jobs.filter((job) => job.state === 'queued').length,
    [jobs],
  )

  const hasOpenModal = showCreateJobModal || showCaptureSettingsModal || showAppSettingsModal

  useEffect(() => {
    if (usesQueueOverlay) {
      setQueueRailOpen(false)
      return
    }

    setQueueRailOpen(true)
  }, [usesQueueOverlay])

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

        setErrorMessage(formatErrorMessage(error))
      }
    }

    void bootstrap()

    const unlisteners: Array<() => void> = []

    const registerListeners = async (): Promise<void> => {
      unlisteners.push(
        await backend.onJobProgress((event) => {
          if (!mounted) {
            return
          }

          setSelectedJob((current) => {
            if (!current || current.summary.id !== event.jobId) {
              return current
            }

            return appendProgressToDetail(current, event)
          })
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

          setSelectedJob((current) => {
            if (!current || current.summary.id !== nextSummary.id) {
              return current
            }

            return {
              ...current,
              summary: { ...nextSummary },
            }
          })

          if (selectedJobId === nextSummary.id && isTerminalState(nextSummary.state)) {
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

    return () => {
      mounted = false
      for (const unlisten of unlisteners) {
        unlisten()
      }
    }
  }, [
    backend,
    formatErrorMessage,
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
    if (!selectedJobId || !selectedJob || selectedJob.summary.state !== 'running') {
      return
    }

    const intervalId = window.setInterval(() => {
      void refreshSelectedJob(selectedJobId)
    }, 20000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [refreshSelectedJob, selectedJob, selectedJobId])

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

      if (
        previousState &&
        previousState !== job.state &&
        !isTerminalState(previousState) &&
        isTerminalState(job.state) &&
        !completionNotifiedJobs.current.has(job.id)
      ) {
        completionNotifiedJobs.current.add(job.id)
        void sendJobCompletionNotification(job)
      }

      knownJobStates.current.set(job.id, job.state)
    }

    for (const knownId of knownJobStates.current.keys()) {
      if (!seenIds.has(knownId)) {
        knownJobStates.current.delete(knownId)
        completionNotifiedJobs.current.delete(knownId)
        autoOpenedJobs.current.delete(knownId)
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
    if (!hasOpenModal) {
      return
    }

    document.body.classList.add('modal-open')

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }

      if (showCaptureSettingsModal) {
        setShowCaptureSettingsModal(false)
        return
      }

      if (showAppSettingsModal) {
        setShowAppSettingsModal(false)
        return
      }

      if (showCreateJobModal) {
        setShowCreateJobModal(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.classList.remove('modal-open')
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [hasOpenModal, showAppSettingsModal, showCaptureSettingsModal, showCreateJobModal])

  useEffect(() => {
    if (!usesQueueOverlay || !queueRailOpen || hasOpenModal) {
      return
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setQueueRailOpen(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [hasOpenModal, queueRailOpen, usesQueueOverlay])

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()

    setErrorMessage(null)
    setInfoMessage(null)
    setSubmitting(true)
    void ensureCompletionNotificationPermission()

    try {
      const response = await backend.startJob({
        ...request,
        outputDirectory: null,
      })

      setInfoMessage(`Job queued: ${response.jobId}`)
      setRequest((current) => ({
        ...current,
        url: '',
        outputFilename: null,
        outputDirectory: null,
      }))
      await refreshJobs()
      setSelectedJobId(response.jobId)
      setShowCaptureSettingsModal(false)
      setShowCreateJobModal(false)
      if (usesQueueOverlay) {
        setQueueRailOpen(false)
      }
    } catch (error) {
      setErrorMessage(formatErrorMessage(error))
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
      setErrorMessage(formatErrorMessage(error))
    }
  }

  const onPauseJob = async (jobId: string): Promise<void> => {
    try {
      const response = await backend.pauseJob(jobId)
      if (response.paused) {
        setInfoMessage('Pause requested. Waiting for checkpoint confirmation...')
      } else {
        setErrorMessage(
          response.message || 'Pause was not accepted for this job.',
        )
      }
      await refreshJobs()
      if (selectedJobId === jobId) {
        await refreshSelectedJob(jobId)
      }
    } catch (error) {
      setErrorMessage(formatErrorMessage(error))
    }
  }

  const onResumeJob = async (jobId: string): Promise<void> => {
    try {
      const response = await backend.resumeJob(jobId)
      if (response.resumed) {
        setInfoMessage('Resume requested. Job re-queued.')
      } else {
        setErrorMessage(
          response.message || 'Resume was not accepted for this job.',
        )
      }
      await refreshJobs()
      if (selectedJobId === jobId) {
        await refreshSelectedJob(jobId)
      }
    } catch (error) {
      setErrorMessage(formatErrorMessage(error))
    }
  }

  const onOpenOutput = async (jobId: string): Promise<void> => {
    try {
      const response = await backend.openOutput(jobId)
      if (!response.opened) {
        setErrorMessage('No output file is available for this job yet.')
      }
    } catch (error) {
      setErrorMessage(formatErrorMessage(error))
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
      setErrorMessage(formatErrorMessage(error))
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
      setErrorMessage(formatErrorMessage(error))
    }
  }

  const onClearQueue = async (): Promise<void> => {
    setErrorMessage(null)
    setInfoMessage(null)
    setClearingQueue(true)

    try {
      const response = await backend.clearQueue()
      await refreshJobs()
      if (response.removed > 0) {
        setInfoMessage(
          `Cleared ${response.removed} ${response.removed === 1 ? 'job' : 'jobs'} from queue.`,
        )
      } else {
        setInfoMessage('No completed, failed, or cancelled jobs to clear.')
      }
    } catch (error) {
      setErrorMessage(formatErrorMessage(error))
    } finally {
      setClearingQueue(false)
    }
  }

  const openCreateJobModal = useCallback((): void => {
    setShowAppSettingsModal(false)
    setShowCreateJobModal(true)
  }, [])

  const closeCreateJobModal = useCallback((): void => {
    setShowCreateJobModal(false)
    setShowCaptureSettingsModal(false)
  }, [])

  const openAppSettingsModal = useCallback((): void => {
    setShowCreateJobModal(false)
    setShowCaptureSettingsModal(false)
    setShowAppSettingsModal(true)
  }, [])

  const handleSelectJob = useCallback((jobId: string): void => {
    setSelectedJobId(jobId)
    if (usesQueueOverlay) {
      setQueueRailOpen(false)
    }
  }, [usesQueueOverlay])

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
      <AppHeader
        runtimeHealth={runtimeHealth}
        activeJobCount={activeJobCount}
        queuedJobCount={queuedJobCount}
        showQueueToggle={usesQueueOverlay}
        queueOpen={queueRailOpen}
        onToggleQueue={() => setQueueRailOpen((current) => !current)}
        onOpenSettings={openAppSettingsModal}
      />

      <section className={`workspace ${usesQueueOverlay ? 'overlay-mode' : ''}`}>
        {usesQueueOverlay && queueRailOpen && (
          <button
            type="button"
            className="queue-overlay-backdrop"
            aria-label="Close Jobs"
            onClick={() => setQueueRailOpen(false)}
          />
        )}

        {(!usesQueueOverlay || queueRailOpen) && (
          <div
            className={`workspace-slot queue-slot ${usesQueueOverlay ? 'overlay-rail open' : ''}`}
          >
            <QueuePane
              jobs={jobs}
              selectedJobId={selectedJobId}
              outputActionLabel={capabilities.outputActionLabel}
              onCreateJob={openCreateJobModal}
              onSelectJob={handleSelectJob}
              onCancelJob={(jobId) => void onCancelJob(jobId)}
              onPauseJob={(jobId) => void onPauseJob(jobId)}
              onResumeJob={(jobId) => void onResumeJob(jobId)}
              onClearQueue={() => void onClearQueue()}
              onOpenOutput={(jobId) => void onOpenOutput(jobId)}
              showCloseButton={usesQueueOverlay}
              onClose={() => setQueueRailOpen(false)}
              clearingQueue={clearingQueue}
            />
          </div>
        )}

        <div className="workspace-slot detail-slot">
          <JobDetailPane
            selectedJob={selectedJob}
            outputActionLabel={capabilities.outputActionLabel}
            onCancelJob={(jobId) => void onCancelJob(jobId)}
            onPauseJob={(jobId) => void onPauseJob(jobId)}
            onResumeJob={(jobId) => void onResumeJob(jobId)}
            onOpenOutput={(jobId) => void onOpenOutput(jobId)}
          />
        </div>
      </section>

      {showCreateJobModal && (
        <CreateJobModal
          request={request}
          submitting={submitting}
          setRequest={setRequest}
          onSubmit={onSubmit}
          onOpenCaptureSettings={() => setShowCaptureSettingsModal(true)}
          onClose={closeCreateJobModal}
        />
      )}

      {showCaptureSettingsModal && (
        <CaptureSettingsModal
          request={request}
          setRequest={setRequest}
          onClose={() => setShowCaptureSettingsModal(false)}
        />
      )}

      {showAppSettingsModal && (
        <AppSettingsModal
          settings={settings}
          settingsDraft={settingsDraft}
          themeMode={themeMode}
          savingSettings={savingSettings}
          supportsDirectoryPicker={capabilities.supportsDirectoryPicker}
          setSettings={setSettings}
          setSettingsDraft={setSettingsDraft}
          setThemeMode={setThemeMode}
          onSaveSettings={onSaveSettings}
          onBrowseDirectory={onBrowseDirectory}
          onClose={() => setShowAppSettingsModal(false)}
        />
      )}

      <ToastStack
        toasts={toasts}
        onDismiss={(id) => {
          if (id === 'info') {
            setInfoMessage(null)
          } else {
            setErrorMessage(null)
          }
        }}
      />
    </div>
  )
}

export default App
