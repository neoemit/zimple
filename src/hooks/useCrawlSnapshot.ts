import { useMemo } from 'react'
import type { JobDetail, JobSummary, ProgressEvent } from '../lib/types'

export interface CrawlSnapshot {
  currentPage: string | null
  processed: number | null
  total: number | null
  pending: number | null
  failed: number | null
  percent: number | null
  statusText: string
  isTerminal: boolean
}

export interface CrawlProgressState {
  value: number
  indeterminate: boolean
}

interface CrawlSnapshotResult {
  snapshot: CrawlSnapshot
  progress: CrawlProgressState
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
  } else if (summary.state === 'paused') {
    statusText = 'Capture paused. Resume to continue.'
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

const deriveProgressState = (
  detail: JobDetail,
  snapshot: CrawlSnapshot,
): CrawlProgressState => {
  const value =
    snapshot.percent !== null
      ? Math.round(snapshot.percent)
      : detail.summary.state === 'succeeded'
        ? 100
        : 0

  return {
    value: Math.max(0, Math.min(100, value)),
    indeterminate:
      detail.summary.state === 'running' &&
      snapshot.percent === null &&
      !snapshot.isTerminal,
  }
}

export const useCrawlSnapshot = (detail: JobDetail | null): CrawlSnapshotResult | null =>
  useMemo(() => {
    if (!detail) {
      return null
    }

    const snapshot = deriveCrawlSnapshot(detail.progress, detail.summary)

    return {
      snapshot,
      progress: deriveProgressState(detail, snapshot),
    }
  }, [detail])
