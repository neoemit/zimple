import net from 'node:net'
import { URL } from 'node:url'
import type { CrawlOptions, StartJobRequest } from './types.js'
import { defaultCrawlOptions } from './defaults.js'

const isPrivateIPv4 = (host: string): boolean => {
  const segments = host.split('.').map((segment) => Number.parseInt(segment, 10))
  if (segments.length !== 4 || segments.some((value) => Number.isNaN(value))) {
    return false
  }

  const [a, b, c, d] = segments
  if (a === 10 || a === 127 || a === 0) {
    return true
  }
  if (a === 169 && b === 254) {
    return true
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true
  }
  if (a === 192 && b === 168) {
    return true
  }
  if (a >= 224 && a <= 239) {
    return true
  }
  if (a === 255 && b === 255 && c === 255 && d === 255) {
    return true
  }

  return false
}

const isPrivateIPv6 = (host: string): boolean => {
  const normalized = host.toLowerCase()
  if (normalized === '::1' || normalized === '::') {
    return true
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true
  }
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9')) {
    return true
  }
  if (normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true
  }
  if (normalized.startsWith('ff')) {
    return true
  }

  return false
}

export const validatePublicUrl = (input: string): URL => {
  const trimmed = input.trim()
  let parsed: URL

  try {
    parsed = new URL(trimmed)
  } catch (error) {
    throw new Error(`Invalid URL: ${(error as Error).message}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are supported.')
  }

  if (parsed.username || parsed.password) {
    throw new Error('Credentials are not supported in URLs for public-site capture.')
  }

  const host = parsed.hostname
  if (!host) {
    throw new Error('URL must include a valid hostname.')
  }

  if (host.toLowerCase() === 'localhost') {
    throw new Error('Local-only hosts are not supported in public-site mode.')
  }

  const ipType = net.isIP(host)
  if (ipType === 4 && isPrivateIPv4(host)) {
    throw new Error('Private or local network addresses are not supported in public-site mode.')
  }
  if (ipType === 6 && isPrivateIPv6(host)) {
    throw new Error('Private or local network addresses are not supported in public-site mode.')
  }

  return parsed
}

export const sanitizeOutputName = (value: string): string => {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) {
    return 'site'
  }

  let output = ''
  for (const char of trimmed) {
    if (
      (char >= 'a' && char <= 'z') ||
      (char >= '0' && char <= '9') ||
      char === '-' ||
      char === '_'
    ) {
      output += char
    } else if (!output.endsWith('-')) {
      output += '-'
    }
  }

  output = output.replace(/^-+/, '').replace(/-+$/, '')
  return output.length > 0 ? output : 'site'
}

export const nowIso = (): string => new Date().toISOString()

export const defaultOutputFilename = (url: URL): string => {
  const host = sanitizeOutputName(url.hostname || 'site')
  const timestamp = nowIso().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `${host}-${timestamp}`
}

export const normalizeCrawlOptions = (crawl: CrawlOptions): CrawlOptions => {
  const merged: CrawlOptions = {
    ...defaultCrawlOptions,
    ...crawl,
    limits: {
      ...defaultCrawlOptions.limits,
      ...crawl.limits,
    },
  }

  return {
    ...merged,
    workers: Math.min(Math.max(Math.floor(merged.workers || 1), 1), 12),
    includePatterns: (merged.includePatterns || [])
      .map((pattern) => pattern.trim())
      .filter(Boolean),
    excludePatterns: (merged.excludePatterns || [])
      .map((pattern) => pattern.trim())
      .filter(Boolean),
    limits: {
      maxPages: Math.min(Math.max(Math.floor(merged.limits.maxPages || 1), 1), 100_000),
      maxDepth: Math.min(Math.max(Math.floor(merged.limits.maxDepth || 1), 1), 32),
      maxTotalSizeMb: Math.min(
        Math.max(Math.floor(merged.limits.maxTotalSizeMb || 64), 64),
        102_400,
      ),
      maxAssetSizeMb: Math.min(
        Math.max(Math.floor(merged.limits.maxAssetSizeMb || 1), 1),
        4_096,
      ),
      timeoutMinutes: Math.min(
        Math.max(Math.floor(merged.limits.timeoutMinutes || 5), 5),
        1_440,
      ),
      retries: Math.min(Math.max(Math.floor(merged.limits.retries || 0), 0), 10),
    },
  }
}

export const normalizeStartJobRequest = (
  request: StartJobRequest,
): {
  normalized: StartJobRequest
  validatedUrl: URL
  outputFilename: string
} => {
  const validatedUrl = validatePublicUrl(request.url)
  const normalizedCrawl = normalizeCrawlOptions(request.crawl)
  const preferredName = request.outputFilename?.trim()
    ? sanitizeOutputName(request.outputFilename)
    : defaultOutputFilename(validatedUrl)
  const outputFilename = preferredName.replace(/\.zim$/i, '')

  return {
    normalized: {
      ...request,
      url: validatedUrl.toString(),
      crawl: normalizedCrawl,
      outputFilename,
    },
    validatedUrl,
    outputFilename,
  }
}
