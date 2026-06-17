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
// Coordinate model: X is zoomable (time). Y is SCREEN-space — branch rails use
// compact fixed spacing, while cards are packed as callouts around real
// card/card and card/rail collisions. Only pan moves Y.
const COMMIT_DX = 26          // world px between adjacent commit columns (before zoom)
const PADDING_LEFT = 130      // world px before first commit (room for fork-in)
const PADDING_RIGHT = 80
const AXIS_HEIGHT = 32
const COMMIT_RADIUS = 4
const HEAD_OFFSET = 16

const CARD_W_DETAIL = 360
const CARD_H_DETAIL = 88
const CARD_GAP_X = 10
const CARD_GAP_Y_DETAIL = 8
const CARD_RAIL_GAP = 12
const CARD_COLLISION_GAP = 8
const RAIL_COLLISION_X_PAD = 8
const RAIL_COLLISION_Y_PAD = 3
const RAIL_TOP_PAD = CARD_H_DETAIL + 34
const BRANCH_RAIL_GAP = 92
const MAX_STACK_DETAIL = 3
const COMMIT_CARD_W = 260
const COMMIT_CARD_H_DETAIL = 60

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
  const CARD_W = CARD_W_DETAIL
  const CARD_H = CARD_H_DETAIL
  const CARD_GAP_Y = CARD_GAP_Y_DETAIL
  const MAX_STACK = MAX_STACK_DETAIL
  const COMMIT_H = COMMIT_CARD_H_DETAIL

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
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const totalPinned = useMemo(() => bundle.sessions.filter((s) => s.pinned).length, [bundle.sessions])
  const displaySessions = useMemo(
    () => (pinnedOnly ? bundle.sessions.filter((s) => s.pinned) : bundle.sessions),
    [bundle.sessions, pinnedOnly],
  )
  const sessionMetaLabel = pinnedOnly
    ? `${displaySessions.length}/${bundle.sessions.length} pinned sessions`
    : `${bundle.sessions.length} sessions`

  // Cmd-click two commits to compare (git diff style). [a, b] in click order.
  const [compareCommits, setCompareCommits] = useState<[string, string] | null>(null)
  const [compareAnchor, setCompareAnchor] = useState<string | null>(null)
  interface DiffResult { files: { path: string; added: number; removed: number; status: string }[]; summary: string }
  const [compareDiff, setCompareDiff] = useState<DiffResult | null>(null)
  useEffect(() => {
    if (!compareCommits) { setCompareDiff(null); return }
    let cancelled = false
    setCompareDiff(null)
    fetch(`/api/diff?repo=${encodeURIComponent(bundle.repo.id)}&a=${compareCommits[0]}&b=${compareCommits[1]}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setCompareDiff(d) })
      .catch(() => { if (!cancelled) setCompareDiff({ files: [], summary: 'diff failed' }) })
    return () => { cancelled = true }
  }, [compareCommits, bundle.repo.id])
  function onCommitClick(c: Commit, e: React.MouseEvent) {
    if (e.metaKey || e.ctrlKey) {
      // start or finish a compare
      if (!compareAnchor) {
        setCompareAnchor(c.id)
        setCompareCommits(null)
      } else if (compareAnchor !== c.id) {
        setCompareCommits([compareAnchor, c.id])
        setCompareAnchor(null)
      }
      return
    }
    // plain click → pin + clear compare
    setCompareCommits(null)
    setCompareAnchor(null)
    onPinCommit(c.id)
  }

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
    const branchesWithSessions = new Set<string>()
    for (const s of displaySessions) if (s.branchId) branchesWithSessions.add(s.branchId)
    const branchWithWt = new Set<string>()
    for (const wt of bundle.worktrees) if (wt.branchId) branchWithWt.add(wt.branchId)
    if (filter === 'branches') return bundle.branches
    if (filter === 'worktrees') {
      return bundle.branches.filter((b) => b.isDefault || branchWithWt.has(b.id))
    }
    return bundle.branches.filter((b) => b.isDefault || branchesWithSessions.has(b.id) || branchWithWt.has(b.id))
  }, [bundle.branches, bundle.worktrees, displaySessions, filter])

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

  const commitByShort = useMemo(() => {
    const m = new Map<string, Commit>()
    for (const c of bundle.commits) m.set(c.id, c)
    return m
  }, [bundle.commits])

  // sessions attached to a visible commit
  const visibleCommitIds = useMemo(() => new Set(allVisibleCommits.map((c) => c.id)), [allVisibleCommits])
  const sessions: CodexSession[] = useMemo(
    () => displaySessions.filter((s) =>
      s.attachCommitId
      && visibleCommitIds.has(s.attachCommitId)
    ),
    [displaySessions, visibleCommitIds],
  )

  // ----- variable-width commit columns (world space, pre-zoom) -----
  // Columns are NOT equal-width. Walking left→right in time order, whenever a
  // lane carries a session card at a column we reserve ~one card-width of world
  // space before that lane's NEXT card, so consecutive cards on the same lane
  // can stay in their preferred callout positions instead of stacking away from
  // the rail. Commits with no cards keep the compact base spacing. The time axis
  // becomes non-uniform — that's intentional (cards readability > strict time-linearity).
  const { colX, contentWorldWidth } = useMemo(() => {
    const cols = Array.from(new Set(allVisibleCommits.map((c) => c.x))).sort((a, b) => a - b)
    // lane -> set of commit x-cols that bear either a session card OR a commit card
    const laneCardCols = new Map<number, Set<number>>()
    function mark(c: Commit) {
      const lane = laneByBranch.get(c.branchId) ?? 0
      if (!laneCardCols.has(lane)) laneCardCols.set(lane, new Set())
      laneCardCols.get(lane)!.add(c.x)
    }
    for (const s of sessions) {
      const c = s.attachCommitId ? commitByShort.get(s.attachCommitId) : undefined
      if (c) mark(c)
    }
    // also reserve world space for "key" commits that will render commit cards
    const sessionCommitIds = new Set<string>()
    for (const s of displaySessions) if (s.attachCommitId) sessionCommitIds.add(s.attachCommitId)
    for (const c of allVisibleCommits) {
      const isKey = c.isHead || c.isMerge || sessionCommitIds.has(c.id)
        || visibleBranches.some((b) => b.forkFromCommitId === c.id || b.mergedIntoCommitId === c.id || b.headCommitId === c.id)
      if (isKey) mark(c)
    }
    // Constant world-unit reservation (doesn't depend on zoom — keeps fit stable).
    // At zoom=1 each card's column gets ~CARD_W+gap of world width; at low zoom
    // chips will still be readable because they're rendered in screen space (constant
    // size), and two stacks on adjacent commit columns get pushed apart enough that
    // their left edges differ by `RESERVE * zoom` — for zoom=0.5 that's CARD_W/2 +
    // gap/2 of screen px, narrow but okay since most use cases are zoom ≥ 0.6.
    const RESERVE = CARD_W + CARD_GAP_X
    const m = new Map<number, number>()
    const laneNextMin = new Map<number, number>()
    let pos = PADDING_LEFT
    for (const col of cols) {
      for (const [lane, set] of laneCardCols) {
        if (set.has(col)) {
          const mn = laneNextMin.get(lane)
          if (mn !== undefined && mn > pos) pos = mn
        }
      }
      m.set(col, pos)
      for (const [lane, set] of laneCardCols) {
        if (set.has(col)) laneNextMin.set(lane, pos + RESERVE)
      }
      pos += COMMIT_DX
    }
    return { colX: m, contentWorldWidth: pos + PADDING_RIGHT }
  }, [allVisibleCommits, sessions, laneByBranch, commitByShort, displaySessions, visibleBranches, CARD_W])

  const worldX = useCallback(
    (c: Commit): number => colX.get(c.x) ?? PADDING_LEFT,
    [colX],
  )

  const selectedBranchId = useMemo(() => {
    if (!selectedWorktreeId) return null
    const wt = bundle.worktrees.find((w) => w.id === selectedWorktreeId)
    return wt?.branchId || null
  }, [bundle.worktrees, selectedWorktreeId])

  // For every commit that is the HEAD of one or more worktrees/branches,
  // figure out the most useful label (= worktree branch name, fall back to
  // any branch with that commit as head). One short label per HEAD commit.
  const headLabelByCommit = useMemo(() => {
    const m = new Map<string, string>()
    for (const wt of bundle.worktrees) {
      const cid = wt.head?.commitId
      if (!cid) continue
      const cur = m.get(cid)
      const name = wt.branchName || ''
      if (!cur) m.set(cid, name)
      else if (!cur.includes(name) && cur.split(',').length < 2) m.set(cid, `${cur}, ${name}`)
    }
    for (const b of bundle.branches) {
      const cid = b.headCommitId
      if (!cid || m.has(cid)) continue
      m.set(cid, b.name)
    }
    return m
  }, [bundle.worktrees, bundle.branches])

  // ----- screen X helper -----
  const toScreenX = useCallback((wx: number) => wx * zoom + pan.x, [zoom, pan.x])

  // ----------------------------------------------------------------------------
  // LAYOUT: compact branch rails + global callout packing (Y in screen space)
  // ----------------------------------------------------------------------------
  // Branch rails stay in fixed compact lanes. Session and commit cards are then
  // placed as callouts near their commit x, moving only when their real rectangle
  // collides with another card or a visible branch rail segment.
  interface CardSlot {
    session: CodexSession
    lane: number
    worldXLeft: number   // pan-independent: worldX * zoom (left edge)
    top: number          // pan-independent screen Y, before vertical pan
  }
  const layout = useMemo(() => {
    const lanesSorted = [...new Set(visibleBranches.map((b) => b.lane))].sort((a, b) => a - b)
    const laneCenter = new Map<number, number>()
    lanesSorted.forEach((lane, i) => {
      laneCenter.set(lane, RAIL_TOP_PAD + i * BRANCH_RAIL_GAP)
    })

    interface Box { left: number; right: number; top: number; bottom: number }
    const occupied: Box[] = []
    function boxCollides(box: Box): boolean {
      return occupied.some((o) =>
        box.left < o.right + CARD_COLLISION_GAP &&
        box.right > o.left - CARD_COLLISION_GAP &&
        box.top < o.bottom + CARD_COLLISION_GAP &&
        box.bottom > o.top - CARD_COLLISION_GAP
      )
    }
    function boxesFit(boxes: Box[]): boolean {
      return boxes.every((box) => !boxCollides(box))
    }
    function occupy(boxes: Box[]) {
      occupied.push(...boxes)
    }

    for (const b of visibleBranches) {
      const laneY = laneCenter.get(b.lane)
      if (laneY === undefined) continue
      const xs = allVisibleCommits
        .filter((c) => c.branchId === b.id)
        .map((c) => worldX(c) * zoom)
      if (xs.length === 0) continue
      occupied.push({
        left: Math.min(...xs) - RAIL_COLLISION_X_PAD,
        right: Math.max(...xs) + RAIL_COLLISION_X_PAD,
        top: laneY - RAIL_COLLISION_Y_PAD,
        bottom: laneY + RAIL_COLLISION_Y_PAD,
      })
    }

    // group sessions by lane
    const byLane = new Map<number, CodexSession[]>()
    for (const s of sessions) {
      const lane = laneByBranch.get(s.branchId || '') ?? 0
      if (!byLane.has(lane)) byLane.set(lane, [])
      byLane.get(lane)!.push(s)
    }

    const slots = new Map<string, CardSlot>()
    interface OverflowSlot {
      key: string
      lane: number
      worldXLeft: number
      top: number
      count: number
      sessions: CodexSession[]
    }
    const overflows: OverflowSlot[] = []

    interface SessionGroup {
      lane: number
      cid: string
      list: CodexSession[]
      left: number
      anchor: number
      laneY: number
    }
    const sessionGroups: SessionGroup[] = []
    for (const [lane, list] of byLane) {
      const byCommit = new Map<string, CodexSession[]>()
      for (const s of list) {
        const k = s.attachCommitId || ''
        if (!byCommit.has(k)) byCommit.set(k, [])
        byCommit.get(k)!.push(s)
      }
      for (const [cid, list] of byCommit) {
        const c = commitByShort.get(cid)
        const laneY = laneCenter.get(lane)
        if (!c || laneY === undefined) continue
        const anchor = worldX(c) * zoom
        sessionGroups.push({
          lane,
          cid,
          list,
          left: anchor - CARD_W / 2,
          anchor,
          laneY,
        })
      }
    }
    sessionGroups.sort((a, b) => (a.anchor - b.anchor) || (a.laneY - b.laneY))

    const PILL_W = 110
    const PILL_H = 22
    const SEARCH_ROWS = 18
    function stackTops(laneY: number, itemCount: number, side: 'above' | 'below', offsetRows: number): number[] {
      const step = CARD_H + CARD_GAP_Y
      return Array.from({ length: itemCount }, (_, i) => {
        if (side === 'above') return laneY - CARD_RAIL_GAP - CARD_H - (i + offsetRows) * step
        return laneY + CARD_RAIL_GAP + (i + offsetRows) * step
      })
    }
    function stackBoxes(left: number, tops: number[], overflowIndex: number): Box[] {
      return tops.map((top, i) => {
        if (i === overflowIndex) {
          const pillLeft = left + (CARD_W - PILL_W) / 2
          return { left: pillLeft, right: pillLeft + PILL_W, top: top + CARD_H - PILL_H, bottom: top + CARD_H }
        }
        return { left, right: left + CARD_W, top, bottom: top + CARD_H }
      })
    }
    for (const g of sessionGroups) {
      g.list.sort((a, b) => (a.date < b.date ? -1 : 1))
      const visible = g.list.length <= MAX_STACK ? g.list : g.list.slice(0, MAX_STACK - 1)
      const hiddenCount = g.list.length - visible.length
      const overflowIndex = hiddenCount > 0 ? visible.length : -1
      const itemCount = visible.length + (hiddenCount > 0 ? 1 : 0)
      let chosen: { side: 'above' | 'below'; tops: number[]; boxes: Box[] } | null = null

      for (let offset = 0; offset < SEARCH_ROWS && !chosen; offset++) {
        for (const side of ['above', 'below'] as const) {
          const tops = stackTops(g.laneY, itemCount, side, offset)
          const boxes = stackBoxes(g.left, tops, overflowIndex)
          if (boxesFit(boxes)) {
            chosen = { side, tops, boxes }
            break
          }
        }
      }
      if (!chosen) {
        const tops = stackTops(g.laneY, itemCount, 'above', SEARCH_ROWS)
        chosen = { side: 'above', tops, boxes: stackBoxes(g.left, tops, overflowIndex) }
      }

      visible.forEach((s, i) => {
        slots.set(s.id, { session: s, lane: g.lane, worldXLeft: g.left, top: chosen!.tops[i] })
      })
      if (hiddenCount > 0) {
        overflows.push({
          key: `${g.lane}-${g.cid}`,
          lane: g.lane,
          worldXLeft: g.left,
          top: chosen.tops[overflowIndex] + CARD_H - PILL_H,
          count: hiddenCount,
          sessions: g.list.slice(MAX_STACK - 1),
        })
      }
      occupy(chosen.boxes)
    }

    // Commit cards are secondary callouts. They prefer to sit below their branch
    // rail, but share the same global collision map as session cards.
    interface CommitSlot { commit: Commit; lane: number; left: number; top: number }
    const commitSlots: CommitSlot[] = []
    const sessionCommitIds = new Set<string>()
    for (const s of displaySessions) if (s.attachCommitId) sessionCommitIds.add(s.attachCommitId)
    const keyCommits: { commit: Commit; lane: number; left: number; laneY: number }[] = []
    for (const c of allVisibleCommits) {
      const isKey = c.isHead || c.isMerge || sessionCommitIds.has(c.id)
        || visibleBranches.some((b) => b.forkFromCommitId === c.id || b.mergedIntoCommitId === c.id || b.headCommitId === c.id)
      if (!isKey) continue
      const lane = laneByBranch.get(c.branchId) ?? 0
      const laneY = laneCenter.get(lane)
      if (laneY === undefined) continue
      keyCommits.push({
        commit: c,
        lane,
        left: worldX(c) * zoom - COMMIT_CARD_W / 2,
        laneY,
      })
    }
    keyCommits.sort((a, b) => (a.left - b.left) || (a.laneY - b.laneY))
    for (const item of keyCommits) {
      let chosenTop: number | null = null
      for (let offset = 0; offset < SEARCH_ROWS && chosenTop === null; offset++) {
        for (const side of ['below', 'above'] as const) {
          const top = side === 'below'
            ? item.laneY + CARD_RAIL_GAP + offset * (COMMIT_H + CARD_GAP_Y)
            : item.laneY - CARD_RAIL_GAP - COMMIT_H - offset * (COMMIT_H + CARD_GAP_Y)
          const box = { left: item.left, right: item.left + COMMIT_CARD_W, top, bottom: top + COMMIT_H }
          if (!boxCollides(box)) {
            chosenTop = top
            occupy([box])
            break
          }
        }
      }
      if (chosenTop === null) {
        chosenTop = item.laneY + CARD_RAIL_GAP + SEARCH_ROWS * (COMMIT_H + CARD_GAP_Y)
        occupy([{ left: item.left, right: item.left + COMMIT_CARD_W, top: chosenTop, bottom: chosenTop + COMMIT_H }])
      }
      commitSlots.push({ commit: item.commit, lane: item.lane, left: item.left, top: chosenTop })
    }

    return { slots, laneCenter, overflows, commitSlots }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, displaySessions, laneByBranch, visibleBranches, commitByShort, colX, zoom,  allVisibleCommits])

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
      const top = slot.top + pan.y
      return { left, top, lineY }
    },
    [laneCenterY, pan.x, pan.y],
  )

  const graphTop = AXIS_HEIGHT
  const graphHeight = Math.max(120, containerSize.h - AXIS_HEIGHT)

  // commits that have a visible callout card get a distinct dot color so users
  // immediately see "this dot has cards"
  const commitsWithSessionCard = useMemo(() => {
    const set = new Set<string>()
    for (const s of layout.slots.values()) if (s.session.attachCommitId) set.add(s.session.attachCommitId)
    for (const o of layout.overflows) for (const s of o.sessions) if (s.attachCommitId) set.add(s.attachCommitId)
    return set
  }, [layout])
  const commitsWithCommitCard = useMemo(() => {
    const set = new Set<string>()
    for (const cs of layout.commitSlots) set.add(cs.commit.id)
    return set
  }, [layout])

  // ----- key commits (dots vs ticks at low zoom) -----
  const effectiveDx = COMMIT_DX * zoom
  const dense = effectiveDx < 12
  const keyCommitIds = useMemo(() => {
    const set = new Set<string>()
    for (const c of allVisibleCommits) if (c.isHead || c.isMerge) set.add(c.id)
    for (const s of displaySessions) if (s.attachCommitId) set.add(s.attachCommitId)
    for (const b of visibleBranches) {
      if (b.forkFromCommitId) set.add(b.forkFromCommitId)
      if (b.mergedIntoCommitId) set.add(b.mergedIntoCommitId)
      if (b.headCommitId) set.add(b.headCommitId)
    }
    return set
  }, [allVisibleCommits, displaySessions, visibleBranches])

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
  }, [visibleBranches, allVisibleCommits, colX])

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
  }, [visibleBranches, allVisibleCommits, commitByShort, colX, zoom, pan, layout])

  // ----- date axis ticks (adaptive day granularity) -----
  const MIN_TICK_PX = 56
  const dateTicks = useMemo(() => {
    const sortedX = Array.from(colX.keys()).sort((a, b) => a - b)
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
      const wx = colX.get(x) ?? PADDING_LEFT
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
  }, [colX, allVisibleCommits, zoom])

  // ----- pan / zoom -----
  // No more shrink-to-fit: keep zoom at 1 so each commit's card gets its full
  // CARD_W of screen space (commit columns are world-reserved to CARD_W+GAP).
  // User pans horizontally to traverse the timeline. The Fit button just resets
  // to 100% and parks at the start (or the focused/live session if any).
  const fitView = useCallback(() => {
    setZoom(1)
    setPan({ x: 16, y: 12 })
  }, [])

  const didFit = useRef(false)
  useEffect(() => {
    if (didFit.current) return
    if (containerSize.w < 100 || contentWorldWidth < 100) return
    fitView()
    didFit.current = true
  }, [containerSize, contentWorldWidth, fitView])

  const didFocusLive = useRef(false)

  const zoomRef = useRef(zoom)
  const panRef = useRef(pan)
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  useEffect(() => { panRef.current = pan }, [pan])
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      // let scrollable overlays (pinned card, live panel, popover, settings) keep
      // their own internal scroll — don't hijack the wheel to pan the canvas
      const t = e.target as HTMLElement | null
      if (t && t.closest('.pinned-card, .live-panel, .session-popover, .commit-popover, .settings-popover')) {
        return
      }
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
  const didDragRef = useRef(false)
  const [isPanning, setIsPanning] = useState(false)
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (t.closest('.canvas__chip-group, .canvas__lane-label-group, .canvas__commit, .pinned-card, .live-panel, button, a, select, input')) return
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y }
    didDragRef.current = false
    setIsPanning(true)
  }
  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.sx
    const dy = e.clientY - dragRef.current.sy
    if (Math.abs(dx) + Math.abs(dy) > 4) didDragRef.current = true
    setPan({ x: dragRef.current.px + dx, y: dragRef.current.py + dy })
  }
  const endPan = () => { dragRef.current = null; setIsPanning(false) }
  // unified clear-compare helper — called whenever the user moves on to a
  // different selection (empty click, session click, single-commit click)
  const clearCompare = useCallback(() => {
    setCompareCommits(null)
    setCompareAnchor(null)
  }, [])
  // click on empty canvas (not a drag) closes any pinned card / popover + compare
  const onViewportClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (didDragRef.current) return
    const t = e.target as HTMLElement
    if (t.closest('.canvas__chip-group, .canvas__commit, .canvas__lane-label-group, .pinned-card, .live-panel, .session-popover, .commit-popover, .settings-popover, .diff-panel, .diff-hint, button, a, select, input')) return
    if (pinnedSessionId) onPinSession(null)
    if (pinnedCommitId) onPinCommit(null)
    clearCompare()
  }
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

  useEffect(() => {
    if (pinnedOnly && pinnedSession && !pinnedSession.pinned) onPinSession(null)
  }, [pinnedOnly, pinnedSession, onPinSession])

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
    return displaySessions
      .filter((s) => s.worktreeId === pinnedSession.worktreeId && s.id !== pinnedSession.id)
      .sort((a, b) => (a.date > b.date ? -1 : 1))
      .slice(0, 8)
  }, [pinnedSession, displaySessions])

  const focusWorktree = useMemo(() => {
    if (pinnedSession) return bundle.worktrees.find((w) => w.id === pinnedSession.worktreeId) || null
    if (selectedWorktreeId) return bundle.worktrees.find((w) => w.id === selectedWorktreeId) || null
    return null
  }, [pinnedSession, selectedWorktreeId, bundle.worktrees])

  // live sessions
  // "Live" panel = everything the user might want pinned at the side: running >
  // automated > active > pinned-but-inactive. Pinned sessions always show up
  // (Codex's own pin list) even if they're stale.
  const liveSessions = useMemo(() => {
    const order: Record<string, number> = { running: 0, automated: 1, active: 2, pinned: 3 }
    return displaySessions
      .map((s) => {
        const st = sessionStateMap.get(s.id) || 'inactive'
        return { s, state: st }
      })
      .filter((x) => pinnedOnly || x.state !== 'inactive' || x.s.pinned)
      .sort((a, b) => {
        const ka = a.state === 'inactive' ? 'pinned' : a.state
        const kb = b.state === 'inactive' ? 'pinned' : b.state
        const o = (order[ka] ?? 9) - (order[kb] ?? 9)
        if (o !== 0) return o
        return (b.s.endDate || b.s.date) > (a.s.endDate || a.s.date) ? 1 : -1
      })
  }, [displaySessions, pinnedOnly, sessionStateMap])
  const [livePanelOpen, setLivePanelOpen] = useState(true)

  const visibleSessionCountByWorktree = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of displaySessions) {
      m.set(s.worktreeId, (m.get(s.worktreeId) || 0) + 1)
    }
    return m
  }, [displaySessions])

  // focused session (from Live panel / Now pill) — pan to its CARD's actual
  // placed position (layout.slots accounts for the horizontal push-apart that
  // moves cards away from their commit anchor), then keep the highlight ring
  // persistent until the user clicks something else.
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null)
  const focusSession = useCallback((id: string) => {
    setFocusedSessionId(id)
    const s = bundle.sessions.find((x) => x.id === id)
    const wt = s ? bundle.worktrees.find((w) => w.id === s.worktreeId) : undefined
    if (wt) onSelectWorktree(wt.id)

    const slot = layout.slots.get(id)
    if (slot) {
      // Normal path: session has a visible card on the canvas → pan to center it.
      const cardCenterX = slot.worldXLeft + CARD_W / 2
      const cardCenterY = slot.top + CARD_H / 2
      const newX = containerSize.w / 2 - cardCenterX
      const newY = graphHeight / 2 - cardCenterY
      const dx = Math.abs(newX - panRef.current.x)
      const dy = Math.abs(newY - panRef.current.y)
      if (dx < 2 && dy < 2) {
        setPan({ x: newX + 12, y: newY })
        setTimeout(() => setPan({ x: newX, y: newY }), 140)
      } else {
        setPan({ x: newX, y: newY })
      }
      return
    }
    // Fallback A: try to pan to the session's attach commit dot (slot missing
    // means the layout dropped it, but the commit may still be visible).
    if (s?.attachCommitId) {
      const c = commitByShort.get(s.attachCommitId)
      const lane = c ? laneByBranch.get(c.branchId) : undefined
      if (c && lane !== undefined) {
        const dotX = worldX(c) * zoom
        const lineY = layout.laneCenter.get(lane) ?? 0
        setPan({ x: containerSize.w / 2 - dotX, y: Math.max(12, graphHeight / 2 - lineY) })
        return
      }
    }
    // Fallback B: nothing visible to pan to — open the detail card so the user
    // sees the session info instead of a click that appears to do nothing.
    onPinSession(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, containerSize.w, graphHeight, bundle.sessions, bundle.worktrees, onSelectWorktree, onPinSession, commitByShort, laneByBranch, worldX, zoom, CARD_W])

  // After first fit + layout settles, auto-focus the most-recent live session:
  //   • highlight the chip (pulsing ring)
  //   • pan to center it so the user has a clear entry point
  // Uses layout.slots (which already has worldX*zoom baked in) to avoid the
  // earlier bug where focus computed pan with stale zoom and pushed cards off-screen.
  useEffect(() => {
    if (didFocusLive.current) return
    if (!didFit.current) return
    if (liveSessions.length === 0) { didFocusLive.current = true; return }
    const id = liveSessions[0].s.id
    const slot = layout.slots.get(id)
    if (!slot) return  // wait until layout has placed it
    didFocusLive.current = true
    setFocusedSessionId(id)
    const cardCenterX = slot.worldXLeft + CARD_W / 2
    const cardCenterY = slot.top + CARD_H / 2
    setPan({
      x: containerSize.w / 2 - cardCenterX,
      y: graphHeight / 2 - cardCenterY,
    })
    setTimeout(() => setFocusedSessionId((cur) => (cur === id ? null : cur)), 3500)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, liveSessions, containerSize.w, graphHeight])

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
          {bundle.worktrees.length} worktrees · {sessionMetaLabel}
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

        <button
          className={`canvas__pin-filter${pinnedOnly ? ' canvas__pin-filter--active' : ''}`}
          onClick={() => setPinnedOnly((v) => !v)}
          title={`Show only sessions pinned in Codex (${totalPinned} pinned in this repo)`}
        >
          <span className="canvas__pin-filter-icon">📌</span>
          {pinnedOnly ? 'Pinned only' : 'All sessions'}
          <span className="canvas__pin-filter-count">{totalPinned}</span>
        </button>

        {liveSessions.length > 0 && (
          <button
            className="canvas__now"
            onClick={() => { clearCompare(); focusSession(liveSessions[0].s.id) }}
            title={pinnedOnly ? 'Jump to most recent pinned session' : 'Jump to most recent live session'}
          >
            <span className="canvas__now-pulse" />
            {pinnedOnly ? 'Pinned' : 'Now'}: <b>{liveSessions[0].s.title.slice(0, 24)}</b>
            <span style={{ color: '#10b981', fontSize: '11px' }}>· {liveSessions[0].state}</span>
          </button>
        )}

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
        onClick={onViewportClick}
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
            const hasSessionCard = commitsWithSessionCard.has(c.id)
            const hasCommitCard = commitsWithCommitCard.has(c.id)
            const dotR = hasSessionCard ? COMMIT_RADIUS + 2.5 : (hasCommitCard ? COMMIT_RADIUS + 1.5 : (c.isMerge ? COMMIT_RADIUS + 1.5 : COMMIT_RADIUS))
            return (
              <g
                key={`c-${c.id}`}
                className={`canvas__commit${!mine ? ' canvas__commit--dim' : ''}`}
                onMouseEnter={() => setHoveredCommitId(c.id)}
                onMouseLeave={() => setHoveredCommitId(null)}
                onClick={(e) => { e.stopPropagation(); onCommitClick(c, e) }}
              >
                <circle
                  cx={x}
                  cy={y}
                  r={dotR}
                  className={`canvas__dot${active ? ' canvas__dot--active' : ''}${c.isMerge ? ' canvas__dot--merge' : ''}${c.isHead ? ' canvas__dot--head' : ''}${isPinned ? ' canvas__dot--pinned' : ''}${hasSessionCard ? ' canvas__dot--has-session-card' : (hasCommitCard ? ' canvas__dot--has-card' : '')}`}
                />
                {c.isHead && headLabelByCommit.get(c.id) && (
                  <foreignObject x={x - 70} y={y - HEAD_OFFSET - 14} width={140} height={16}>
                    <div className="head-label" title={`HEAD of ${headLabelByCommit.get(c.id)}`}>
                      {headLabelByCommit.get(c.id)}
                    </div>
                  </foreignObject>
                )}
              </g>
            )
          })}

          {/* leader lines: commit dot → session card */}
          {cardList.map(({ session, lane, worldXLeft }) => {
            const c = session.attachCommitId ? commitByShort.get(session.attachCommitId) : undefined
            if (!c) return null
            const slot = layout.slots.get(session.id)!
            const sp = cardScreen(slot)
            const dotX = toScreenX(worldX(c))
            const dim = !authorMatch(c)
            const edgeY = sp.top > sp.lineY ? sp.top : sp.top + CARD_H
            void lane; void worldXLeft
            return (
              <path
                key={`lead-${session.id}`}
                d={`M ${dotX},${sp.lineY} L ${dotX},${edgeY} L ${sp.left + 14},${edgeY}`}
                className={`canvas__chip-leader${dim ? ' canvas__chip-leader--dim' : ''}`}
                fill="none"
              />
            )
          })}

          {/* leader lines: commit dot → commit card */}
          {layout.commitSlots.map((cs) => {
            const c = cs.commit
            const dotX = toScreenX(worldX(c))
            const dotY = laneCenterY(cs.lane) + pan.y
            const cardTop = cs.top + pan.y
            const cardCenterX = cs.left + pan.x + COMMIT_CARD_W / 2
            const edgeY = cardTop > dotY ? cardTop - 2 : cardTop + COMMIT_H + 2
            const dim = !authorMatch(c)
            return (
              <path
                key={`clead-${c.id}`}
                d={`M ${dotX},${dotY} L ${dotX},${edgeY} L ${cardCenterX},${edgeY}`}
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
            const focused = focusedSessionId === s.id
            const c = s.attachCommitId ? commitByShort.get(s.attachCommitId) : undefined
            const dim = c && !authorMatch(c)
            const state = sessionStateMap.get(s.id) || 'inactive'
            const showAuto = settings.showAutomation && !!s.automation
            const pulse = settings.animateRunning && s.automation?.status === 'ACTIVE'
            return (
              <div
                key={`card-${s.id}`}
                className={`canvas__chip-group${dim ? ' canvas__chip-group--dim' : ''}${''}`}
                style={{ left: sp.left, top: sp.top, width: CARD_W, height: CARD_H }}
                onClick={(e) => { e.stopPropagation(); clearCompare(); onPinSession(s.id) }}
                onMouseEnter={() => setHoveredSessionId(s.id)}
                onMouseLeave={() => setHoveredSessionId(null)}
              >
                <div
                  className={`session-chip session-chip--state-${state}${active ? ' session-chip--active' : ''}${pulse ? ' session-chip--pulse' : ''}${focused ? ' session-chip--focused' : ''}`}
                  title={s.titleRenamed ? `(renamed) ${s.title}` : s.title}
                >
                  <div className="session-chip__row1">
                    <span className={`session-chip__state-dot session-chip__state-dot--${state}`} />
                    <span className="session-chip__label">{s.label}</span>
                    {(() => {
                      const branchName = bundle.worktrees.find((w) => w.id === s.worktreeId)?.branchName
                        || bundle.branches.find((b) => b.id === s.branchId)?.name
                      return branchName ? (
                        <span className="session-chip__branch" title={`branch: ${branchName}`}>{branchName}</span>
                      ) : null
                    })()}
                    {s.pinned && <span className="session-chip__pin" title="Pinned in Codex">📌</span>}
                    {showAuto && <span className="session-chip__auto" title={`Automation: ${s.automation!.name} (${s.automation!.status})`}>⚡</span>}
                    {s.titleRenamed && <span className="session-chip__renamed" title="Renamed in Codex">✎</span>}
                    {s.attachCommitId && <span className="session-chip__hash" title={`commit ${s.attachCommitId}`}>{s.attachCommitId}</span>}
                    <span className="session-chip__day">{monthDay(s.date)} · {s.durationMin}m</span>
                  </div>
                  <div className="session-chip__title">{s.title}</div>
                  {/* When the title is a user rename, show what the session was actually about
                      (the original first-prompt snippet) so the card explains what was done. */}
                  {s.titleRenamed && s.promptSnippet && s.promptSnippet !== s.title && (
                    <div className="session-chip__what" title={s.promptSnippet}>
                      <span className="session-chip__what-icon">›</span>{s.promptSnippet}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
          {/* overflow "+N more" pill — small, sits in the stack's overflow slot */}
          {layout.overflows.map((o) => {
            const top = o.top + pan.y
            const PILL_W = 110
            const left = o.worldXLeft + pan.x + (CARD_W - PILL_W) / 2
            if (top < -22 || top > graphHeight + 4) return null
            if (left < -PILL_W || left > containerSize.w) return null
            return (
              <div
                key={`ov-${o.key}`}
                className="canvas__chip-group canvas__chip-group--overflow"
                style={{ left, top, width: PILL_W, height: 22 }}
                onClick={(e) => {
                  e.stopPropagation()
                  clearCompare()
                  if (o.sessions[0]) onPinSession(o.sessions[0].id)
                }}
                title={o.sessions.map((s) => `${s.label}  ${s.title}`).join('\n')}
              >
                <div className="session-chip session-chip--overflow">+{o.count} more</div>
              </div>
            )
          })}
          {/* commit cards — dot-centered callouts using the same collision map */}
          {layout.commitSlots.map((cs) => {
            const c = cs.commit
            const top = cs.top + pan.y
            const left = cs.left + pan.x
            if (top < -COMMIT_H - 4 || top > graphHeight + 4) return null
            if (left < -COMMIT_CARD_W || left > containerSize.w) return null
            const mine = authorMatch(c)
            const pinned = pinnedCommitId === c.id
            const isAttach = pinnedAttachId === c.id
            const cmpA = compareCommits?.[0] === c.id || compareAnchor === c.id
            const cmpB = compareCommits?.[1] === c.id
            return (
              <div
                key={`com-${c.id}`}
                className={`canvas__chip-group canvas__commit-card${!mine ? ' canvas__commit-card--dim' : ''}${pinned || isAttach ? ' canvas__commit-card--active' : ''}${cmpA ? ' canvas__commit-card--cmp-a' : ''}${cmpB ? ' canvas__commit-card--cmp-b' : ''}`}
                style={{ left, top, width: COMMIT_CARD_W, height: COMMIT_H }}
                onClick={(e) => { e.stopPropagation(); onCommitClick(c, e) }}
                onMouseEnter={() => setHoveredCommitId(c.id)}
                onMouseLeave={() => setHoveredCommitId(null)}
                title={`${c.id}  ${c.author}\n${c.message}\n\n(Cmd/Ctrl-click to compare with another commit)`}
              >
                <div className="commit-card">
                  <div className="commit-card__row1">
                    <span className="commit-card__hash">{c.id}</span>
                    {c.isMerge && <span className="commit-card__tag commit-card__tag--merge">merge</span>}
                    {c.isHead && <span className="commit-card__tag commit-card__tag--head">HEAD</span>}
                    <span className="commit-card__author">{c.author}</span>
                    <span className="commit-card__date">{monthDay(c.date)}</span>
                  </div>
                  <div className="commit-card__msg">{c.message}</div>
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
            const visibleSessionCount = wt ? visibleSessionCountByWorktree.get(wt.id) || 0 : 0
            const empty = !wt || visibleSessionCount === 0
            return (
              <div
                key={`blabel-${b.id}`}
                className="canvas__lane-label-group"
                style={{ left: 8, top: y - 13 }}
                onClick={(e) => { e.stopPropagation(); handleBranchLabelClick(b) }}
              >
                <div className={`lane-label${active ? ' lane-label--active' : ''}${b.isDefault ? ' lane-label--main' : ''}${empty && !b.isDefault && !active ? ' lane-label--empty' : ''}`}>
                  <span className={`lane-label__dot lane-label__dot--${b.status}`} />
                  <span className="lane-label__name" title={b.name}>{b.name}</span>
                  {b.isDefault && <span className="lane-label__badge lane-label__badge--main">main</span>}
                  {b.mergedIntoBranchId && <span className="lane-label__badge lane-label__badge--merged">merged</span>}
                  {b.status === 'dirty' && !b.isDefault && <span className="lane-label__badge lane-label__badge--dirty">dirty</span>}
                  {b.status === 'unmerged' && <span className="lane-label__badge lane-label__badge--unmerged">unmerged</span>}
                  {wt && visibleSessionCount > 0 && (
                    <span
                      className="lane-label__sessions"
                      title={pinnedOnly ? `${visibleSessionCount} pinned Codex sessions` : `${visibleSessionCount} Codex sessions`}
                    >
                      {visibleSessionCount}
                    </span>
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
              {hoveredSession.lastUserSnippet && (
                <div className="session-popover__snippet session-popover__snippet--last">
                  <span className="session-chip__last-icon">↩ last:</span> {hoveredSession.lastUserSnippet}
                </div>
              )}
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
            sessionsHere={displaySessions.filter((s) => s.attachCommitId === pinnedCommit.id)}
            repoId={bundle.repo.id}
            onClose={() => onPinCommit(null)}
            onOpenSession={(id) => onPinSession(id)}
          />
        )}

        {/* live sessions panel */}
        {!pinnedSession && !pinnedCommit && (
          <div className={`live-panel${livePanelOpen ? '' : ' live-panel--collapsed'}`}>
            <button className="live-panel__head" onClick={() => setLivePanelOpen((v) => !v)}>
              <span className="live-panel__title"><span className="live-panel__pulse" />{pinnedOnly ? 'Pinned sessions' : 'Live sessions'}</span>
              <span className="live-panel__count">{liveSessions.length}</span>
              <span className="live-panel__chevron">{livePanelOpen ? '▸' : '◂'}</span>
            </button>
            {livePanelOpen && (
              <div className="live-panel__body">
                {liveSessions.length === 0 ? (
                  <div className="live-panel__empty">
                    {pinnedOnly ? 'No pinned sessions in this repo.' : 'No active sessions in this repo.'}
                  </div>
                ) : (
                  liveSessions.map(({ s, state }) => (
                    <button
                      key={s.id}
                      className={`live-row live-row--${state}${focusedSessionId === s.id ? ' live-row--focused' : ''}`}
                      onClick={() => { clearCompare(); focusSession(s.id) }}
                      onMouseEnter={() => setHoveredSessionId(s.id)}
                      onMouseLeave={() => setHoveredSessionId(null)}
                      title={s.title}
                    >
                      <span className={`live-row__dot live-row__dot--${state}`} />
                      {s.pinned && <span className="live-row__pin" title="Pinned in Codex">📌</span>}
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
        {/* compare-commits diff panel */}
        {compareCommits && (
          <div className="diff-panel" onMouseDown={(e) => e.stopPropagation()}>
            <div className="diff-panel__head">
              <span className="diff-panel__title">
                <span className="diff-panel__chip diff-panel__chip--a">{compareCommits[0]}</span>
                <span className="diff-panel__arrow">→</span>
                <span className="diff-panel__chip diff-panel__chip--b">{compareCommits[1]}</span>
              </span>
              <button
                className="diff-panel__close"
                onClick={() => { setCompareCommits(null); setCompareAnchor(null) }}
              >×</button>
            </div>
            <div className="diff-panel__summary">{compareDiff?.summary || 'Computing diff…'}</div>
            <div className="diff-panel__body">
              {!compareDiff ? (
                <div className="diff-panel__empty">…</div>
              ) : compareDiff.files.length === 0 ? (
                <div className="diff-panel__empty">No file changes (or commits are identical)</div>
              ) : (
                compareDiff.files.slice(0, 40).map((f) => {
                  const tot = Math.max(f.added + f.removed, 1)
                  return (
                    <div key={f.path} className="diff-row">
                      <span className="diff-row__path" title={f.path}>{f.path}</span>
                      <span className="diff-row__num diff-row__num--add">+{f.added}</span>
                      <span className="diff-row__num diff-row__num--del">−{f.removed}</span>
                      <span className="diff-row__bar">
                        <span className="diff-row__bar-add" style={{ width: `${(f.added / tot) * 100}%` }} />
                        <span className="diff-row__bar-del" style={{ width: `${(f.removed / tot) * 100}%` }} />
                      </span>
                    </div>
                  )
                })
              )}
              {compareDiff && compareDiff.files.length > 40 && (
                <div className="diff-panel__more">+{compareDiff.files.length - 40} more files…</div>
              )}
            </div>
            <div className="diff-panel__hint">Cmd/Ctrl-click another commit to swap the second side</div>
          </div>
        )}
        {compareAnchor && !compareCommits && (
          <div className="diff-hint">
            <span className="diff-panel__chip diff-panel__chip--a">{compareAnchor}</span> selected — Cmd/Ctrl-click another commit to diff
            <button onClick={() => setCompareAnchor(null)}>×</button>
          </div>
        )}

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
  commit, sessionsHere, repoId, onClose, onOpenSession,
}: {
  commit: Commit
  sessionsHere: CodexSession[]
  repoId: string
  onClose: () => void
  onOpenSession: (id: string) => void
}) {
  interface F { path: string; added: number; removed: number; status: string }
  const [files, setFiles] = useState<F[] | null>(null)
  const [summary, setSummary] = useState<string>('')
  useEffect(() => {
    let cancelled = false
    setFiles(null); setSummary('')
    fetch(`/api/commit-files?repo=${encodeURIComponent(repoId)}&commit=${commit.id}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) { setFiles(d.files || []); setSummary(d.summary || '') } })
      .catch(() => { if (!cancelled) setFiles([]) })
    return () => { cancelled = true }
  }, [commit.id, repoId])
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
      <div className="pinned-card__section-title">
        Changed files {summary && <span className="pinned-card__section-meta">{summary}</span>}
      </div>
      <FileDiffList
        repoId={repoId}
        a={commit.id}
        b={null}
        files={files}
      />
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
      ) : null}
      <div className="pinned-card__footer">Read-only · Cmd/Ctrl-click another commit dot to compare</div>
    </div>
  )
}

// File list with expandable unified diff per file
interface DiffFile { path: string; added: number; removed: number; status: string }
function FileDiffList({ repoId, a, b, files }: { repoId: string; a: string; b: string | null; files: DiffFile[] | null }) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [diffs, setDiffs] = useState<Record<string, string>>({})
  function toggle(path: string) {
    const next = new Set(open)
    if (next.has(path)) next.delete(path)
    else {
      next.add(path)
      if (!(path in diffs)) {
        const url = `/api/file-diff?repo=${encodeURIComponent(repoId)}&a=${a}${b ? `&b=${b}` : ''}&file=${encodeURIComponent(path)}`
        fetch(url).then((r) => r.json()).then((d) => setDiffs((cur) => ({ ...cur, [path]: d.diff || '' })))
          .catch(() => setDiffs((cur) => ({ ...cur, [path]: '(failed to load)' })))
      }
    }
    setOpen(next)
  }
  if (files === null) return <div className="file-diff__loading">Loading file list…</div>
  if (files.length === 0) return <div className="file-diff__empty">No file changes</div>
  return (
    <div className="file-diff__list">
      {files.slice(0, 60).map((f) => {
        const tot = Math.max(f.added + f.removed, 1)
        const isOpen = open.has(f.path)
        return (
          <div key={f.path} className={`file-diff__item${isOpen ? ' file-diff__item--open' : ''}`}>
            <button className="file-diff__row" onClick={() => toggle(f.path)} title={f.path}>
              <span className="file-diff__caret">{isOpen ? '▾' : '▸'}</span>
              <span className="file-diff__path">{f.path}</span>
              <span className="file-diff__num file-diff__num--add">+{f.added}</span>
              <span className="file-diff__num file-diff__num--del">−{f.removed}</span>
              <span className="file-diff__bar">
                <span className="file-diff__bar-add" style={{ width: `${(f.added / tot) * 100}%` }} />
                <span className="file-diff__bar-del" style={{ width: `${(f.removed / tot) * 100}%` }} />
              </span>
            </button>
            {isOpen && (
              <div className="file-diff__diff">
                {!(f.path in diffs) ? (
                  <div className="file-diff__loading">Loading diff…</div>
                ) : (
                  <pre className="file-diff__pre"><DiffRenderer text={diffs[f.path]} /></pre>
                )}
              </div>
            )}
          </div>
        )
      })}
      {files.length > 60 && (
        <div className="file-diff__more">+{files.length - 60} more files…</div>
      )}
    </div>
  )
}

// Tiny unified-diff colorer: + green, - red, @@ blue header
function DiffRenderer({ text }: { text: string }) {
  if (!text) return <span className="diff-empty">(no diff)</span>
  const lines = text.split('\n').slice(0, 2000)
  return (
    <>
      {lines.map((line, i) => {
        let cls = 'diff-line'
        if (line.startsWith('+++') || line.startsWith('---')) cls += ' diff-line--file'
        else if (line.startsWith('@@')) cls += ' diff-line--hunk'
        else if (line.startsWith('+')) cls += ' diff-line--add'
        else if (line.startsWith('-')) cls += ' diff-line--del'
        else if (line.startsWith('diff ') || line.startsWith('index ')) cls += ' diff-line--meta'
        return <div key={i} className={cls}>{line || ' '}</div>
      })}
    </>
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
