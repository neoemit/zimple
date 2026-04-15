import fs from 'node:fs/promises'
import path from 'node:path'
import { defaultSettings } from './defaults.js'
import type { Settings, WebApiConfig } from './types.js'

const settingsPath = (config: WebApiConfig): string =>
  path.join(config.dataDirectory, 'settings.json')

export const loadSettings = async (config: WebApiConfig): Promise<Settings> => {
  await fs.mkdir(config.dataDirectory, { recursive: true })
  const file = settingsPath(config)

  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as Settings
    return {
      outputDirectory:
        typeof parsed.outputDirectory === 'string' && parsed.outputDirectory.trim().length > 0
          ? parsed.outputDirectory.trim()
          : config.outputDirectory,
      autoOpenOnSuccess: parsed.autoOpenOnSuccess !== false,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultSettings(config.outputDirectory)
    }

    throw new Error(`Unable to load settings: ${(error as Error).message}`)
  }
}

export const saveSettings = async (
  config: WebApiConfig,
  settings: Settings,
): Promise<Settings> => {
  await fs.mkdir(config.dataDirectory, { recursive: true })

  const normalized: Settings = {
    outputDirectory:
      typeof settings.outputDirectory === 'string' && settings.outputDirectory.trim().length > 0
        ? settings.outputDirectory.trim()
        : config.outputDirectory,
    autoOpenOnSuccess: settings.autoOpenOnSuccess !== false,
  }

  await fs.writeFile(settingsPath(config), JSON.stringify(normalized, null, 2), 'utf8')
  return normalized
}
