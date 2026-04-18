import { CheckCircle, FolderOpen, Loader2, Save, X } from 'lucide-react'
import type { Dispatch, SetStateAction } from 'react'
import type { Settings, ThemeMode } from '../lib/types'

interface AppSettingsModalProps {
  settings: Settings
  settingsDraft: string
  themeMode: ThemeMode
  savingSettings: boolean
  supportsDirectoryPicker: boolean
  setSettings: Dispatch<SetStateAction<Settings>>
  setSettingsDraft: (value: string) => void
  setThemeMode: (mode: ThemeMode) => void
  onSaveSettings: () => Promise<void>
  onBrowseDirectory: () => Promise<void>
  onClose: () => void
}

function AppSettingsModal({
  settings,
  settingsDraft,
  themeMode,
  savingSettings,
  supportsDirectoryPicker,
  setSettings,
  setSettingsDraft,
  setThemeMode,
  onSaveSettings,
  onBrowseDirectory,
  onClose,
}: AppSettingsModalProps) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal-card modal-card-compact"
        role="dialog"
        aria-modal="true"
        aria-label="app-settings-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2>App Settings</h2>
            <p>Global defaults for capture output and interface behavior.</p>
          </div>
          <button type="button" className="ghost mini-action" onClick={onClose}>
            <X size={15} />
            Close
          </button>
        </div>

        <div className="modal-body">
          <label>
            Default Output Directory
            <input
              aria-label="default-output-directory"
              type="text"
              value={settingsDraft}
              placeholder="Choose where generated .zim files should be saved"
              onChange={(event) => setSettingsDraft(event.target.value)}
            />
          </label>

          <div className="settings-actions">
            <button
              type="button"
              className="ghost"
              disabled={!supportsDirectoryPicker}
              onClick={() => void onBrowseDirectory()}
              title={
                supportsDirectoryPicker
                  ? 'Pick a directory from your file system'
                  : 'Directory picker is unavailable in Docker web mode'
              }
            >
              <FolderOpen size={16} />
              Browse
            </button>

            <button type="button" disabled={savingSettings} onClick={() => void onSaveSettings()}>
              {savingSettings ? (
                <><Loader2 size={16} className="spin" /> Saving...</>
              ) : (
                <><CheckCircle size={16} /> Save Settings</>
              )}
            </button>
          </div>

          <label>
            Theme
            <select
              aria-label="theme-mode"
              value={themeMode}
              onChange={(event) => setThemeMode(event.target.value as ThemeMode)}
            >
              <option value="system">System (Default)</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.autoOpenOnSuccess}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  autoOpenOnSuccess: event.target.checked,
                }))
              }
            />
            Auto-open completed output when a job succeeds
          </label>
        </div>

        <div className="modal-footer">
          <button type="button" className="ghost" onClick={onClose}>
            <Save size={16} />
            Done
          </button>
        </div>
      </section>
    </div>
  )
}

export default AppSettingsModal
