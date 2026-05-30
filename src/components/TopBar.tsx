import { useMemo } from 'react'
import type { Repo } from '../data/types'
import './TopBar.css'

interface Props {
  repos: Repo[]
  selectedRepoId: string
  onSelectRepo: (id: string) => void
  dateRangeLabel: string
  syncedAt: string
  query: string
  onQueryChange: (q: string) => void
  onOpenSettings: () => void
}

export function TopBar({ repos, selectedRepoId, onSelectRepo, dateRangeLabel, syncedAt, query, onQueryChange, onOpenSettings }: Props) {
  const syncedLabel = useMemo(() => formatSynced(syncedAt), [syncedAt])
  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__brand-mark" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="2.2" />
            <circle cx="18" cy="6" r="2.2" />
            <circle cx="12" cy="18" r="2.2" />
            <path d="M6 8.2v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-3" />
            <path d="M12 14.2v1.6" />
          </svg>
        </span>
        <span className="topbar__brand-title">Codex Worktree Map</span>
      </div>

      <div className="topbar__divider" />

      <label className="topbar__chip topbar__repo">
        <span className="topbar__chip-icon" aria-hidden>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
        </span>
        <select value={selectedRepoId} onChange={(e) => onSelectRepo(e.target.value)}>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} ({r.sessionCount})
            </option>
          ))}
        </select>
      </label>

      <div className="topbar__chip topbar__date">
        <span className="topbar__chip-icon" aria-hidden>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
        </span>
        <span>{dateRangeLabel || '—'}</span>
      </div>

      <div className="topbar__search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="topbar__search-icon">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="text"
          placeholder="Search commits, branches, worktrees, sessions…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
      </div>

      <div className="topbar__spacer" />

      <span className="topbar__badge topbar__badge--readonly" title="SessionTree never modifies your repo or sessions">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        Read-only
      </span>
      <span className="topbar__synced">
        <span className="topbar__synced-dot" />
        {syncedLabel}
      </span>
      <button className="topbar__icon-btn" title="Settings" onClick={onOpenSettings}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      </button>
    </header>
  )
}

function formatSynced(iso: string): string {
  if (!iso) return 'Synced —'
  const now = Date.now()
  const t = new Date(iso).getTime()
  const diffSec = Math.max(0, Math.round((now - t) / 1000))
  if (diffSec < 5) return 'Synced just now'
  if (diffSec < 60) return `Synced ${diffSec}s ago`
  if (diffSec < 3600) return `Synced ${Math.floor(diffSec / 60)}m ago`
  return `Synced ${Math.floor(diffSec / 3600)}h ago`
}
