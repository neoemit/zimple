import { useMemo } from 'react'
import type { JobDetail, ProgressEvent } from '../lib/types'

interface CrawlStats {
  processed: number
  total: number
  pending: number
  failed: number
}

export interface TimeoutInsight {
  line1: string
  line2: string
}

const crawlProgressPattern =
  /Crawl progress:\s*(\d+)\s*\/\s*(\d+)\s*crawled,\s*(\d+)\s*pending,\s*(\d+)\s*failed/i
const conversionStartPattern = /Crawl completed\. Starting ZIM conversion/i

const conversionHeadroomMs = 15 * 60 * 1000
const supervisorBufferMs = 60 * 1000

const parseCrawlStats = (message: string): CrawlStats | null => {
  const match = crawlProgressPattern.exec(message)
  if (!match) {
    return null
  }

  return {
    processed: Number(match[1]),
    total: Number(match[2]),
    pending: Number(match[3]),
    failed: Number(match[4]),
  }
}

const isCrawlerActivity = (event: ProgressEvent): boolean => {
  if (crawlProgressPattern.test(event.message)) {
    return true
  }

  return (
    /^Starting page crawl:/i.test(event.message) ||
    /^Page finished:/i.test(event.message) ||
    conversionStartPattern.test(event.message)
  )
}

const toMs = (value: string | null | undefined): number | null => {
  if (!value) {
    return null
  }

  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

const formatDuration = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`
  }

  const hours = Math.floor(minutes / 60)
  const remainderMinutes = minutes % 60
  return `${hours}h ${remainderMinutes}m`
}

export const useTimeoutInsight = (
  detail: JobDetail | null,
  nowMs: number,
): TimeoutInsight | null =>
  useMemo(() => {
    if (!detail) {
      return null
    }

    const sortedProgress = [...detail.progress].sort(
      (left, right) =>
        new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
    )
    const hasTimeoutSignal =
      sortedProgress.some(
        (event) =>
          event.stage === 'timeout' || event.message.toLowerCase().includes('timed out'),
      ) || detail.summary.errorMessage?.toLowerCase().includes('timed out')

    if (detail.summary.state !== 'running' && !hasTimeoutSignal) {
      return null
    }

    const timeoutMinutes = Math.max(detail.request.crawl.limits.timeoutMinutes, 1)
    const crawlBudgetMs = timeoutMinutes * 60 * 1000
    const attemptBudgetMs = crawlBudgetMs + conversionHeadroomMs + supervisorBufferMs

    const latestAttemptStartEvent = [...sortedProgress]
      .reverse()
      .find(
        (event) =>
          event.stage === 'attempt' || /Attempt\s+\d+\s+of\s+\d+\s+started/i.test(event.message),
      )
    const attemptStartMs =
      toMs(latestAttemptStartEvent?.timestamp) ?? toMs(detail.summary.startedAt) ?? nowMs
    const attemptElapsedMs = Math.max(0, nowMs - attemptStartMs)

    const latestCrawlerActivity = [...sortedProgress]
      .reverse()
      .find((event) => isCrawlerActivity(event))
    const latestCrawlerActivityMs = toMs(latestCrawlerActivity?.timestamp)

    const latestCrawlStats = [...sortedProgress]
      .reverse()
      .map((event) => parseCrawlStats(event.message))
      .find((stats): stats is CrawlStats => Boolean(stats))
    const sawConversionStart = sortedProgress.some((event) =>
      conversionStartPattern.test(event.message),
    )

    const line1 = `Attempt runtime ${formatDuration(attemptElapsedMs)} / budget ${formatDuration(attemptBudgetMs)}`

    const detailParts: string[] = []
    if (latestCrawlerActivityMs !== null) {
      detailParts.push(`Last crawler activity ${formatDuration(Math.max(0, nowMs - latestCrawlerActivityMs))} ago`)
    }
    if (latestCrawlStats) {
      detailParts.push(
        `${latestCrawlStats.processed}/${latestCrawlStats.total} crawled, ${latestCrawlStats.pending} pending, ${latestCrawlStats.failed} failed`,
      )
    }

    let reasonHint = 'Limited crawler telemetry; may be in setup or runtime bottleneck.'
    if (latestCrawlStats && latestCrawlStats.pending > 0) {
      reasonHint = 'Crawler is still expanding scope and processing pending pages.'
    } else if (sawConversionStart) {
      reasonHint = 'Likely in conversion after crawl completion.'
    }
    detailParts.push(reasonHint)

    return {
      line1,
      line2: detailParts.join(' · '),
    }
  }, [detail, nowMs])
