import { useEffect, useMemo, useState } from 'react'
import type { ApiPayload, RepoBundle } from './data/types'
import { TopBar } from './components/TopBar'
import { GraphCanvas } from './components/GraphCanvas'
import './styles/app.css'

export type GraphFilter = 'all' | 'branches' | 'worktrees'

export interface Settings {
  /** how recent the last event must be for a session to count as "active" (hours) */
  activeThresholdHours: number
  /** show automation indicator on chips/cards */
  showAutomation: boolean
  /** pulse animation on running automations */
  animateRunning: boolean
}

const DEFAULT_SETTINGS: Settings = {
  activeThresholdHours: 24,
  showAutomation: true,
  animateRunning: true,
}

const SETTINGS_KEY = 'sessiontree.settings.v1'

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Settings) }
  } catch {
    /* ignore */
  }
  return DEFAULT_SETTINGS
}

export function App() {
  const [data, setData] = useState<ApiPayload | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null)
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null)
  const [pinnedSessionId, setPinnedSessionId] = useState<string | null>(null)
  const [pinnedCommitId, setPinnedCommitId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<GraphFilter>('all')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      /* ignore */
    }
  }, [settings])

  useEffect(() => {
    fetch('/api/data')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((p: ApiPayload) => {
        setData(p)
        setSelectedRepoId(p.defaultRepoId)
        const bundle = p.bundles[p.defaultRepoId]
        if (bundle) {
          const top = [...bundle.worktrees].sort((a, b) => b.sessionCount - a.sessionCount)[0]
          if (top) setSelectedWorktreeId(top.id)
        }
      })
      .catch((e) => setErr(String(e)))
  }, [])

  const bundle: RepoBundle | null = useMemo(() => {
    if (!data || !selectedRepoId) return null
    return data.bundles[selectedRepoId] || null
  }, [data, selectedRepoId])

  if (err) {
    return (
      <div className="app app--error">
        <div className="app__error-card">
          <h2>Failed to load data</h2>
          <pre>{err}</pre>
          <p>Make sure the dev server is running and <code>~/.codex/sessions</code> exists.</p>
        </div>
      </div>
    )
  }

  if (!data || !bundle) {
    return (
      <div className="app app--loading">
        <div className="app__loading-card">
          <div className="app__loading-spinner" />
          <div className="app__loading-label">Scanning Codex sessions & git history…</div>
          <div className="app__loading-sub">first scan can take ~1 minute</div>
        </div>
      </div>
    )
  }

  return (
    <div className="app app--fullcanvas">
      <TopBar
        repos={data.repos}
        selectedRepoId={selectedRepoId!}
        onSelectRepo={(id) => {
          setSelectedRepoId(id)
          setPinnedSessionId(null)
          setPinnedCommitId(null)
          const b = data.bundles[id]
          const top = b ? [...b.worktrees].sort((a, b) => b.sessionCount - a.sessionCount)[0] : null
          setSelectedWorktreeId(top?.id || null)
        }}
        dateRangeLabel={bundle.dateRange.label}
        syncedAt={data.syncedAt}
        query={query}
        onQueryChange={setQuery}
        onOpenSettings={() => setSettingsOpen((v) => !v)}
      />
      <GraphCanvas
        bundle={bundle}
        filter={filter}
        onFilterChange={setFilter}
        selectedWorktreeId={selectedWorktreeId}
        pinnedSessionId={pinnedSessionId}
        pinnedCommitId={pinnedCommitId}
        settings={settings}
        onSelectWorktree={(id) => setSelectedWorktreeId(id)}
        onPinSession={(id) => {
          setPinnedSessionId(id)
          setPinnedCommitId(null)
          if (id) {
            const s = bundle.sessions.find((x) => x.id === id)
            if (s) setSelectedWorktreeId(s.worktreeId)
          }
        }}
        onPinCommit={(id) => {
          setPinnedCommitId(id)
          setPinnedSessionId(null)
        }}
      />
      {settingsOpen && (
        <SettingsPopover
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}

function SettingsPopover({
  settings,
  onChange,
  onClose,
}: {
  settings: Settings
  onChange: (s: Settings) => void
  onClose: () => void
}) {
  return (
    <div className="settings-overlay" onMouseDown={onClose}>
      <div className="settings-popover" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-popover__head">
          <span>Settings</span>
          <button className="settings-popover__close" onClick={onClose}>×</button>
        </div>

        <div className="settings-popover__group">
          <label className="settings-popover__label">
            Activity threshold
            <span className="settings-popover__hint">
              A session is "active" if its last event is within this window.
            </span>
          </label>
          <div className="settings-popover__row">
            {[1, 6, 24, 24 * 7, 24 * 30].map((h) => (
              <button
                key={h}
                className={`settings-chip${settings.activeThresholdHours === h ? ' settings-chip--active' : ''}`}
                onClick={() => onChange({ ...settings, activeThresholdHours: h })}
              >
                {h < 24 ? `${h}h` : h === 24 ? '24h' : `${h / 24}d`}
              </button>
            ))}
            <span className="settings-popover__current">
              currently: <b>{formatHours(settings.activeThresholdHours)}</b>
            </span>
          </div>
        </div>

        <div className="settings-popover__group">
          <label className="settings-popover__toggle">
            <input
              type="checkbox"
              checked={settings.showAutomation}
              onChange={(e) => onChange({ ...settings, showAutomation: e.target.checked })}
            />
            Show Codex automation indicators
          </label>
          <label className="settings-popover__toggle">
            <input
              type="checkbox"
              checked={settings.animateRunning}
              onChange={(e) => onChange({ ...settings, animateRunning: e.target.checked })}
            />
            Pulse animation on running automations
          </label>
        </div>

        <div className="settings-popover__footer">
          Stored locally in your browser. SessionTree never writes back to <code>~/.codex</code>.
        </div>
      </div>
    </div>
  )
}

function formatHours(h: number): string {
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`
  const d = h / 24
  return `${d} day${d === 1 ? '' : 's'}`
}
