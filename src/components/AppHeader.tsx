import { Gauge, Layers3, PanelLeft, Plus, Rocket, Settings } from 'lucide-react'
import type { RuntimeHealth } from '../lib/types'

interface AppHeaderProps {
  runtimeHealth: RuntimeHealth | null
  activeJobCount: number
  queuedJobCount: number
  showQueueToggle: boolean
  queueOpen: boolean
  onCreateJob: () => void
  onToggleQueue: () => void
  onOpenSettings: () => void
}

function AppHeader({
  runtimeHealth,
  activeJobCount,
  queuedJobCount,
  showQueueToggle,
  queueOpen,
  onCreateJob,
  onToggleQueue,
  onOpenSettings,
}: AppHeaderProps) {
  return (
    <header className="pane app-header" aria-label="app-header">
      <div className="brand-block">
        <p className="brand-kicker">Offline Publishing Studio</p>
        <h1>Zimple</h1>
        <p className="brand-subtitle">
          Queue website captures, monitor progress, and export Kiwix-ready ZIM files.
        </p>
      </div>

      <div className="header-metrics" aria-label="runtime-status">
        <article className="metric-card">
          <p className="metric-label"><Gauge size={14} /> Runtime</p>
          <p className={`metric-value ${runtimeHealth?.ready ? 'ok' : 'warn'}`}>
            {runtimeHealth?.ready
              ? 'Ready'
              : runtimeHealth?.message ?? 'Checking Docker + zimit runtime...'}
          </p>
        </article>
        <article className="metric-card">
          <p className="metric-label"><Rocket size={14} /> Active</p>
          <p className="metric-value">{activeJobCount}</p>
        </article>
        <article className="metric-card">
          <p className="metric-label"><Layers3 size={14} /> Queued</p>
          <p className="metric-value">{queuedJobCount}</p>
        </article>
      </div>

      <div className="header-actions">
        {showQueueToggle && (
          <button type="button" className="ghost" onClick={onToggleQueue}>
            <PanelLeft size={16} />
            {queueOpen ? 'Hide Jobs' : 'Jobs'}
          </button>
        )}
        <button type="button" className="ghost" onClick={onOpenSettings}>
          <Settings size={16} />
          Settings
        </button>
        <button type="button" onClick={onCreateJob}>
          <Plus size={16} />
          Add Job
        </button>
      </div>
    </header>
  )
}

export default AppHeader
