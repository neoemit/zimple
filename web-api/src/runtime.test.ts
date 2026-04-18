// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildDockerArgs,
  containerNameForJob,
  retryDelaySeconds,
  zimitTimeHardLimitSeconds,
} from './runtime.js'
import type { StartJobRequest } from './types.js'

const request: StartJobRequest = {
  url: 'https://example.com',
  crawl: {
    respectRobots: true,
    workers: 4,
    includePatterns: ['/docs'],
    excludePatterns: ['/admin'],
    limits: {
      maxPages: 1500,
      maxDepth: 5,
      maxTotalSizeMb: 4096,
      maxAssetSizeMb: 50,
      timeoutMinutes: 180,
      retries: 2,
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
    expect(args).toContain('--saveState')
    expect(args).toContain('partial')
    expect(args).toContain('--saveStateInterval')
    expect(args).toContain('60')
    expect(args).toContain('--keep')
    const hardLimitFlagIndex = args.indexOf('--timeHardLimit')
    expect(hardLimitFlagIndex).toBeGreaterThan(-1)
    expect(args[hardLimitFlagIndex + 1]).toBe(
      String(zimitTimeHardLimitSeconds(request.crawl.limits.timeoutMinutes)),
    )
  })

  it('adds --config when resume checkpoint path is provided', () => {
    const args = buildDockerArgs(
      request,
      '/tmp/zimple-output',
      'example',
      'zimple-test',
      'ghcr.io/openzim/zimit',
      '/output/.driver.mjs',
      {
        resumeConfigPath: '/tmp/zimple-output/.tmp123/crawls/crawl.yaml',
      },
    )

    const configFlagIndex = args.indexOf('--config')
    expect(configFlagIndex).toBeGreaterThan(-1)
    expect(args[configFlagIndex + 1]).toBe('/output/.tmp123/crawls/crawl.yaml')
  })

  it('auto-locks scope to URL path prefix when include patterns are empty', () => {
    const args = buildDockerArgs(
      {
        ...request,
        url: 'https://homestead-honey.com/blog',
        crawl: {
          ...request.crawl,
          includePatterns: [],
        },
      },
      '/tmp/zimple-output',
      'example',
      'zimple-test',
      'ghcr.io/openzim/zimit',
      '/output/.driver.mjs',
    )

    const scopeTypeIndex = args.indexOf('--scopeType')
    expect(scopeTypeIndex).toBeGreaterThan(-1)
    expect(args[scopeTypeIndex + 1]).toBe('custom')
    expect(args).toContain('--scopeIncludeRx')
    expect(args).toContain('^https?://[^/]+\\/blog(?:$|[/?#].*)')
  })

  it('keeps domain scope for root URLs when include patterns are empty', () => {
    const args = buildDockerArgs(
      {
        ...request,
        url: 'https://homestead-honey.com/',
        crawl: {
          ...request.crawl,
          includePatterns: [],
        },
      },
      '/tmp/zimple-output',
      'example',
      'zimple-test',
      'ghcr.io/openzim/zimit',
      '/output/.driver.mjs',
    )

    const scopeTypeIndex = args.indexOf('--scopeType')
    expect(scopeTypeIndex).toBeGreaterThan(-1)
    expect(args[scopeTypeIndex + 1]).toBe('domain')
    expect(args).not.toContain('--scopeIncludeRx')
  })
})
