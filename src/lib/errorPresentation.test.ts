import { describe, expect, it } from 'vitest'
import { interpretError, summarizeErrorForToast } from './errorPresentation'

describe('errorPresentation', () => {
  it('interprets exit code 3 disk-utilization failures', () => {
    const raw =
      'zimit container failed with exit code 3. Detected output filesystem usage: 99%. Last output: Out of disk space, exiting. Quitting'

    const interpreted = interpretError(raw)
    expect(interpreted).not.toBeNull()
    expect(interpreted?.headline).toContain('output drive is too full')
    expect(interpreted?.detail).toContain('99%')
    expect(interpreted?.actions.length).toBeGreaterThan(0)
  })

  it('interprets conversion timeout failures', () => {
    const raw =
      'zimit container failed with exit code 15. Last output: Crawl completed. Starting ZIM conversion...'
    const interpreted = interpretError(raw)
    expect(interpreted?.headline).toContain('timed out during archive conversion')
  })

  it('keeps unknown failures as generic messages', () => {
    const raw = 'unexpected runtime error'
    const interpreted = interpretError(raw)
    expect(interpreted?.headline).toBe('Capture failed.')
    expect(interpreted?.raw).toBe(raw)
  })

  it('interprets profile lock failures on exit code 9', () => {
    const raw =
      'zimit container failed with exit code 9. Last output: Crawl failed | The browser is already running for /output/.tmp123/profile'
    const interpreted = interpretError(raw)
    expect(interpreted?.headline).toContain('profile lock conflict')
    expect(interpreted?.actions.join(' ')).toContain('ZIMPLE_STAGING_DIR')
  })

  it('summarizes messages for toast display', () => {
    const raw =
      'zimit container failed with exit code 3. Detected output filesystem usage: 98%. Last output: Out of disk space, exiting. Quitting'
    const summary = summarizeErrorForToast(raw)
    expect(summary).toContain('Capture cannot start because the output drive is too full')
    expect(summary).toContain('98%')
    expect(summary).not.toContain('Last output:')
  })
})
