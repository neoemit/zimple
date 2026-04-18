export interface InterpretedError {
  headline: string
  detail: string | null
  actions: string[]
  raw: string
}

const normalizeError = (value: string): string => value.trim()

const parseDetectedUsage = (raw: string): number | null => {
  const match = raw.match(/Detected output filesystem usage:\s*(\d+)%/i)
  if (!match) {
    return null
  }

  const parsed = Number.parseInt(match[1], 10)
  return Number.isNaN(parsed) ? null : parsed
}

export const interpretError = (rawMessage: string): InterpretedError | null => {
  const raw = normalizeError(rawMessage)
  if (!raw) {
    return null
  }

  const lowered = raw.toLowerCase()

  if (lowered.includes('exit code 3') || lowered.includes('out of disk space')) {
    const detectedUsage = parseDetectedUsage(raw)
    return {
      headline: 'Capture cannot start because the output drive is too full.',
      detail:
        detectedUsage !== null
          ? `Detected output filesystem usage is ${detectedUsage}%. Browsertrix hard-stops at 99% usage.`
          : 'Browsertrix hard-stops when output filesystem usage reaches 99%.',
      actions: [
        'Use an output directory on a different drive/volume with more free headroom.',
        'Free enough space to bring usage clearly below 99% (ideally 97% or lower).',
        'Retry the job after changing output storage.',
      ],
      raw,
    }
  }

  if (
    lowered.includes('exit code 15') &&
    (lowered.includes('starting zim conversion') || lowered.includes('conversion'))
  ) {
    return {
      headline: 'Capture timed out during archive conversion.',
      detail:
        'The crawl phase finished, but conversion was interrupted before the ZIM file was produced.',
      actions: [
        'Increase timeout minutes in capture settings.',
        'Reduce crawl scope (max pages/depth) to shorten conversion time.',
        'Retry after adjusting limits.',
      ],
      raw,
    }
  }

  if (lowered.includes('exit code 2')) {
    return {
      headline: 'Capture settings were rejected by the runtime.',
      detail:
        'This usually means an invalid option combination or an output naming conflict.',
      actions: [
        'Retry with default crawl settings.',
        'Use a different output filename.',
      ],
      raw,
    }
  }

  if (
    lowered.includes('exit code 9') &&
    lowered.includes('browser is already running for')
  ) {
    return {
      headline: 'Capture failed due to browser profile lock conflict.',
      detail:
        'This commonly occurs when crawling on CIFS/NFS output paths where Chromium profile locks are unreliable.',
      actions: [
        'Set ZIMPLE_STAGING_DIR to a local disk path and retry.',
        'Remove stale .tmp* crawl folders in the output directory after failed runs.',
        'Retry with workers set to 1 for server validation runs.',
      ],
      raw,
    }
  }

  if (lowered.includes('failed to fetch')) {
    return {
      headline: 'Could not reach the backend service.',
      detail:
        'The UI could not contact the API. The local service may not be running or reachable.',
      actions: [
        'Make sure the Docker web backend is running.',
        'Refresh the app after backend health is restored.',
      ],
      raw,
    }
  }

  return {
    headline: 'Capture failed.',
    detail: null,
    actions: [],
    raw,
  }
}

export const summarizeErrorForToast = (rawMessage: string): string => {
  const interpreted = interpretError(rawMessage)
  if (!interpreted) {
    return rawMessage
  }

  if (!interpreted.detail) {
    return interpreted.headline
  }

  return `${interpreted.headline} ${interpreted.detail}`
}
