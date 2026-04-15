// @vitest-environment node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSettings, saveSettings } from './settings-store.js'
import type { WebApiConfig } from './types.js'

const makeConfig = (dataDirectory: string): WebApiConfig => ({
  bindAddress: '127.0.0.1',
  port: 8080,
  outputDirectory: '/tmp/zimple-output',
  dataDirectory,
  dockerSocketPath: '/var/run/docker.sock',
  zimitImage: 'ghcr.io/openzim/zimit',
  dockerHost: null,
})

describe('settings store', () => {
  it('returns defaults when no file exists and persists updates', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zimple-settings-'))
    const config = makeConfig(tempDir)

    const defaults = await loadSettings(config)
    expect(defaults.outputDirectory).toBe('/tmp/zimple-output')
    expect(defaults.autoOpenOnSuccess).toBe(true)

    const saved = await saveSettings(config, {
      outputDirectory: '/tmp/custom-zimple-output',
      autoOpenOnSuccess: false,
    })
    expect(saved.outputDirectory).toBe('/tmp/custom-zimple-output')
    expect(saved.autoOpenOnSuccess).toBe(false)

    const reloaded = await loadSettings(config)
    expect(reloaded.outputDirectory).toBe('/tmp/custom-zimple-output')
    expect(reloaded.autoOpenOnSuccess).toBe(false)

    await fs.rm(tempDir, { recursive: true, force: true })
  })
})
