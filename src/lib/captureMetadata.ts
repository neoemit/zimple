import type { StartJobRequest } from './types'

const DEFAULT_CAPTURE_TITLE = 'Website'

const toTitleCase = (value: string): string =>
  value
    .split(/\s+/)
    .map((part) => {
      if (!part) {
        return ''
      }
      return `${part[0]?.toUpperCase() || ''}${part.slice(1).toLowerCase()}`
    })
    .filter(Boolean)
    .join(' ')

const deriveCaptureTitle = (rawUrl: string): string => {
  try {
    const parsed = new URL(rawUrl)
    const hostWithoutWww = parsed.hostname.replace(/^www\./i, '')
    const normalized = hostWithoutWww.replace(/[._-]+/g, ' ').trim()
    if (!normalized) {
      return DEFAULT_CAPTURE_TITLE
    }

    return toTitleCase(normalized)
  } catch {
    return DEFAULT_CAPTURE_TITLE
  }
}

const deriveDefaultFaviconUrl = (rawUrl: string): string => {
  try {
    const parsed = new URL(rawUrl)
    return new URL('/favicon.ico', parsed).toString()
  } catch {
    return ''
  }
}

export interface CaptureMetadataDefaults {
  title: string
  description: string
  faviconUrl: string
}

export const deriveCaptureMetadataDefaults = (rawUrl: string): CaptureMetadataDefaults => {
  const title = deriveCaptureTitle(rawUrl)
  return {
    title,
    description: `Offline version of ${title}`,
    faviconUrl: deriveDefaultFaviconUrl(rawUrl),
  }
}

const shouldRefreshAutofilledValue = (
  currentValue: string | null | undefined,
  previousDefault: string,
): boolean => {
  const trimmed = currentValue?.trim() || ''
  if (!trimmed) {
    return true
  }

  return trimmed === previousDefault
}

export const applyAutofilledMetadataForUrl = (
  current: StartJobRequest,
  nextUrl: string,
): StartJobRequest => {
  const previousDefaults = deriveCaptureMetadataDefaults(current.url)
  const nextDefaults = deriveCaptureMetadataDefaults(nextUrl)

  return {
    ...current,
    url: nextUrl,
    title: shouldRefreshAutofilledValue(current.title, previousDefaults.title)
      ? nextDefaults.title
      : current.title,
    description: shouldRefreshAutofilledValue(
      current.description,
      previousDefaults.description,
    )
      ? nextDefaults.description
      : current.description,
    faviconUrl: shouldRefreshAutofilledValue(
      current.faviconUrl,
      previousDefaults.faviconUrl,
    )
      ? nextDefaults.faviconUrl
      : current.faviconUrl,
  }
}
