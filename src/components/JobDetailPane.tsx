import { FolderOpen, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useCrawlSnapshot } from '../hooks/useCrawlSnapshot'
import { interpretError } from '../lib/errorPresentation'
import { formatTimestamp, statusLabel } from '../lib/presentation'
import type { JobDetail } from '../lib/types'

interface JobDetailPaneProps {
  selectedJob: JobDetail | null
  outputActionLabel: string
  onCancelJob: (jobId: string) => void
  onOpenOutput: (jobId: string) => void
}

function JobDetailPane({
  selectedJob,
  outputActionLabel,
  onCancelJob,
  onOpenOutput,
}: JobDetailPaneProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now())
  const crawl = useCrawlSnapshot(selectedJob)
  const interpretedError = selectedJob?.summary.errorMessage
    ? interpretError(selectedJob.summary.errorMessage)
    : null

  const recentLogs = useMemo(() => {
    if (!selectedJob) {
      return []
    }

    return selectedJob.logs.slice(-120)
  }, [selectedJob])

  const progressValue = crawl?.progress.value ?? 0
  const visualProgressValue = crawl?.progress.indeterminate
    ? progressValue
    : progressValue > 0
      ? Math.max(progressValue, 6)
      : 0
  const lastProgressTimestamp =
    selectedJob?.progress.at(-1)?.timestamp ?? selectedJob?.summary.startedAt ?? null
  const lastProgressMs = lastProgressTimestamp ? new Date(lastProgressTimestamp).getTime() : null
  const staleSeconds =
    selectedJob?.summary.state === 'running' &&
    lastProgressMs !== null &&
    Number.isFinite(lastProgressMs)
      ? Math.max(0, Math.floor((nowMs - lastProgressMs) / 1000))
      : null

  useEffect(() => {
    if (!selectedJob || selectedJob.summary.state !== 'running') {
      return
    }

    const intervalId = window.setInterval(() => {
      setNowMs(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [selectedJob])

  const formatStaleDuration = (seconds: number): string => {
    if (seconds < 60) {
      return `${seconds}s`
    }

    const minutes = Math.floor(seconds / 60)
    const remainder = seconds % 60
    if (minutes < 60) {
      return `${minutes}m ${remainder}s`
    }

    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m`
  }

  return (
    <section className="pane detail-pane" aria-label="job-detail">
      {!selectedJob && (
        <div className="empty-state detail-empty">
          <p>Select a job to inspect details, progress, and logs.</p>
        </div>
      )}

      {selectedJob && (
        <>
          <div className="detail-head">
            <div>
              <p className="detail-kicker">Selected Job</p>
              <h2 className="detail-url">{selectedJob.summary.url}</h2>
            </div>
            <div className="detail-actions">
              <span className={`status-pill ${selectedJob.summary.state}`}>
                {statusLabel(selectedJob.summary.state)}
              </span>
              {(selectedJob.summary.state === 'queued' || selectedJob.summary.state === 'running') && (
                <button
                  type="button"
                  className="ghost mini-action"
                  onClick={() => onCancelJob(selectedJob.summary.id)}
                >
                  <XCircle size={15} />
                  Cancel
                </button>
              )}
              {selectedJob.summary.state === 'succeeded' && (
                <button
                  type="button"
                  className="mini-action"
                  onClick={() => onOpenOutput(selectedJob.summary.id)}
                >
                  <FolderOpen size={15} />
                  {outputActionLabel}
                </button>
              )}
            </div>
          </div>

          <div className="meta-grid">
            <p><span>Attempt</span><strong>{selectedJob.summary.attempt}</strong></p>
            <p><span>Started</span><strong>{formatTimestamp(selectedJob.summary.startedAt)}</strong></p>
            <p><span>Finished</span><strong>{formatTimestamp(selectedJob.summary.finishedAt)}</strong></p>
            <p><span>Output</span><strong>{selectedJob.summary.outputPath ?? 'Not generated yet'}</strong></p>
          </div>

          {selectedJob.summary.errorMessage && interpretedError && (
            <section className="detail-error" role="alert" aria-live="polite">
              <p className="detail-error-title">{interpretedError.headline}</p>
              {interpretedError.detail && (
                <p className="detail-error-detail">{interpretedError.detail}</p>
              )}
              {interpretedError.actions.length > 0 && (
                <ul className="detail-error-actions">
                  {interpretedError.actions.map((action) => (
                    <li key={action}>{action}</li>
                  ))}
                </ul>
              )}
              <details className="detail-error-raw">
                <summary>Technical details</summary>
                <p>{interpretedError.raw}</p>
              </details>
            </section>
          )}

          {crawl && (
            <section className="progress-panel" aria-label="crawl-status">
              <div className="progress-top">
                <h3>Crawl Progress</h3>
                <div className="progress-emphasis" aria-live="polite">
                  <strong>{crawl.progress.indeterminate ? 'Estimating...' : `${progressValue}%`}</strong>
                  <span>
                    {crawl.snapshot.processed !== null && crawl.snapshot.total !== null
                      ? `${crawl.snapshot.processed} / ${crawl.snapshot.total} pages`
                      : crawl.snapshot.statusText}
                  </span>
                </div>
              </div>

              <div
                className="progress-track"
                role="progressbar"
                aria-label="Crawl completion"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={crawl.progress.value}
                aria-valuetext={`${crawl.progress.value}% complete`}
              >
                <span
                  className={`progress-fill ${crawl.progress.indeterminate ? 'indeterminate' : ''}`}
                  style={
                    !crawl.progress.indeterminate
                      ? {
                          width: `${visualProgressValue}%`,
                        }
                      : undefined
                  }
                />
              </div>

              <p className="progress-status">{crawl.snapshot.statusText}</p>
              {staleSeconds !== null && (
                <p className="progress-freshness">
                  Last update {formatStaleDuration(staleSeconds)} ago.
                  {staleSeconds >= 25 ? ' Capture is still active; waiting for next crawler event.' : ''}
                </p>
              )}

              <div className="stats-grid">
                <p><span>Processed</span><strong>{crawl.snapshot.processed ?? '-'}</strong></p>
                <p><span>Total</span><strong>{crawl.snapshot.total ?? '-'}</strong></p>
                <p><span>Pending</span><strong>{crawl.snapshot.pending ?? '-'}</strong></p>
                <p><span>Failed</span><strong>{crawl.snapshot.failed ?? '-'}</strong></p>
              </div>

              <p className="current-page">
                Current page: <strong>{crawl.snapshot.currentPage ?? 'Detecting current page...'}</strong>
              </p>
            </section>
          )}

          <section className="logs-panel">
            <details className="detail-collapsible">
              <summary>Event Timeline</summary>
              <div className="collapsible-body">
                {selectedJob.progress.length === 0 && <p className="empty">No progress events yet.</p>}
                {selectedJob.progress.length > 0 && (
                  <ol className="timeline-list">
                    {selectedJob.progress.slice(-40).map((event, index) => (
                      <li key={`${event.timestamp}-${index}`}>
                        <div className="timeline-meta">
                          <span className="stage-chip">{event.stage}</span>
                          <time dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time>
                        </div>
                        <p>{event.message}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </details>

            <details
              className="detail-collapsible"
              open={selectedJob.summary.state === 'failed'}
            >
              <summary>Runtime Logs</summary>
              <div className="collapsible-body">
                {recentLogs.length === 0 && <p className="empty">No runtime logs yet.</p>}
                {recentLogs.length > 0 && (
                  <ol className="log-list" role="log" aria-live="polite">
                    {recentLogs.map((line, index) => (
                      <li key={`${index}-${line}`}>{line}</li>
                    ))}
                  </ol>
                )}
              </div>
            </details>
          </section>
        </>
      )}
    </section>
  )
}

export default JobDetailPane
