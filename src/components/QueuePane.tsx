import { FolderOpen, Pause, Play, Plus, Trash2, XCircle } from 'lucide-react'
import { formatTimestamp, statusLabel } from '../lib/presentation'
import type { JobSummary } from '../lib/types'

interface QueuePaneProps {
  jobs: JobSummary[]
  selectedJobId: string | null
  outputActionLabel: string
  onCreateJob: () => void
  onSelectJob: (jobId: string) => void
  onCancelJob: (jobId: string) => void
  onPauseJob: (jobId: string) => void
  onResumeJob: (jobId: string) => void
  onClearQueue: () => void
  onOpenOutput: (jobId: string) => void
  showCloseButton?: boolean
  onClose?: () => void
  clearingQueue?: boolean
}

function QueuePane({
  jobs,
  selectedJobId,
  outputActionLabel,
  onCreateJob,
  onSelectJob,
  onCancelJob,
  onPauseJob,
  onResumeJob,
  onClearQueue,
  onOpenOutput,
  showCloseButton = false,
  onClose,
  clearingQueue = false,
}: QueuePaneProps) {
  const clearableCount = jobs.filter(
    (job) => job.state === 'failed' || job.state === 'cancelled',
  ).length

  return (
    <section className="pane queue-pane" aria-label="job-queue">
      <div className="pane-header">
        <div>
          <h2>Job Queue</h2>
          <p>{jobs.length} total job{jobs.length === 1 ? '' : 's'}</p>
        </div>
        <div className="pane-header-actions">
          <button type="button" className="mini-action" onClick={onCreateJob}>
            <Plus size={15} />
            Add Job
          </button>
          {clearableCount > 0 && (
            <button
              type="button"
              className="ghost mini-action"
              onClick={onClearQueue}
              disabled={clearingQueue}
            >
              <Trash2 size={15} />
              {clearingQueue ? 'Clearing...' : `Clear Queue (${clearableCount})`}
            </button>
          )}
          {showCloseButton && onClose && (
            <button type="button" className="ghost mini-action" onClick={onClose}>
              <XCircle size={15} />
              Close
            </button>
          )}
        </div>
      </div>

      <ul className="queue-list">
        {jobs.length === 0 && (
          <li className="empty-state">
            <p>No jobs queued yet.</p>
          </li>
        )}

        {jobs.map((job) => (
          <li key={job.id} className="queue-item">
            <button
              type="button"
              className={`queue-row ${job.id === selectedJobId ? 'selected' : ''}`}
              onClick={() => onSelectJob(job.id)}
            >
              <div className="queue-row-top">
                <span className={`status-pill ${job.state}`}>{statusLabel(job.state)}</span>
                <span className="queue-attempt">Attempt {job.attempt}</span>
              </div>
              <strong className="queue-url">{job.url}</strong>
              <div className="queue-meta">
                <span>Created {formatTimestamp(job.createdAt)}</span>
                <span>Finished {formatTimestamp(job.finishedAt)}</span>
              </div>
            </button>

            <div className="row-actions">
              {job.state === 'running' && (
                <button type="button" className="ghost mini-action" onClick={() => onPauseJob(job.id)}>
                  <Pause size={15} />
                  Pause
                </button>
              )}
              {job.state === 'paused' && (
                <button type="button" className="mini-action" onClick={() => onResumeJob(job.id)}>
                  <Play size={15} />
                  Resume
                </button>
              )}
              {(job.state === 'queued' || job.state === 'running' || job.state === 'paused') && (
                <button type="button" className="ghost mini-action" onClick={() => onCancelJob(job.id)}>
                  <XCircle size={15} />
                  Cancel
                </button>
              )}
              {job.state === 'succeeded' && (
                <button type="button" className="mini-action" onClick={() => onOpenOutput(job.id)}>
                  <FolderOpen size={15} />
                  {outputActionLabel}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default QueuePane
