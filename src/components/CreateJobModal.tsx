import { Loader2, PlayCircle, Settings, X, XCircle } from 'lucide-react'
import type { Dispatch, FormEvent, SetStateAction } from 'react'
import type { StartJobRequest } from '../lib/types'
import { applyAutofilledMetadataForUrl } from '../lib/captureMetadata'

interface CreateJobModalProps {
  request: StartJobRequest
  submitting: boolean
  setRequest: Dispatch<SetStateAction<StartJobRequest>>
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onOpenCaptureSettings: () => void
  onClose: () => void
}

function CreateJobModal({
  request,
  submitting,
  setRequest,
  onSubmit,
  onOpenCaptureSettings,
  onClose,
}: CreateJobModalProps) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal-card modal-card-compact"
        role="dialog"
        aria-modal="true"
        aria-label="create-job-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2>Create Capture Job</h2>
            <p>Quick flow for adding a new website capture.</p>
          </div>
          <button type="button" className="ghost mini-action" onClick={onClose}>
            <X size={15} />
            Close
          </button>
        </div>

        <div className="modal-body">
          <form className="modal-form" onSubmit={(event) => void onSubmit(event)}>
            <label>
              Website URL
              <input
                aria-label="website-url"
                type="url"
                placeholder="https://example.com"
                value={request.url}
                onChange={(event) =>
                  setRequest((current) =>
                    applyAutofilledMetadataForUrl(current, event.target.value),
                  )
                }
                required
              />
            </label>

            <details className="accordion">
              <summary>Optional fields</summary>
              <div className="accordion-body">
                <label>
                  Output Filename (optional)
                  <input
                    aria-label="output-filename"
                    type="text"
                    placeholder="example-archive"
                    value={request.outputFilename ?? ''}
                    onChange={(event) =>
                      setRequest((current) => ({
                        ...current,
                        outputFilename: event.target.value || null,
                      }))
                    }
                  />
                </label>

                <label>
                  Capture Title (optional)
                  <input
                    aria-label="capture-title"
                    type="text"
                    value={request.title ?? ''}
                    onChange={(event) =>
                      setRequest((current) => ({
                        ...current,
                        title: event.target.value || null,
                      }))
                    }
                  />
                </label>

                <label>
                  Description (optional)
                  <input
                    aria-label="capture-description"
                    type="text"
                    value={request.description ?? ''}
                    onChange={(event) =>
                      setRequest((current) => ({
                        ...current,
                        description: event.target.value || null,
                      }))
                    }
                  />
                </label>

                <label>
                  Favicon URL (optional)
                  <input
                    aria-label="capture-favicon-url"
                    type="url"
                    value={request.faviconUrl ?? ''}
                    onChange={(event) =>
                      setRequest((current) => ({
                        ...current,
                        faviconUrl: event.target.value || null,
                      }))
                    }
                  />
                </label>
              </div>
            </details>

            <div className="modal-actions">
              <button type="button" className="ghost" onClick={onClose}>
                <XCircle size={16} />
                Cancel
              </button>
              <button type="button" className="ghost" onClick={onOpenCaptureSettings}>
                <Settings size={16} />
                Capture Settings
              </button>
              <button type="submit" disabled={submitting}>
                {submitting ? (
                  <><Loader2 size={16} className="spin" /> Queueing...</>
                ) : (
                  <><PlayCircle size={16} /> Start Processing</>
                )}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  )
}

export default CreateJobModal
