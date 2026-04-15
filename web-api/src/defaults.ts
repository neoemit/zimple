import path from 'node:path'
import type { CrawlOptions, Settings, WebApiConfig } from './types.js'

export const defaultCrawlOptions: CrawlOptions = {
  respectRobots: true,
  workers: 4,
  includePatterns: [],
  excludePatterns: [],
  limits: {
    maxPages: 2000,
    maxDepth: 5,
    maxTotalSizeMb: 2048,
    maxAssetSizeMb: 50,
    timeoutMinutes: 120,
    retries: 3,
  },
}

export const defaultSettings = (outputDirectory: string): Settings => ({
  outputDirectory,
  autoOpenOnSuccess: true,
})

const defaultWebOutputDirectory = (): string => path.resolve(process.cwd(), 'bind')

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

const envString = (name: string, fallback: string): string => {
  const value = process.env[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

const toAbsolutePath = (value: string, label: string): string => {
  if (!value.startsWith('/')) {
    throw new Error(`${label} must be an absolute path. Received: ${value}`)
  }

  return value
}

export const readConfigFromEnv = (): WebApiConfig => {
  const outputDirectory = toAbsolutePath(
    envString('ZIMPLE_OUTPUT_DIR', defaultWebOutputDirectory()),
    'ZIMPLE_OUTPUT_DIR',
  )
  const dataDirectory = toAbsolutePath(
    envString('ZIMPLE_DATA_DIR', '/data'),
    'ZIMPLE_DATA_DIR',
  )

  return {
    bindAddress: envString('ZIMPLE_BIND_ADDRESS', '127.0.0.1'),
    port: envInt('ZIMPLE_PORT', 8080),
    outputDirectory,
    dataDirectory,
    dockerSocketPath: envString('ZIMPLE_DOCKER_SOCKET', '/var/run/docker.sock'),
    zimitImage: envString('ZIMPLE_ZIMIT_IMAGE', 'ghcr.io/openzim/zimit'),
    dockerHost: process.env.DOCKER_HOST?.trim() || null,
  }
}
