// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  normalizeCrawlOptions,
  normalizeStartJobRequest,
  sanitizeOutputName,
  validatePublicUrl,
} from './validation.js'

describe('validation', () => {
  it('accepts public http and https urls', () => {
    expect(validatePublicUrl('https://example.org/docs').hostname).toBe('example.org')
    expect(validatePublicUrl('http://example.org').protocol).toBe('http:')
  })

  it('rejects local and private network urls', () => {
    expect(() => validatePublicUrl('http://localhost')).toThrow(/Local-only hosts/)
    expect(() => validatePublicUrl('http://127.0.0.1')).toThrow(/Private or local/)
    expect(() => validatePublicUrl('http://192.168.1.20')).toThrow(/Private or local/)
  })

  it('sanitizes output names safely', () => {
    expect(sanitizeOutputName('Urban Turnip @ 2026')).toBe('urban-turnip-2026')
    expect(sanitizeOutputName('')).toBe('site')
  })

  it('normalizes crawl limits with bounds', () => {
    const normalized = normalizeCrawlOptions({
      respectRobots: true,
      workers: 99,
      includePatterns: ['  /blog  ', ''],
      excludePatterns: [''],
      limits: {
        maxPages: 0,
        maxDepth: 100,
        maxTotalSizeMb: 1,
        maxAssetSizeMb: 10_000,
        timeoutMinutes: 1,
        retries: 99,
      },
    })

    expect(normalized.workers).toBe(12)
    expect(normalized.includePatterns).toEqual(['/blog'])
    expect(normalized.limits.maxPages).toBe(1)
    expect(normalized.limits.maxDepth).toBe(32)
    expect(normalized.limits.maxTotalSizeMb).toBe(64)
    expect(normalized.limits.maxAssetSizeMb).toBe(4096)
    expect(normalized.limits.timeoutMinutes).toBe(5)
    expect(normalized.limits.retries).toBe(10)
  })

  it('fills metadata defaults from URL host and description template', () => {
    const normalized = normalizeStartJobRequest({
      url: 'https://reticulum.network',
      crawl: normalizeCrawlOptions({
        respectRobots: false,
        workers: 2,
        includePatterns: [],
        excludePatterns: [],
        limits: {
          maxPages: 100,
          maxDepth: 3,
          maxTotalSizeMb: 512,
          maxAssetSizeMb: 10,
          timeoutMinutes: 60,
          retries: 1,
        },
      }),
    })

    expect(normalized.normalized.title).toBe('Reticulum Network')
    expect(normalized.normalized.description).toBe('Offline version of Reticulum Network')
    expect(normalized.normalized.faviconUrl).toBe('https://reticulum.network/favicon.ico')
  })

  it('rejects invalid favicon URLs', () => {
    expect(() =>
      normalizeStartJobRequest({
        url: 'https://example.org',
        faviconUrl: 'ftp://example.org/favicon.ico',
        crawl: normalizeCrawlOptions({
          respectRobots: false,
          workers: 2,
          includePatterns: [],
          excludePatterns: [],
          limits: {
            maxPages: 100,
            maxDepth: 3,
            maxTotalSizeMb: 512,
            maxAssetSizeMb: 10,
            timeoutMinutes: 60,
            retries: 1,
          },
        }),
      }),
    ).toThrow(/Favicon URL must use/)
  })
})
