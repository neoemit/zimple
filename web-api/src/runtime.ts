import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import type { ChildProcess } from 'node:child_process'
import type { RuntimeHealth, StartJobRequest, WebApiConfig } from './types.js'

const IDENTITY_ENCODING_DRIVER_SOURCE = `export default async ({ page, data, crawler, seed }) => {
  await page.setExtraHTTPHeaders({ "Accept-Encoding": "identity" });
  await crawler.loadPage(page, data, seed);
};
`
const ZIMIT_CONVERSION_HEADROOM_SECONDS = 15 * 60
const ATTEMPT_TIMEOUT_HEADROOM_SECONDS = 60

export interface DockerRunResult {
  success: boolean
  errorMessage?: string
  retryable?: boolean
  exitCode?: number | null
}

export interface ZimitRunOptions {
  resumeConfigPath?: string | null
  saveStateIntervalSeconds?: number
}

const dockerEnv = (config: WebApiConfig): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env }

  if (config.dockerHost) {
    env.DOCKER_HOST = config.dockerHost
  } else if (config.dockerSocketPath) {
    env.DOCKER_HOST = `unix://${config.dockerSocketPath}`
  }

  return env
}

const commandResult = (
  command: string,
  args: string[],
  config: WebApiConfig,
): Promise<{ success: boolean; output: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: dockerEnv(config),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      resolve({
        success: code === 0,
        output,
      })
    })
  })

const commandSuceeds = async (
  command: string,
  args: string[],
  config: WebApiConfig,
): Promise<boolean> => {
  try {
    const result = await commandResult(command, args, config)
    return result.success
  } catch {
    return false
  }
}

const isDockerNoiseLine = (line: string): boolean => {
  const lowered = line.toLowerCase()
  if (lowered.startsWith('digest:') || lowered.startsWith('status:')) {
    return true
  }

  if (lowered.includes('pulling from') || lowered.includes('pull complete')) {
    return true
  }

  const parts = line.split(':')
  if (parts.length >= 2) {
    const layerPrefix = parts[0]
    const isHexLayer = layerPrefix.length >= 12 && /^[0-9a-f]+$/i.test(layerPrefix)
    if (isHexLayer) {
      const suffix = parts.slice(1).join(':').trim().toLowerCase()
      return (
        suffix === 'already exists' ||
        suffix === 'download complete' ||
        suffix === 'pull complete' ||
        suffix === 'waiting' ||
        suffix.startsWith('extracting') ||
        suffix.startsWith('verifying checksum')
      )
    }
  }

  return false
}

const normalizeZimitLogLine = (line: string): string | null => {
  try {
    const parsed = JSON.parse(line) as {
      message?: string
      context?: string
      logLevel?: string
      details?: Record<string, unknown>
    }

    const message = parsed.message || ''
    const context = parsed.context || ''
    const level = parsed.logLevel || ''
    const details = parsed.details || {}

    if (context === 'redis' && level === 'warn') {
      return null
    }

    if (message === 'Starting page') {
      const page = typeof details.page === 'string' ? details.page : 'unknown'
      return `Starting page crawl: ${page}`
    }
    if (message === 'Page Finished') {
      const page = typeof details.page === 'string' ? details.page : 'unknown'
      return `Page finished: ${page}`
    }
    if (message === 'Crawl statistics') {
      const crawled = Number(details.crawled ?? 0)
      const total = Number(details.total ?? 0)
      const pending = Number(details.pending ?? 0)
      const failed = Number(details.failed ?? 0)
      return `Crawl progress: ${crawled}/${total} crawled, ${pending} pending, ${failed} failed`
    }
    if (message === 'Crawling done') {
      return 'Crawl completed. Starting ZIM conversion...'
    }
    if (!message) {
      return null
    }

    if (!context || ['general', 'worker', 'pageStatus', 'crawlStatus'].includes(context)) {
      return message
    }

    return `${context}: ${message}`
  } catch {
    return line
  }
}

const pushRecentLine = (recentLines: string[], line: string): void => {
  const trimmed = line.trim()
  if (!trimmed) {
    return
  }

  const compact =
    trimmed.length > 280 ? `${trimmed.slice(0, 280).trimEnd()}...` : trimmed
  if (recentLines[recentLines.length - 1] === compact) {
    return
  }
  recentLines.push(compact)
  if (recentLines.length > 6) {
    recentLines.shift()
  }
}

const dockerMountPath = (value: string): string => {
  if (/^[A-Za-z]:\\/.test(value)) {
    const drive = value[0].toLowerCase()
    const rest = value.slice(2).replace(/\\/g, '/').replace(/^\/+/, '')
    return `/${drive}/${rest}`
  }
  return value
}

const hostPathToOutputContainerPath = (
  hostPath: string,
  outputDirectory: string,
): string | null => {
  const relativePath = path.relative(outputDirectory, hostPath)
  if (
    relativePath.length === 0 ||
    relativePath === '.' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  ) {
    const normalized =
      relativePath.length === 0 || relativePath === '.'
        ? ''
        : relativePath.replace(/\\/g, '/')
    return normalized.length > 0 ? `/output/${normalized}` : '/output'
  }
  return null
}

const makeDriverPath = (outputDirectory: string, containerName: string): string =>
  path.join(outputDirectory, `.zimple-driver-${containerName}.mjs`)

const filesystemUsagePercent = (targetPath: string): Promise<number | null> =>
  new Promise((resolve) => {
    const child = spawn('df', ['-P', targetPath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let output = ''

    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.on('error', () => {
      resolve(null)
    })
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }

      const lines = output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      const usageLine = lines[1]
      if (!usageLine) {
        resolve(null)
        return
      }

      const percentField = usageLine
        .split(/\s+/)
        .find((value) => value.endsWith('%'))
      if (!percentField) {
        resolve(null)
        return
      }

      const percent = Number.parseInt(percentField.slice(0, -1), 10)
      resolve(Number.isNaN(percent) ? null : percent)
    })
  })

const escapeRegexFragment = (value: string): string =>
  value.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')

const normalizeScopedPath = (pathname: string): string | null => {
  if (!pathname || pathname === '/') {
    return null
  }

  const trimmed = pathname.replace(/\/+$/, '')
  if (!trimmed || trimmed === '/') {
    return null
  }

  return trimmed
}

const derivePathPrefixIncludePattern = (targetUrl: string): string | null => {
  try {
    const parsed = new URL(targetUrl)
    const scopedPath = normalizeScopedPath(parsed.pathname)
    if (!scopedPath) {
      return null
    }
    return `^https?://[^/]+${escapeRegexFragment(scopedPath)}(?:$|[/?#].*)`
  } catch {
    return null
  }
}

const effectiveIncludePatterns = (request: StartJobRequest): string[] => {
  if (request.crawl.includePatterns.length > 0) {
    return request.crawl.includePatterns
  }

  const derived = derivePathPrefixIncludePattern(request.url)
  return derived ? [derived] : []
}

export const containerNameForJob = (jobId: string): string => {
  const suffix = jobId.slice(0, 12)
  return `zimple-${suffix}`
}

export const retryDelaySeconds = (attemptIndex: number): number => {
  const exponent = Math.min(Math.max(attemptIndex, 0), 4)
  return 2 ** exponent
}

export const sleepForRetry = (attemptIndex: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, retryDelaySeconds(attemptIndex) * 1000)
  })

export const zimitTimeHardLimitSeconds = (timeoutMinutes: number): number =>
  Math.max(timeoutMinutes, 1) * 60 + ZIMIT_CONVERSION_HEADROOM_SECONDS

export const zimitAttemptTimeoutMs = (timeoutMinutes: number): number =>
  (zimitTimeHardLimitSeconds(timeoutMinutes) + ATTEMPT_TIMEOUT_HEADROOM_SECONDS) * 1000

export const buildDockerArgs = (
  request: StartJobRequest,
  outputDirectory: string,
  outputFilename: string,
  containerName: string,
  zimitImage: string,
  driverContainerPath?: string,
  options?: ZimitRunOptions,
): string[] => {
  const includePatterns = effectiveIncludePatterns(request)
  const sizeHardLimitBytes = Math.max(request.crawl.limits.maxTotalSizeMb, 1) * 1024 * 1024
  const timeHardLimitSeconds = zimitTimeHardLimitSeconds(request.crawl.limits.timeoutMinutes)
  const saveStateIntervalSeconds = Math.max(
    Math.floor(options?.saveStateIntervalSeconds ?? 60),
    10,
  )
  const args = [
    'run',
    '--rm',
    '--name',
    containerName,
    '-v',
    `${dockerMountPath(outputDirectory)}:/output`,
    zimitImage,
    'zimit',
    '--seeds',
    request.url.trim(),
    '--name',
    outputFilename,
    '--output',
    '/output',
    '--scopeType',
    includePatterns.length > 0 ? 'custom' : 'domain',
    '--diskUtilization',
    '0',
    '-w',
    String(request.crawl.workers),
    '--depth',
    String(request.crawl.limits.maxDepth),
    '--pageLimit',
    String(request.crawl.limits.maxPages),
    '--maxPageRetries',
    String(request.crawl.limits.retries),
    '--timeHardLimit',
    String(timeHardLimitSeconds),
    '--sizeHardLimit',
    String(sizeHardLimitBytes),
    '--saveState',
    'partial',
    '--saveStateInterval',
    String(saveStateIntervalSeconds),
    '--keep',
  ]

  if (driverContainerPath) {
    args.push('--driver', driverContainerPath)
  }

  if (options?.resumeConfigPath) {
    const resumeConfigContainerPath = hostPathToOutputContainerPath(
      options.resumeConfigPath,
      outputDirectory,
    )
    if (resumeConfigContainerPath) {
      args.push('--config', resumeConfigContainerPath)
    }
  }

  for (const pattern of includePatterns) {
    args.push('--scopeIncludeRx', pattern)
  }
  for (const pattern of request.crawl.excludePatterns) {
    args.push('--scopeExcludeRx', pattern)
  }

  return args
}

export const checkRuntimeHealth = async (config: WebApiConfig): Promise<RuntimeHealth> => {
  const dockerInstalled = await commandSuceeds('docker', ['--version'], config)
  if (!dockerInstalled) {
    return {
      dockerInstalled: false,
      dockerResponsive: false,
      zimitImagePresent: false,
      ready: false,
      message: 'Docker is not installed or is not available on PATH.',
    }
  }

  const dockerResponsive = await commandSuceeds(
    'docker',
    ['info', '--format', '{{.ServerVersion}}'],
    config,
  )
  if (!dockerResponsive) {
    return {
      dockerInstalled: true,
      dockerResponsive: false,
      zimitImagePresent: false,
      ready: false,
      message: 'Docker is installed but the daemon is not reachable.',
    }
  }

  const zimitImagePresent = await commandSuceeds(
    'docker',
    ['image', 'inspect', config.zimitImage],
    config,
  )

  return {
    dockerInstalled: true,
    dockerResponsive: true,
    zimitImagePresent,
    ready: true,
    message: zimitImagePresent
      ? 'Runtime ready. ZIM jobs can be started.'
      : `Docker is ready. Pulling ${config.zimitImage} may be required on first run.`,
  }
}

export const ensureZimitImage = async (
  config: WebApiConfig,
  timeoutMs: number,
): Promise<boolean> => {
  const inspect = await commandResult(
    'docker',
    ['image', 'inspect', config.zimitImage],
    config,
  )
  if (inspect.success) {
    return false
  }

  const pullChild = spawn('docker', ['pull', '--quiet', config.zimitImage], {
    env: dockerEnv(config),
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  const result = await Promise.race([
    new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      let stderr = ''
      pullChild.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      pullChild.on('error', reject)
      pullChild.on('close', (code) => resolve({ code, stderr }))
    }),
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      setTimeout(() => {
        pullChild.kill('SIGTERM')
        resolve({
          code: null,
          stderr: 'Timed out while preparing zimit runtime image.',
        })
      }, timeoutMs)
    }),
  ])

  if (result.code === 0) {
    return true
  }

  const lastError = result.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)

  throw new Error(
    `Failed to prepare zimit runtime image: ${lastError || 'Unknown Docker pull error'}`,
  )
}

export const runZimitOnce = async (
  config: WebApiConfig,
  request: StartJobRequest,
  outputDirectory: string,
  outputFilename: string,
  containerName: string,
  onLog: (line: string) => void,
  onProcess: (child: ChildProcess) => void,
  options?: ZimitRunOptions,
): Promise<DockerRunResult> => {
  await fs.mkdir(outputDirectory, { recursive: true })

  const driverPath = makeDriverPath(outputDirectory, containerName)
  await fs.writeFile(driverPath, IDENTITY_ENCODING_DRIVER_SOURCE, 'utf8')

  const args = buildDockerArgs(
    request,
    outputDirectory,
    outputFilename,
    containerName,
    config.zimitImage,
    `/output/${path.basename(driverPath)}`,
    options,
  )

  const child = spawn('docker', args, {
    env: dockerEnv(config),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  onProcess(child)

  const recentOutput: string[] = []
  const consume = (stream: NodeJS.ReadableStream): Promise<void> =>
    new Promise((resolve) => {
      const reader = readline.createInterface({ input: stream })
      reader.on('line', (line) => {
        if (isDockerNoiseLine(line)) {
          return
        }

        const normalized = normalizeZimitLogLine(line)
        if (!normalized) {
          return
        }
        pushRecentLine(recentOutput, normalized)
        onLog(normalized)
      })
      reader.on('close', resolve)
    })

  const waitForExit = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve(code))
  })

  try {
    await Promise.all([consume(child.stdout), consume(child.stderr), waitForExit])
    const exitCode = await waitForExit

    if (exitCode === 0) {
      return { success: true, retryable: false, exitCode }
    }

    let message =
      exitCode === null
        ? 'zimit container terminated by signal.'
        : `zimit container failed with exit code ${exitCode}.`
    let retryable = true

    if (exitCode === 2) {
      retryable = false
      message +=
        ' Exit code 2 usually means zimit rejected one or more options or the output archive name already exists.'
    }
    if (exitCode === 3) {
      retryable = false
      const usage = await filesystemUsagePercent(outputDirectory)
      message +=
        ' Exit code 3 indicates browsertrix stopped due output filesystem space/utilization checks. Browsertrix has a hard stop when output filesystem usage reaches 99% or more.'
      if (usage !== null) {
        message += ` Detected output filesystem usage: ${usage}%.`
      }
    }
    if (exitCode === 15) {
      retryable = false
      if (recentOutput.some((line) => line.includes('Crawl completed. Starting ZIM conversion'))) {
        message +=
          ' Exit code 15 after crawl completion usually means the runtime was interrupted during conversion by a time limit; increase timeout minutes.'
      } else {
        message +=
          ' Exit code 15 indicates the runtime was interrupted (timeout or external stop request).'
      }
    }
    if (recentOutput.length > 0) {
      message += ` Last output: ${recentOutput.join(' | ')}`
    }

    return {
      success: false,
      errorMessage: message,
      retryable,
      exitCode,
    }
  } finally {
    await fs.unlink(driverPath).catch(() => undefined)
  }
}

export const stopContainer = async (
  config: WebApiConfig,
  containerName: string,
): Promise<boolean> =>
  commandSuceeds('docker', ['rm', '-f', containerName], config)
