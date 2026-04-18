import { Settings, X } from 'lucide-react'
import type { Dispatch, SetStateAction } from 'react'
import type { CrawlOptions, StartJobRequest } from '../lib/types'

interface CaptureSettingsModalProps {
  request: StartJobRequest
  setRequest: Dispatch<SetStateAction<StartJobRequest>>
  onClose: () => void
}

const toPatternText = (patterns: string[]): string => patterns.join('\n')

const fromPatternText = (value: string): string[] =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

function CaptureSettingsModal({
  request,
  setRequest,
  onClose,
}: CaptureSettingsModalProps) {
  const updateCrawlOptions = (nextCrawl: CrawlOptions): void => {
    setRequest((current) => ({ ...current, crawl: nextCrawl }))
  }

  const updateLimits = (field: keyof CrawlOptions['limits'], value: number): void => {
    updateCrawlOptions({
      ...request.crawl,
      limits: {
        ...request.crawl.limits,
        [field]: value,
      },
    })
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal-card modal-card-large"
        role="dialog"
        aria-modal="true"
        aria-label="capture-settings-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2>Capture Settings</h2>
            <p>Per-job advanced crawl controls.</p>
          </div>
          <button type="button" className="ghost mini-action" onClick={onClose}>
            <X size={15} />
            Close
          </button>
        </div>

        <div className="modal-body" aria-label="advanced-options">
          <details className="accordion">
            <summary>Limits and workers</summary>
            <div className="accordion-body">
              <div className="input-grid">
                <label>
                  Workers
                  <input
                    aria-label="Workers"
                    type="number"
                    min={1}
                    max={12}
                    value={request.crawl.workers}
                    onChange={(event) =>
                      updateCrawlOptions({
                        ...request.crawl,
                        workers: Number(event.target.value),
                      })
                    }
                  />
                </label>

                <label>
                  Max Pages
                  <input
                    type="number"
                    min={1}
                    value={request.crawl.limits.maxPages}
                    onChange={(event) => updateLimits('maxPages', Number(event.target.value))}
                  />
                </label>

                <label>
                  Max Depth
                  <input
                    type="number"
                    min={1}
                    value={request.crawl.limits.maxDepth}
                    onChange={(event) => updateLimits('maxDepth', Number(event.target.value))}
                  />
                </label>

                <label>
                  Total Size (MB)
                  <input
                    type="number"
                    min={64}
                    value={request.crawl.limits.maxTotalSizeMb}
                    onChange={(event) =>
                      updateLimits('maxTotalSizeMb', Number(event.target.value))
                    }
                  />
                </label>

                <label>
                  Per Asset (MB)
                  <input
                    type="number"
                    min={1}
                    value={request.crawl.limits.maxAssetSizeMb}
                    onChange={(event) =>
                      updateLimits('maxAssetSizeMb', Number(event.target.value))
                    }
                  />
                </label>

                <label>
                  Timeout (minutes)
                  <input
                    type="number"
                    min={5}
                    value={request.crawl.limits.timeoutMinutes}
                    onChange={(event) =>
                      updateLimits('timeoutMinutes', Number(event.target.value))
                    }
                  />
                </label>

                <label>
                  Retries
                  <input
                    type="number"
                    min={0}
                    max={6}
                    value={request.crawl.limits.retries}
                    onChange={(event) => updateLimits('retries', Number(event.target.value))}
                  />
                </label>
              </div>
            </div>
          </details>

          <details className="accordion">
            <summary>Crawl scope</summary>
            <div className="accordion-body">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={request.crawl.respectRobots}
                  onChange={(event) =>
                    updateCrawlOptions({
                      ...request.crawl,
                      respectRobots: event.target.checked,
                    })
                  }
                />
                Respect robots.txt by default
              </label>

              <div className="form-grid">
                <label>
                  Include Patterns (one per line)
                  <textarea
                    value={toPatternText(request.crawl.includePatterns)}
                    onChange={(event) =>
                      updateCrawlOptions({
                        ...request.crawl,
                        includePatterns: fromPatternText(event.target.value),
                      })
                    }
                  />
                </label>

                <label>
                  Exclude Patterns (one per line)
                  <textarea
                    value={toPatternText(request.crawl.excludePatterns)}
                    onChange={(event) =>
                      updateCrawlOptions({
                        ...request.crawl,
                        excludePatterns: fromPatternText(event.target.value),
                      })
                    }
                  />
                </label>
              </div>
            </div>
          </details>
        </div>

        <div className="modal-footer">
          <button type="button" onClick={onClose}>
            <Settings size={16} />
            Done
          </button>
        </div>
      </section>
    </div>
  )
}

export default CaptureSettingsModal
