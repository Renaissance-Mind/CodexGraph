import { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import type { Branch, CodexSession, Commit, RepoBundle, WorktreeStatus } from '../data/types'
import type { GraphFilter, Settings } from '../App'
import './GraphCanvas.css'

interface Props {
  bundle: RepoBundle
  filter: GraphFilter
  onFilterChange: (f: GraphFilter) => void
  selectedWorktreeId: string | null
  pinnedSessionId: string | null
  pinnedCommitId: string | null
  settings: Settings
  onSelectWorktree: (id: string) => void
  onPinSession: (id: string | null) => void
  onPinCommit: (id: string | null) => void
}

export type SessionVisualState = 'inactive' | 'active' | 'automated' | 'running'

export function sessionState(
  s: CodexSession,
  now: number,
  thresholdHours: number,
): SessionVisualState {
  const lastTs = new Date(s.endDate || s.date).getTime() || 0
  const active = now - lastTs < thresholdHours * 3600 * 1000
  if (s.automation && s.automation.status === 'ACTIVE') return 'running'
  if (s.automation) return 'automated'
  return active ? 'active' : 'inactive'
}

// ---- geometry constants ----
// Coordinate model: X is zoomable (time). Y is SCREEN-space — lanes are laid out
// in fixed pixel bands whose height grows to fit each lane's packed card rows, so
// cards never overlap each other or neighbouring lanes. Only pan moves Y.
const COMMIT_DX = 26          // world px between adjacent commit columns (before zoom)
const PADDING_LEFT = 130      // world px before first commit (room for fork-in)
const PADDING_RIGHT = 80
const AXIS_HEIGHT = 32
const COMMIT_RADIUS = 4
const HEAD_OFFSET = 16

const CARD_W = 300            // session card width (screen px, constant)
const CARD_H = 50             // session card height (screen px, 2 lines)
const CARD_GAP_X = 10         // min horizontal gap between cards in a row
const CARD_GAP_Y = 8          // vertical gap between card rows
const LANE_LINE_PAD = 22      // gap between the lane line and the nearest card row
const LANE_BASE_PAD = 30      // padding below a lane line before the next lane
const LANE_MIN_TOP = 26       // min space above a lane line when it has no cards

const MIN_ZOOM = 0.2
const MAX_ZOOM = 4

export function GraphCanvas({
  bundle,
  filter,
  onFilterChange,
  selectedWorktreeId,
  pinnedSessionId,
  pinnedCommitId,
  settings,
  onSelectWorktree,
  onPinSession,
  onPinCommit,
}: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null)
  const [hoveredCommitId, setHoveredCommitId] = useState<string | null>(null)
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 1200, h: 700 })
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 })

  const now = useMemo(() => Date.now(), [bundle])
  const sessionStateMap = useMemo(() => {
    const m = new Map<string, SessionVisualState>()
    for (const s of bundle.sessions) m.set(s.id, sessionState(s, now, settings.activeThresholdHours))
    return m
  }, [bundle.sessions, now, settings.activeThresholdHours])

  // author filter
  const allAuthors = useMemo(() => {
    const map = new Map<string, number>()
    for (const c of bundle.commits) {
      const n = c.author || '(unknown)'
      map.set(n, (map.get(n) || 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [bundle.commits])
  const [authorFilter, setAuthorFilter] = useState<string>('all')

  // size tracking
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const update = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // visible branches (lane filter)
  const visibleBranches: Branch[] = useMemo(() => {
    if (filter === 'worktrees') {
      const branchWithWt = new Set<string>()
      for (const wt of bundle.worktrees) if (wt.branchId) branchWithWt.add(wt.branchId)
      return bundle.branches.filter((b) => b.isDefault || branchWithWt.has(b.id))
    }
    return bundle.branches
  }, [bundle, filter])

  const laneByBranch = useMemo(() => {
    const m = new Map<string, number>()
    for (const b of visibleBranches) m.set(b.id, b.lane)
    return m
  }, [visibleBranches])

  const visibleBranchIds = useMemo(() => new Set(visibleBranches.map((b) => b.id)), [visibleBranches])

  const allVisibleCommits: Commit[] = useMemo(
    () => bundle.commits.filter((c) => visibleBranchIds.has(c.branchId)),
    [bundle.commits, visibleBranchIds],
  )

  const authorMatch = useCallback(
    (c: Commit) => authorFilter === 'all' || (c.author || '(unknown)') === authorFilter,
    [authorFilter],
  )

  // commit world-x = compact column index * dx
  const xMap = useMemo(() => {
    const uniqX = Array.from(new Set(allVisibleCommits.map((c) => c.x))).sort((a, b) => a - b)
    const m = new Map<number, number>()
    uniqX.forEach((x, i) => m.set(x, i))
    return m
  }, [allVisibleCommits])
  function worldX(c: Commit): number {
    return PADDING_LEFT + (xMap.get(c.x) || 0) * COMMIT_DX
  }
  const contentWorldWidth = PADDING_LEFT + xMap.size * COMMIT_DX + PADDING_RIGHT

  const commitByShort = useMemo(() => {
    const m = new Map<string, Commit>()
    for (const c of bundle.commits) m.set(c.id, c)
    return m
  }, [bundle.commits])

  // sessions attached to a visible commit
  const visibleCommitIds = useMemo(() => new Set(allVisibleCommits.map((c) => c.id)), [allVisibleCommits])
  const sessions: CodexSession[] = useMemo(
    () => bundle.sessions.filter((s) => s.attachCommitId && visibleCommitIds.has(s.attachCommitId)),
    [bundle.sessions, visibleCommitIds],
  )

  const selectedBranchId = useMemo(() => {
    if (!selectedWorktreeId) return null
    const wt = bundle.worktrees.find((w) => w.id === selectedWorktreeId)
    return wt?.branchId || null
  }, [bundle.worktrees, selectedWorktreeId])

  // ----- screen X helper -----
  const toScreenX = useCallback((wx: number) => wx * zoom + pan.x, [zoom, pan.x])

  // ----------------------------------------------------------------------------
  // LAYOUT: per-lane greedy card packing + dynamic lane bands (Y in screen space)
  // ----------------------------------------------------------------------------
  // Card placement is per session: each card's LEFT edge sits at its commit's
  // (zoomed, pan-independent) x. Cards on the same lane that would overlap are
  // pushed up into additional rows (row 0 = nearest the lane line). The number of
  // rows a lane needs depends only on zoom, so vertical layout is stable on pan.
  interface CardSlot {
    session: CodexSession
    lane: number
    worldXLeft: number   // pan-independent: worldX * zoom (left edge)
    row: number          // 0 = nearest lane line, grows away
  }
  const layout = useMemo(() => {
    // group sessions by lane
    const byLane = new Map<number, CodexSession[]>()
    for (const s of sessions) {
      const lane = laneByBranch.get(s.branchId || '') ?? 0
      if (!byLane.has(lane)) byLane.set(lane, [])
      byLane.get(lane)!.push(s)
    }

    const slots = new Map<string, CardSlot>()
    const rowsByLane = new Map<number, number>()
    for (const [lane, list] of byLane) {
      // sort by time (worldX)
      list.sort((a, b) => {
        const ca = a.attachCommitId ? commitByShort.get(a.attachCommitId) : undefined
        const cb = b.attachCommitId ? commitByShort.get(b.attachCommitId) : undefined
        return (ca ? worldX(ca) : 0) - (cb ? worldX(cb) : 0)
      })
      // greedy: place each card in the lowest row where it doesn't overlap the
      // previously-placed card in that row
      const rowRight: number[] = [] // right edge (zoomed px) of last card per row
      let maxRow = 0
      for (const s of list) {
        const c = s.attachCommitId ? commitByShort.get(s.attachCommitId) : undefined
        if (!c) continue
        const left = worldX(c) * zoom
        let row = 0
        while (row < rowRight.length && left < rowRight[row] + CARD_GAP_X) row++
        rowRight[row] = left + CARD_W
        if (row > maxRow) maxRow = row
        slots.set(s.id, { session: s, lane, worldXLeft: left, row })
      }
      rowsByLane.set(lane, list.length ? maxRow + 1 : 0)
    }

    // lay out lanes top→bottom. Each lane band reserves room above its line for
    // its card rows (all cards rendered above the line for a clean read).
    const lanesSorted = [...new Set(visibleBranches.map((b) => b.lane))].sort((a, b) => a - b)
    const laneCenter = new Map<number, number>() // screen-space centerline (pre-pan)
    let cursor = 12
    for (const lane of lanesSorted) {
      const rows = rowsByLane.get(lane) || 0
      const above = rows > 0 ? LANE_LINE_PAD + rows * (CARD_H + CARD_GAP_Y) : LANE_MIN_TOP
      const center = cursor + above
      laneCenter.set(lane, center)
      cursor = center + LANE_BASE_PAD
    }
    const totalHeight = cursor + 12

    return { slots, rowsByLane, laneCenter, totalHeight }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, laneByBranch, visibleBranches, commitByShort, xMap, zoom])

  const laneCenterY = useCallback(
    (lane: number) => (layout.laneCenter.get(lane) ?? 0),
    [layout],
  )
  // screen Y of a lane centerline (with pan)
  const laneScreenY = useCallback((lane: number) => laneCenterY(lane) + pan.y, [laneCenterY, pan.y])
  // screen position of a card slot's top-left
  const cardScreen = useCallback(
    (slot: CardSlot) => {
      const left = slot.worldXLeft + pan.x
      const lineY = laneCenterY(slot.lane) + pan.y
      const top = lineY - LANE_LINE_PAD - (slot.row + 1) * (CARD_H + CARD_GAP_Y) + CARD_GAP_Y
      return { left, top, lineY }
    },
    [laneCenterY, pan.x, pan.y],
  )

  const graphTop = AXIS_HEIGHT
  const graphHeight = Math.max(120, containerSize.h - AXIS_HEIGHT)

  // ----- key commits (dots vs ticks at low zoom) -----
  const effectiveDx = COMMIT_DX * zoom
  const dense = effectiveDx < 12
  const keyCommitIds = useMemo(() => {
    const set = new Set<string>()
    for (const c of allVisibleCommits) if (c.isHead || c.isMerge) set.add(c.id)
    for (const s of bundle.sessions) if (s.attachCommitId) set.add(s.attachCommitId)
    for (const b of visibleBranches) {
      if (b.forkFromCommitId) set.add(b.forkFromCommitId)
      if (b.mergedIntoCommitId) set.add(b.mergedIntoCommitId)
      if (b.headCommitId) set.add(b.headCommitId)
    }
    return set
  }, [allVisibleCommits, bundle.sessions, visibleBranches])

  // ----- branch baseline segments (screen space) -----
  const branchSegments = useMemo(() => {
    type Seg = { branch: Branch; from: number; to: number }
    const segs: Seg[] = []
    for (const b of visibleBranches) {
      const cs = allVisibleCommits.filter((c) => c.branchId === b.id)
      if (cs.length === 0) continue
      const xs = cs.map(worldX).sort((a, b) => a - b)
      segs.push({ branch: b, from: xs[0], to: xs[xs.length - 1] })
    }
    return segs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleBranches, allVisibleCommits, xMap])

  // ----- fork / merge curves -----
  type Curve = { id: string; d: string; merged: boolean; branchId: string }
  const curves: Curve[] = useMemo(() => {
    const list: Curve[] = []
    for (const b of visibleBranches) {
      if (b.isDefault) continue
      const yB = laneScreenY(b.lane)
      const y0 = laneScreenY(0)
      if (b.forkFromCommitId) {
        const c = commitByShort.get(b.forkFromCommitId)
        const first = allVisibleCommits.filter((cm) => cm.branchId === b.id).sort((a, b) => a.x - b.x)[0]
        if (c && first) {
          list.push({
            id: `fork-${b.id}`,
            d: smoothPath(toScreenX(worldX(c)), y0, toScreenX(worldX(first)), yB),
            merged: false,
            branchId: b.id,
          })
        }
      }
      if (b.mergedIntoCommitId) {
        const cm = commitByShort.get(b.mergedIntoCommitId)
        const last = allVisibleCommits.filter((c) => c.branchId === b.id).sort((a, b) => b.x - a.x)[0]
        if (cm && last) {
          list.push({
            id: `merge-${b.id}`,
            d: smoothPath(toScreenX(worldX(last)), yB, toScreenX(worldX(cm)), y0),
            merged: true,
            branchId: b.id,
          })
        }
      }
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleBranches, allVisibleCommits, commitByShort, xMap, zoom, pan, layout])

  // ----- date axis ticks (adaptive day granularity) -----
  const MIN_TICK_PX = 56
  const dateTicks = useMemo(() => {
    const sortedX = Array.from(xMap.keys()).sort((a, b) => a - b)
    const dateByX = new Map<number, string>()
    for (const x of sortedX) {
      const ds = allVisibleCommits.filter((c) => c.x === x).map((c) => c.date).filter(Boolean).sort()
      if (ds.length) dateByX.set(x, ds[Math.floor(ds.length / 2)])
    }
    const dayMap = new Map<string, number>()
    for (const x of sortedX) {
      const d = dateByX.get(x)
      if (!d) continue
      const day = d.slice(0, 10)
      const wx = PADDING_LEFT + (xMap.get(x) || 0) * COMMIT_DX
      if (!dayMap.has(day)) dayMap.set(day, wx)
    }
    const days = [...dayMap.entries()].sort((a, b) => a[1] - b[1])
    const minGap = MIN_TICK_PX / zoom
    const out: { x: number; label: string; full: string }[] = []
    let lastX = -Infinity
    let lastMonth = ''
    for (const [day, wx] of days) {
      if (wx - lastX < minGap) continue
      const dt = new Date(day + 'T00:00:00Z')
      const m = `${dt.getUTCFullYear()}-${dt.getUTCMonth()}`
      const label = m !== lastMonth
        ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : dt.toLocaleDateString('en-US', { day: 'numeric' })
      out.push({ x: wx, label, full: day })
      lastX = wx
      lastMonth = m
    }
    return out
  }, [xMap, allVisibleCommits, zoom])

  // ----- pan / zoom -----
  const fitView = useCallback(() => {
    const w = containerSize.w
    if (!w) return
    const sx = (w - 20) / contentWorldWidth
    const s = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(sx, 1)))
    setZoom(s)
    setPan({ x: 16, y: 12 })
  }, [containerSize, contentWorldWidth])

  const didFit = useRef(false)
  useEffect(() => {
    if (didFit.current) return
    if (containerSize.w < 100 || contentWorldWidth < 100) return
    fitView()
    didFit.current = true
  }, [containerSize, contentWorldWidth, fitView])

  const zoomRef = useRef(zoom)
  const panRef = useRef(pan)
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  useEffect(() => { panRef.current = pan }, [pan])
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const z0 = zoomRef.current
      const p0 = panRef.current
      if (e.ctrlKey || e.metaKey) {
        const dz = -e.deltaY * 0.01
        const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z0 * (1 + dz)))
        const cx = e.clientX - rect.left
        const k = nz / z0
        setPan({ x: cx - (cx - p0.x) * k, y: p0.y })
        setZoom(nz)
      } else {
        setPan({ x: p0.x - e.deltaX, y: p0.y - e.deltaY })
      }
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler as EventListener)
  }, [])

  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null)
  const [isPanning, setIsPanning] = useState(false)
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (t.closest('.canvas__chip-group, .canvas__lane-label-group, .canvas__commit, .pinned-card, .live-panel, button, a, select, input')) return
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y }
    setIsPanning(true)
  }
  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    setPan({ x: dragRef.current.px + (e.clientX - dragRef.current.sx), y: dragRef.current.py + (e.clientY - dragRef.current.sy) })
  }
  const endPan = () => { dragRef.current = null; setIsPanning(false) }
  useEffect(() => {
    if (!isPanning) return
    window.addEventListener('mouseup', endPan)
    return () => window.removeEventListener('mouseup', endPan)
  }, [isPanning])

  // ----- hover / pinned derived -----
  const sessionMap = useMemo(() => {
    const m = new Map<string, CodexSession>()
    for (const s of bundle.sessions) m.set(s.id, s)
    return m
  }, [bundle.sessions])

  const hoveredSession = hoveredSessionId ? sessionMap.get(hoveredSessionId) || null : null
  const hoveredCommit = hoveredCommitId ? commitByShort.get(hoveredCommitId) || null : null

  const pinnedSession = pinnedSessionId ? sessionMap.get(pinnedSessionId) || null : null
  const pinnedCommit = pinnedCommitId ? commitByShort.get(pinnedCommitId) || null : null

  const pinnedAttachId = pinnedSession?.attachCommitId
  const pinnedAttachScreen = useMemo(() => {
    if (!pinnedAttachId) return null
    const c = commitByShort.get(pinnedAttachId)
    if (!c) return null
    const lane = laneByBranch.get(c.branchId)
    if (lane === undefined) return null
    return { x: toScreenX(worldX(c)), y: laneScreenY(lane) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedAttachId, commitByShort, laneByBranch, zoom, pan, layout])

  const relatedSessions = useMemo(() => {
    if (!pinnedSession) return [] as CodexSession[]
    return bundle.sessions
      .filter((s) => s.worktreeId === pinnedSession.worktreeId && s.id !== pinnedSession.id)
      .sort((a, b) => (a.date > b.date ? -1 : 1))
      .slice(0, 8)
  }, [pinnedSession, bundle.sessions])

  const focusWorktree = useMemo(() => {
    if (pinnedSession) return bundle.worktrees.find((w) => w.id === pinnedSession.worktreeId) || null
    if (selectedWorktreeId) return bundle.worktrees.find((w) => w.id === selectedWorktreeId) || null
    return null
  }, [pinnedSession, selectedWorktreeId, bundle.worktrees])

  // live sessions
  const liveSessions = useMemo(() => {
    const order: Record<SessionVisualState, number> = { running: 0, automated: 1, active: 2, inactive: 9 }
    return bundle.sessions
      .map((s) => ({ s, state: sessionStateMap.get(s.id) || 'inactive' }))
      .filter((x) => x.state !== 'inactive')
      .sort((a, b) => {
        const o = order[a.state] - order[b.state]
        if (o !== 0) return o
        return (b.s.endDate || b.s.date) > (a.s.endDate || a.s.date) ? 1 : -1
      })
  }, [bundle.sessions, sessionStateMap])
  const [livePanelOpen, setLivePanelOpen] = useState(true)

  function isBranchActive(id: string) { return selectedBranchId === id }
  function handleBranchLabelClick(b: Branch) {
    const wt = bundle.worktrees.find((w) => w.branchId === b.id)
    if (wt) onSelectWorktree(wt.id)
  }

  // visible-card list for rendering (screen-space)
  const cardList = useMemo(() => [...layout.slots.values()], [layout])

  return (
    <section className="canvas">
      <div className="canvas__head">
        <div className="canvas__title">Git × Worktree Lineage</div>
        <div className="canvas__head-meta">
          {bundle.commits.length} commits · {bundle.branches.length} branches ·{' '}
          {bundle.worktrees.length} worktrees · {bundle.sessions.length} sessions
        </div>

        <label className="canvas__author">
          <span className="canvas__author-icon" aria-hidden>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </span>
          <select value={authorFilter} onChange={(e) => setAuthorFilter(e.target.value)}>
            <option value="all">All authors ({bundle.commits.length})</option>
            {allAuthors.map(([a, n]) => (
              <option key={a} value={a}>{a} ({n})</option>
            ))}
          </select>
        </label>

        <div className="canvas__filter">
          {(['all', 'branches', 'worktrees'] as GraphFilter[]).map((f) => (
            <button
              key={f}
              className={`canvas__filter-btn${filter === f ? ' canvas__filter-btn--active' : ''}`}
              onClick={() => onFilterChange(f)}
            >
              {f === 'all' ? 'All' : f === 'branches' ? 'Branches' : 'Worktrees'}
            </button>
          ))}
        </div>

        <div className="canvas__zoom">
          <button onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.2))} title="Zoom out">−</button>
          <span className="canvas__zoom-label">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.2))} title="Zoom in">+</button>
          <button onClick={fitView} title="Fit to view">Fit</button>
        </div>
      </div>

      <div
        className={`canvas__viewport${isPanning ? ' canvas__viewport--panning' : ''}`}
        ref={viewportRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
      >
        {/* date axis */}
        <div className="canvas__axis" style={{ height: AXIS_HEIGHT }}>
          {dateTicks.map((t, i) => {
            const sx = toScreenX(t.x)
            if (sx < -60 || sx > containerSize.w + 60) return null
            return (
              <div key={`tick-${t.full}-${i}`} className="canvas__axis-tick" style={{ left: sx }}>
                <div className="canvas__axis-tick-line" />
                <div className="canvas__axis-tick-label">{t.label}</div>
              </div>
            )
          })}
        </div>

        {/* main graph svg (everything in screen coords — no group scale, so dots stay round) */}
        <svg className="canvas__svg" width={containerSize.w} height={graphHeight} style={{ top: graphTop, height: graphHeight }}>
          {/* day gridlines (full height, aligned with axis) */}
          {dateTicks.map((t, i) => {
            const sx = toScreenX(t.x)
            if (sx < -2 || sx > containerSize.w + 2) return null
            return <line key={`grid-${t.full}-${i}`} x1={sx} x2={sx} y1={0} y2={graphHeight} className="canvas__gridline" />
          })}

          {/* lane background stripes */}
          {visibleBranches.map((b) => {
            const y = laneScreenY(b.lane)
            const active = isBranchActive(b.id)
            return (
              <rect
                key={`bg-${b.id}`}
                x={0}
                y={y - 11}
                width={containerSize.w}
                height={22}
                className={`canvas__lane-bg${active ? ' canvas__lane-bg--active' : ''}${b.isDefault ? ' canvas__lane-bg--main' : ''}`}
              />
            )
          })}

          {/* fork / merge curves */}
          {curves.map((c) => {
            const active = isBranchActive(c.branchId)
            return (
              <path
                key={c.id}
                d={c.d}
                className={`canvas__curve${c.merged ? ' canvas__curve--merged' : ''}${active ? ' canvas__curve--active' : ''}`}
              />
            )
          })}

          {/* baseline segments */}
          {branchSegments.map((s) => {
            const active = isBranchActive(s.branch.id)
            const y = laneScreenY(s.branch.lane)
            return (
              <line
                key={`seg-${s.branch.id}`}
                x1={toScreenX(s.from)}
                y1={y}
                x2={toScreenX(s.to)}
                y2={y}
                className={`canvas__seg${s.branch.isDefault ? ' canvas__seg--main' : ''}${active ? ' canvas__seg--active' : ''}${s.branch.status === 'dirty' ? ' canvas__seg--dirty' : ''}${s.branch.status === 'unmerged' ? ' canvas__seg--unmerged' : ''}`}
              />
            )
          })}

          {/* commits */}
          {allVisibleCommits.map((c) => {
            const lane = laneByBranch.get(c.branchId)
            if (lane === undefined) return null
            const x = toScreenX(worldX(c))
            if (x < -10 || x > containerSize.w + 10) return null
            const y = laneScreenY(lane)
            const active = isBranchActive(c.branchId)
            const mine = authorMatch(c)
            const isAttach = pinnedAttachId === c.id
            const isKey = keyCommitIds.has(c.id) || !dense || isAttach
            if (!isKey) {
              return <line key={`c-${c.id}`} x1={x} y1={y - 3} x2={x} y2={y + 3} className={`canvas__tick${active ? ' canvas__tick--active' : ''}${!mine ? ' canvas__tick--dim' : ''}`} />
            }
            const isPinned = pinnedCommitId === c.id
            return (
              <g
                key={`c-${c.id}`}
                className={`canvas__commit${!mine ? ' canvas__commit--dim' : ''}`}
                onMouseEnter={() => setHoveredCommitId(c.id)}
                onMouseLeave={() => setHoveredCommitId(null)}
                onClick={(e) => { e.stopPropagation(); onPinCommit(c.id) }}
              >
                <circle
                  cx={x}
                  cy={y}
                  r={c.isMerge ? COMMIT_RADIUS + 1.5 : COMMIT_RADIUS}
                  className={`canvas__dot${active ? ' canvas__dot--active' : ''}${c.isMerge ? ' canvas__dot--merge' : ''}${c.isHead ? ' canvas__dot--head' : ''}${isPinned ? ' canvas__dot--pinned' : ''}`}
                />
                {c.isHead && (
                  <foreignObject x={x - 28} y={y - HEAD_OFFSET - 14} width={56} height={16}>
                    <div className="head-label">HEAD</div>
                  </foreignObject>
                )}
              </g>
            )
          })}

          {/* leader lines: commit → its card (vertical at card left edge) */}
          {cardList.map(({ session, lane, worldXLeft }) => {
            const c = session.attachCommitId ? commitByShort.get(session.attachCommitId) : undefined
            if (!c) return null
            const slot = layout.slots.get(session.id)!
            const sp = cardScreen(slot)
            const dotX = toScreenX(worldX(c))
            const dim = !authorMatch(c)
            void lane; void worldXLeft
            return (
              <path
                key={`lead-${session.id}`}
                d={`M ${dotX},${sp.lineY} L ${dotX},${sp.top + CARD_H} L ${sp.left + 14},${sp.top + CARD_H}`}
                className={`canvas__chip-leader${dim ? ' canvas__chip-leader--dim' : ''}`}
                fill="none"
              />
            )
          })}

          {/* connector: pinned session card → its commit dot */}
          {pinnedSession && pinnedAttachScreen && (() => {
            const cardW = Math.min(800, containerSize.w - 48)
            const targetX = Math.max(0, containerSize.w - 16 - cardW)
            const targetY = 96 - graphTop
            return (
              <g className="canvas__pin-connector-g">
                <path
                  d={`M ${pinnedAttachScreen.x},${pinnedAttachScreen.y} C ${(pinnedAttachScreen.x + targetX) / 2},${pinnedAttachScreen.y} ${(pinnedAttachScreen.x + targetX) / 2},${targetY} ${targetX},${targetY}`}
                  className="canvas__pin-path"
                  fill="none"
                />
                <circle cx={pinnedAttachScreen.x} cy={pinnedAttachScreen.y} r={11} className="canvas__pin-halo" />
                <circle cx={pinnedAttachScreen.x} cy={pinnedAttachScreen.y} r={5} className="canvas__pin-core" />
              </g>
            )
          })()}
        </svg>

        {/* session cards — screen-space, collision-packed, constant size */}
        <div className="canvas__chip-overlay" style={{ top: graphTop, height: graphHeight }}>
          {cardList.map((slot) => {
            const s = slot.session
            const sp = cardScreen(slot)
            if (sp.top < -CARD_H - 4 || sp.top > graphHeight + 4) return null
            if (sp.left < -CARD_W || sp.left > containerSize.w) return null
            const active = pinnedSessionId === s.id || hoveredSessionId === s.id
            const c = s.attachCommitId ? commitByShort.get(s.attachCommitId) : undefined
            const dim = c && !authorMatch(c)
            const state = sessionStateMap.get(s.id) || 'inactive'
            const showAuto = settings.showAutomation && !!s.automation
            const pulse = settings.animateRunning && s.automation?.status === 'ACTIVE'
            return (
              <div
                key={`card-${s.id}`}
                className={`canvas__chip-group${dim ? ' canvas__chip-group--dim' : ''}`}
                style={{ left: sp.left, top: sp.top, width: CARD_W }}
                onClick={(e) => { e.stopPropagation(); onPinSession(s.id) }}
                onMouseEnter={() => setHoveredSessionId(s.id)}
                onMouseLeave={() => setHoveredSessionId(null)}
              >
                <div
                  className={`session-chip session-chip--state-${state}${active ? ' session-chip--active' : ''}${pulse ? ' session-chip--pulse' : ''}`}
                  title={s.titleRenamed ? `(renamed) ${s.title}` : s.title}
                >
                  <div className="session-chip__row1">
                    <span className={`session-chip__state-dot session-chip__state-dot--${state}`} />
                    <span className="session-chip__label">{s.label}</span>
                    {showAuto && <span className="session-chip__auto" title={`Automation: ${s.automation!.name} (${s.automation!.status})`}>⚡</span>}
                    {s.titleRenamed && <span className="session-chip__renamed" title="Renamed in Codex">✎</span>}
                    {s.attachCommitId && <span className="session-chip__hash" title={`commit ${s.attachCommitId}`}>{s.attachCommitId}</span>}
                    <span className="session-chip__day">{monthDay(s.date)} · {s.durationMin}m</span>
                  </div>
                  <div className="session-chip__title">{s.title}</div>
                </div>
              </div>
            )
          })}
        </div>

        {/* branch labels — pinned to the left edge of the viewport, follow lane Y */}
        <div className="canvas__branch-labels" style={{ top: graphTop, height: graphHeight }}>
          {visibleBranches.map((b) => {
            const y = laneScreenY(b.lane)
            if (y < 2 || y > graphHeight - 2) return null
            const active = isBranchActive(b.id)
            const wt = bundle.worktrees.find((w) => w.branchId === b.id)
            return (
              <div
                key={`blabel-${b.id}`}
                className="canvas__lane-label-group"
                style={{ left: 8, top: y - 13 }}
                onClick={(e) => { e.stopPropagation(); handleBranchLabelClick(b) }}
              >
                <div className={`lane-label${active ? ' lane-label--active' : ''}${b.isDefault ? ' lane-label--main' : ''}`}>
                  <span className={`lane-label__dot lane-label__dot--${b.status}`} />
                  <span className="lane-label__name" title={b.name}>{b.name}</span>
                  {b.isDefault && <span className="lane-label__badge lane-label__badge--main">main</span>}
                  {b.mergedIntoBranchId && <span className="lane-label__badge lane-label__badge--merged">merged</span>}
                  {b.status === 'dirty' && !b.isDefault && <span className="lane-label__badge lane-label__badge--dirty">dirty</span>}
                  {b.status === 'unmerged' && <span className="lane-label__badge lane-label__badge--unmerged">unmerged</span>}
                  {wt && wt.sessionCount > 0 && (
                    <span className="lane-label__sessions" title={`${wt.sessionCount} Codex sessions`}>{wt.sessionCount}</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* hover popovers */}
        {hoveredSession && !pinnedSession && (() => {
          const slot = layout.slots.get(hoveredSession.id)
          if (!slot) return null
          const sp = cardScreen(slot)
          const st = sessionStateMap.get(hoveredSession.id) || 'inactive'
          return (
            <div
              className={`session-popover session-popover--state-${st}`}
              style={{
                left: clamp(sp.left, 8, Math.max(8, containerSize.w - 576)),
                top: clamp(sp.top - 250, graphTop + 8, graphHeight - 220),
              }}
            >
              <div className="session-popover__head">
                <span className="session-popover__label">{hoveredSession.label}</span>
                <span className={`pinned-card__state-pill pinned-card__state-pill--${st}`}>
                  <span className={`pinned-card__state-dot pinned-card__state-dot--${st}`} />
                  {st === 'running' ? 'automation running' : st}
                </span>
                <span className="session-popover__model">{hoveredSession.model}</span>
                <span className="session-popover__date">{fmtShort(hoveredSession.date)}</span>
              </div>
              <div className="session-popover__title">
                {hoveredSession.title}
                {hoveredSession.titleRenamed && <span className="session-popover__renamed" title="Renamed in Codex">✎ renamed</span>}
              </div>
              <div className="session-popover__meta">
                <span>{hoveredSession.durationMin} min</span><span>·</span>
                <span>{hoveredSession.messageCount} msgs</span><span>·</span>
                <span>last event {fmtAge(Math.max(0, (now - new Date(hoveredSession.endDate || hoveredSession.date).getTime()) / 3600000))} ago</span>
              </div>
              <div className="session-popover__meta"><span className="session-popover__cwd">{hoveredSession.cwd}</span></div>
              {hoveredSession.automation && settings.showAutomation && (
                <div className={`automation-box automation-box--${hoveredSession.automation.status.toLowerCase()}`}>
                  <div className="automation-box__head">
                    <span className="automation-box__icon">⚡</span>
                    <span className="automation-box__name">{hoveredSession.automation.name}</span>
                    <span className={`automation-box__status automation-box__status--${hoveredSession.automation.status.toLowerCase()}`}>{hoveredSession.automation.status}</span>
                  </div>
                  <div className="automation-box__meta">
                    <span>kind: <b>{hoveredSession.automation.kind}</b></span>
                    {hoveredSession.automation.rrule && <span>schedule: <code>{hoveredSession.automation.rrule}</code></span>}
                  </div>
                </div>
              )}
              {hoveredSession.promptSnippet && <div className="session-popover__snippet">{hoveredSession.promptSnippet}</div>}
              <div className="session-popover__hint">Click to pin →</div>
            </div>
          )
        })()}

        {hoveredCommit && !pinnedCommit && (() => {
          const lane = laneByBranch.get(hoveredCommit.branchId)
          if (lane === undefined) return null
          const sx = toScreenX(worldX(hoveredCommit))
          const sy = laneScreenY(lane)
          return (
            <div className="commit-popover" style={{ left: clamp(sx + 12, 8, containerSize.w - 400), top: clamp(sy - 14, 8, graphHeight - 80) }}>
              <div className="commit-popover__row">
                <span className="commit-popover__hash">{hoveredCommit.id}</span>
                <span className="commit-popover__author">{hoveredCommit.author}</span>
                <span className="commit-popover__date">{fmtDateTime(hoveredCommit.date)}</span>
              </div>
              <div className="commit-popover__msg">{hoveredCommit.message}</div>
              {hoveredCommit.isMerge && <div className="commit-popover__tag">merge commit</div>}
              <div className="commit-popover__hint">Click to pin →</div>
            </div>
          )
        })()}

        {/* pinned cards */}
        {pinnedSession && focusWorktree && (
          <PinnedSessionCard
            session={pinnedSession}
            worktree={focusWorktree}
            related={relatedSessions}
            state={sessionStateMap.get(pinnedSession.id) || 'inactive'}
            attachCommit={pinnedSession.attachCommitId ? commitByShort.get(pinnedSession.attachCommitId) || null : null}
            now={now}
            thresholdHours={settings.activeThresholdHours}
            onClose={() => onPinSession(null)}
            onSelectRelated={(id) => onPinSession(id)}
            onPinCommit={(id) => onPinCommit(id)}
          />
        )}
        {pinnedCommit && !pinnedSession && (
          <PinnedCommitCard
            commit={pinnedCommit}
            sessionsHere={bundle.sessions.filter((s) => s.attachCommitId === pinnedCommit.id)}
            onClose={() => onPinCommit(null)}
            onOpenSession={(id) => onPinSession(id)}
          />
        )}

        {/* live sessions panel */}
        {!pinnedSession && !pinnedCommit && (
          <div className={`live-panel${livePanelOpen ? '' : ' live-panel--collapsed'}`}>
            <button className="live-panel__head" onClick={() => setLivePanelOpen((v) => !v)}>
              <span className="live-panel__title"><span className="live-panel__pulse" />Live sessions</span>
              <span className="live-panel__count">{liveSessions.length}</span>
              <span className="live-panel__chevron">{livePanelOpen ? '▸' : '◂'}</span>
            </button>
            {livePanelOpen && (
              <div className="live-panel__body">
                {liveSessions.length === 0 ? (
                  <div className="live-panel__empty">No active sessions in this repo.</div>
                ) : (
                  liveSessions.map(({ s, state }) => (
                    <button
                      key={s.id}
                      className={`live-row live-row--${state}`}
                      onClick={() => onPinSession(s.id)}
                      onMouseEnter={() => setHoveredSessionId(s.id)}
                      onMouseLeave={() => setHoveredSessionId(null)}
                      title={s.title}
                    >
                      <span className={`live-row__dot live-row__dot--${state}`} />
                      <span className="live-row__main">
                        <span className="live-row__title">{s.title}{s.automation && <span className="live-row__auto">⚡</span>}</span>
                        <span className="live-row__meta">
                          {(bundle.worktrees.find((w) => w.id === s.worktreeId)?.branchName) || s.branchId}
                          {s.attachCommitId && <span className="live-row__hash">@{s.attachCommitId}</span>}
                          {' · '}
                          {state === 'running' ? `running · ${s.automation?.rrule || 'heartbeat'}` : state}
                          {' · '}
                          {fmtAge(Math.max(0, (now - new Date(s.endDate || s.date).getTime()) / 3600000))} ago
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {focusWorktree && !pinnedSession && !pinnedCommit && <FloatingWorktreeBadge wt={focusWorktree} />}

        {/* legend */}
        <div className="canvas__legend">
          <div className="canvas__legend-group">
            <span className="canvas__legend-item"><span className="canvas__legend-swatch canvas__legend-swatch--commit" />commit</span>
            <span className="canvas__legend-item"><span className="canvas__legend-swatch canvas__legend-swatch--merge" />merge</span>
            <span className="canvas__legend-item"><span className="canvas__legend-swatch canvas__legend-swatch--head" />HEAD</span>
          </div>
          <div className="canvas__legend-group">
            <span className="canvas__legend-item"><span className="canvas__legend-state-dot canvas__legend-state-dot--inactive" />inactive</span>
            <span className="canvas__legend-item"><span className="canvas__legend-state-dot canvas__legend-state-dot--active" />active ≤ {settings.activeThresholdHours}h</span>
            <span className="canvas__legend-item"><span className="canvas__legend-state-dot canvas__legend-state-dot--automated" />automated</span>
            <span className="canvas__legend-item"><span className="canvas__legend-state-dot canvas__legend-state-dot--running" />running ⚡</span>
          </div>
          <div className="canvas__legend-hint">drag to pan · Cmd/Ctrl + scroll to zoom time · click card / dot to pin</div>
        </div>
      </div>
    </section>
  )
}

// ----- pinned cards -----

function PinnedSessionCard({
  session, worktree, related, state, attachCommit, now, thresholdHours, onClose, onSelectRelated, onPinCommit,
}: {
  session: CodexSession
  worktree: { id: string; branchName: string; path: string; status: WorktreeStatus; sessionCount: number; head: { commitId: string; author: string; message: string; date: string }; forkedFrom?: string; mergedInto?: string }
  related: CodexSession[]
  state: SessionVisualState
  attachCommit: Commit | null
  now: number
  thresholdHours: number
  onClose: () => void
  onSelectRelated: (id: string) => void
  onPinCommit: (id: string) => void
}) {
  const ageH = Math.max(0, (now - new Date(session.endDate || session.date).getTime()) / 3600 / 1000)
  return (
    <div className={`pinned-card pinned-card--session pinned-card--state-${state}`} onMouseDown={(e) => e.stopPropagation()}>
      <button className="pinned-card__close" onClick={onClose} aria-label="Close">×</button>
      <div className="pinned-card__head">
        <span className="pinned-card__chip">{session.label}</span>
        <span className={`pinned-card__state-pill pinned-card__state-pill--${state}`}>
          <span className={`pinned-card__state-dot pinned-card__state-dot--${state}`} />
          {state === 'running' ? 'automation running' : state}
        </span>
        <span className="pinned-card__model">{session.model}</span>
        {session.originator && <span className="pinned-card__origin">{session.originator}</span>}
        <span className="pinned-card__age">last active {fmtAge(ageH)} ago{state === 'active' && ` · within ${thresholdHours}h`}</span>
      </div>
      <h2 className="pinned-card__title">
        <span>{session.title}</span>
        {session.titleRenamed && (
          <span className="pinned-card__title-renamed" title={session.renameSource === 'app' ? 'Renamed in Codex app' : 'Renamed via CLI'}>
            renamed{session.renameSource ? ` · ${session.renameSource}` : ''}
          </span>
        )}
      </h2>
      <div className="pinned-card__sub">
        <span className="pinned-card__branch">{worktree.branchName}</span><span>·</span>
        <span>started {fmtDateTime(session.date)}</span><span>·</span>
        <span>last event {fmtDateTime(session.endDate)}</span><span>·</span>
        <span>{session.durationMin} min</span><span>·</span>
        <span>{session.messageCount} msgs</span>
      </div>

      <button className="pinned-card__commit" onClick={() => attachCommit && onPinCommit(attachCommit.id)} disabled={!attachCommit} title={attachCommit ? 'Open this commit' : 'No matching commit'}>
        <span className="pinned-card__commit-icon" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3.5" /><path d="M12 2v6.5M12 15.5V22" />
          </svg>
        </span>
        {attachCommit ? (
          <span className="pinned-card__commit-main">
            <span className="pinned-card__commit-row">
              <span className="pinned-card__commit-hash">{attachCommit.id}</span>
              <span className="pinned-card__commit-meta">{attachCommit.author} · {fmtDateTime(attachCommit.date)}</span>
              {attachCommit.isHead && <span className="pinned-card__commit-tag">HEAD</span>}
              {attachCommit.isMerge && <span className="pinned-card__commit-tag pinned-card__commit-tag--merge">merge</span>}
            </span>
            <span className="pinned-card__commit-msg">{attachCommit.message}</span>
          </span>
        ) : (
          <span className="pinned-card__commit-main"><span className="pinned-card__commit-msg">commit not in loaded history</span></span>
        )}
        {attachCommit && <span className="pinned-card__commit-go">→</span>}
      </button>

      {session.automation && (
        <div className={`automation-box automation-box--${session.automation.status.toLowerCase()}`}>
          <div className="automation-box__head">
            <span className="automation-box__icon" aria-hidden>⚡</span>
            <span className="automation-box__name" title={session.automation.id}>{session.automation.name}</span>
            <span className={`automation-box__status automation-box__status--${session.automation.status.toLowerCase()}`}>{session.automation.status}</span>
          </div>
          <div className="automation-box__meta">
            <span>kind: <b>{session.automation.kind}</b></span>
            {session.automation.rrule && <span>schedule: <code>{session.automation.rrule}</code></span>}
            {session.automation.updatedAt && <span>updated {fmtDateTime(new Date(session.automation.updatedAt).toISOString())}</span>}
          </div>
          {session.automation.promptSnippet && <div className="automation-box__snippet">{session.automation.promptSnippet}…</div>}
        </div>
      )}

      <div className="pinned-card__kvs">
        <div><span className="kv-k">session id</span><span className="kv-v kv-v--mono">{session.id}</span></div>
        <div><span className="kv-k">model</span><span className="kv-v kv-v--mono">{session.model}{session.cliVersion ? ` · cli ${session.cliVersion}` : ''}</span></div>
        <div><span className="kv-k">cwd</span><span className="kv-v kv-v--mono">{session.cwd}</span></div>
        <div><span className="kv-k">forked from</span><span className="kv-v kv-v--mono">{worktree.forkedFrom || '—'}</span></div>
        <div><span className="kv-k">merged into</span><span className="kv-v kv-v--mono">{worktree.mergedInto || '—'}</span></div>
        <div><span className="kv-k">worktree HEAD</span><span className="kv-v kv-v--mono">{worktree.head.commitId} — {worktree.head.message.slice(0, 60)}</span></div>
      </div>
      <div className="pinned-card__section-title">Prompt</div>
      <div className="pinned-card__prompt">{session.prompt || '(no user prompt captured)'}</div>
      <div className="pinned-card__section-title">Transcript preview</div>
      <pre className="pinned-card__transcript">{session.transcriptPreview || '(empty)'}</pre>
      {related.length > 0 && (
        <>
          <div className="pinned-card__section-title">Other sessions on this worktree</div>
          <div className="pinned-card__related">
            {related.map((r) => (
              <button key={r.id} className="pinned-card__related-item" onClick={() => onSelectRelated(r.id)} title={r.title}>
                <span className="pinned-card__related-label">{r.label}</span>
                <span className="pinned-card__related-date">{fmtShort(r.date)}</span>
                <span className="pinned-card__related-title">{r.title}</span>
                {r.automation && <span className="pinned-card__related-auto" title={`Automation: ${r.automation.name} (${r.automation.status})`}>⚡</span>}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="pinned-card__footer">Read-only view · click outside or × to close</div>
    </div>
  )
}

function PinnedCommitCard({
  commit, sessionsHere, onClose, onOpenSession,
}: {
  commit: Commit
  sessionsHere: CodexSession[]
  onClose: () => void
  onOpenSession: (id: string) => void
}) {
  return (
    <div className="pinned-card pinned-card--commit" onMouseDown={(e) => e.stopPropagation()}>
      <button className="pinned-card__close" onClick={onClose} aria-label="Close">×</button>
      <div className="pinned-card__head">
        <span className="pinned-card__hash">{commit.id}</span>
        <span className="pinned-card__author">{commit.author}</span>
        <span className="pinned-card__date">{fmtDateTime(commit.date)}</span>
        {commit.isMerge && <span className="pinned-card__merge-tag">merge</span>}
        {commit.isHead && <span className="pinned-card__head-tag">HEAD</span>}
      </div>
      <h2 className="pinned-card__title">{commit.message}</h2>
      <div className="pinned-card__kvs">
        <div><span className="kv-k">full hash</span><span className="kv-v kv-v--mono">{commit.fullId}</span></div>
        <div><span className="kv-k">parents</span><span className="kv-v kv-v--mono">{commit.parents.join(', ') || '—'}</span></div>
        {commit.refNames.length > 0 && (
          <div><span className="kv-k">refs</span><span className="kv-v kv-v--mono">{commit.refNames.join(', ')}</span></div>
        )}
      </div>
      {sessionsHere.length > 0 ? (
        <>
          <div className="pinned-card__section-title">Sessions attached here</div>
          <div className="pinned-card__related">
            {sessionsHere.map((s) => (
              <button key={s.id} className="pinned-card__related-item" onClick={() => onOpenSession(s.id)} title={s.title}>
                <span className="pinned-card__related-label">{s.label}</span>
                <span className="pinned-card__related-date">{fmtShort(s.date)}</span>
                <span className="pinned-card__related-title">{s.title}</span>
                {s.automation && <span className="pinned-card__related-auto" title={`Automation: ${s.automation.name} (${s.automation.status})`}>⚡</span>}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="pinned-card__empty">No Codex sessions attached to this commit.</div>
      )}
      <div className="pinned-card__footer">Read-only view · click outside or × to close</div>
    </div>
  )
}

function FloatingWorktreeBadge({ wt }: { wt: { branchName: string; path: string; status: WorktreeStatus; sessionCount: number } }) {
  return (
    <div className="floating-badge">
      <div className="floating-badge__head">
        <span className={`floating-badge__dot floating-badge__dot--${wt.status}`} />
        <span className="floating-badge__branch" title={wt.branchName}>{wt.branchName}</span>
        <span className={`floating-badge__status floating-badge__status--${wt.status}`}>{wt.status}</span>
      </div>
      <div className="floating-badge__path" title={wt.path}>{wt.path}</div>
      <div className="floating-badge__meta">{wt.sessionCount} {wt.sessionCount === 1 ? 'session' : 'sessions'} on this worktree</div>
    </div>
  )
}

// ----- helpers -----
function smoothPath(x0: number, y0: number, x1: number, y1: number): string {
  const dx = Math.abs(x1 - x0)
  const ctrl = Math.max(20, dx * 0.5)
  return `M ${x0},${y0} C ${x0 + ctrl},${y0} ${x1 - ctrl},${y1} ${x1},${y1}`
}
function monthDay(iso: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
function fmtDateTime(iso: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function fmtShort(iso: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric' })
}
function fmtAge(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours < 24) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
