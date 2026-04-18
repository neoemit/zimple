import type { JobSummary } from './types'

export const formatTimestamp = (value?: string | null): string => {
  if (!value) {
    return '-'
  }

  return new Date(value).toLocaleString()
}

export const statusLabel = (state: JobSummary['state']): string =>
  state.charAt(0).toUpperCase() + state.slice(1)

export const compareJobsByCreated = (a: JobSummary, b: JobSummary): number =>
  b.createdAt.localeCompare(a.createdAt)
