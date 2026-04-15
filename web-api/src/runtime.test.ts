// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildDockerArgs, containerNameForJob, retryDelaySeconds } from './runtime.js'
import type { StartJobRequest } from './types.js'

const request: StartJobRequest = {
  url: 'https://example.com',
  crawl: {
    respectRobots: true,
    workers: 4,
    includePatterns: ['/docs'],
    excludePatterns: ['/admin'],
    limits: {
      maxPages: 2000,
      maxDepth: 5,
      maxTotalSizeMb: 2048,
      maxAssetSizeMb: 50,
      timeoutMinutes: 120,
      retries: 3,
    },
  },
}

describe('runtime helpers', () => {
  it('builds expected container names', () => {
    expect(containerNameForJob('1234567890abcdef')).toBe('zimple-1234567890ab')
  })

  it('has bounded retry backoff', () => {
    expect(retryDelaySeconds(0)).toBe(1)
    expect(retryDelaySeconds(1)).toBe(2)
    expect(retryDelaySeconds(4)).toBe(16)
    expect(retryDelaySeconds(99)).toBe(16)
  })

  it('builds docker args as safe argument array', () => {
    const args = buildDockerArgs(
      request,
      '/tmp/zimple-output',
      'example',
      'zimple-test',
      'ghcr.io/openzim/zimit',
      '/output/.driver.mjs',
    )

    expect(args).toContain('run')
    expect(args).toContain('zimit')
    expect(args).toContain('--seeds')
    expect(args).toContain('https://example.com')
    expect(args).toContain('--driver')
    expect(args).toContain('/output/.driver.mjs')
    expect(args).toContain('--scopeIncludeRx')
    expect(args).toContain('/docs')
    expect(args).toContain('--scopeExcludeRx')
    expect(args).toContain('/admin')
  })
})
