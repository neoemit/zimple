const DEFAULT_CAPTURE_TITLE = 'Website'
const DEFAULT_FAVICON_DISCOVERY_TIMEOUT_MS = 4_000
const MAX_FAVICON_HTML_BYTES = 512_000

const toTitleCase = (value: string): string =>
  value
    .split(/\s+/)
    .map((word) => {
      if (!word) {
        return ''
      }
      return `${word[0]?.toUpperCase() || ''}${word.slice(1).toLowerCase()}`
    })
    .filter(Boolean)
    .join(' ')

const parseUrl = (value: string | URL): URL =>
  value instanceof URL ? value : new URL(value)

export const deriveCaptureTitleFromUrl = (value: string | URL): string => {
  const parsed = parseUrl(value)
  const hostWithoutWww = parsed.hostname.replace(/^www\./i, '')
  const normalized = hostWithoutWww.replace(/[._-]+/g, ' ').trim()
  if (!normalized) {
    return DEFAULT_CAPTURE_TITLE
  }
  return toTitleCase(normalized)
}

export const deriveDefaultCaptureDescription = (title: string): string =>
  `Offline version of ${title}`

export const deriveDefaultFaviconUrl = (value: string | URL): string => {
  const parsed = parseUrl(value)
  return new URL('/favicon.ico', parsed).toString()
}

export const normalizeMetadataText = (
  value: string | null | undefined,
  fallback: string,
  maxLength: number,
): string => {
  const trimmed = value?.trim() || ''
  const candidate = trimmed || fallback
  return candidate.slice(0, maxLength).trim() || fallback
}

export const normalizeFaviconUrl = (
  value: string | null | undefined,
  baseUrl: URL,
): string => {
  const trimmed = value?.trim() || ''
  if (!trimmed) {
    return deriveDefaultFaviconUrl(baseUrl)
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed, baseUrl)
  } catch (error) {
    throw new Error(`Invalid favicon URL: ${(error as Error).message}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Favicon URL must use http:// or https://')
  }

  if (parsed.username || parsed.password) {
    throw new Error('Favicon URL cannot include credentials.')
  }

  return parsed.toString()
}

const extractAttribute = (tag: string, attribute: string): string | null => {
  const matcher = new RegExp(
    `${attribute}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'i',
  )
  const match = matcher.exec(tag)
  if (!match) {
    return null
  }

  return (match[2] || match[3] || match[4] || '').trim()
}

const faviconPriority = (relValue: string): number => {
  const normalized = relValue.toLowerCase().replace(/\s+/g, ' ').trim()
  if (normalized === 'icon' || normalized === 'shortcut icon') {
    return 4
  }
  if (normalized.includes('icon')) {
    return 3
  }
  if (normalized.includes('apple-touch-icon')) {
    return 2
  }
  if (normalized.includes('mask-icon')) {
    return 1
  }
  return 0
}

const pickFaviconFromHtml = (html: string, pageUrl: URL): string | null => {
  const linkTagPattern = /<link\b[^>]*>/gi
  let match: RegExpExecArray | null

  let selectedUrl: string | null = null
  let selectedPriority = -1

  while ((match = linkTagPattern.exec(html)) !== null) {
    const tag = match[0]
    const rel = extractAttribute(tag, 'rel')
    const href = extractAttribute(tag, 'href')
    if (!rel || !href) {
      continue
    }

    const priority = faviconPriority(rel)
    if (priority <= 0 || priority < selectedPriority) {
      continue
    }

    try {
      const resolved = new URL(href, pageUrl)
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
        continue
      }
      selectedUrl = resolved.toString()
      selectedPriority = priority
    } catch {
      continue
    }
  }

  return selectedUrl
}

export const discoverFaviconUrlFromWebsite = async (
  targetUrl: string,
  timeoutMs = DEFAULT_FAVICON_DISCOVERY_TIMEOUT_MS,
): Promise<string | null> => {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return null
  }

  const parsed = new URL(targetUrl)
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => {
    controller.abort()
  }, Math.max(timeoutMs, 1_000))

  try {
    const response = await fetch(parsed, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
      },
    })
    if (!response.ok) {
      return null
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase()
    if (!contentType.includes('html')) {
      return null
    }

    const html = (await response.text()).slice(0, MAX_FAVICON_HTML_BYTES)
    return pickFaviconFromHtml(html, parsed)
  } catch {
    return null
  } finally {
    clearTimeout(timeoutHandle)
  }
}
