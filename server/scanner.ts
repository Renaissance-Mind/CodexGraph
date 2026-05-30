import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
// (execFileSync is referenced indirectly through safeExec only.)
import type {
  ApiPayload,
  Branch,
  CodexSession,
  Commit,
  DaySessionBucket,
  LineageConfidence,
  Repo,
  RepoBundle,
  SessionAutomation,
  Worktree,
  WorktreeStatus,
} from '../src/data/types'

const HOME = os.homedir()
const SESSIONS_ROOT = path.join(HOME, '.codex', 'sessions')
const SESSION_INDEX = path.join(HOME, '.codex', 'session_index.jsonl')
const AUTOMATIONS_ROOT = path.join(HOME, '.codex', 'automations')
const COMMIT_LIMIT = 400
const SESSION_FILE_LIMIT = 2000
const SYSTEM_USER_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '<system-reminder>',
  '# AGENTS.md',
  '## My request',
  '<task-notification>',
]

function safeExec(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 50 * 1024 * 1024,
    })
  } catch {
    return ''
  }
}

function slugify(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function shortHash(h: string): string {
  return h.slice(0, 7)
}

// ----------------- Codex session parsing -----------------

interface RawAutomation {
  id?: string
  kind: string
  name: string
  status: string
  rrule?: string
  promptSnippet?: string
}

interface RawSession {
  id: string
  cwd: string
  startTs: string
  endTs: string
  model: string
  cliVersion?: string
  originator?: string
  firstUserMsg: string
  transcriptPreview: string
  messageCount: number
  filePath: string
  /** latest thread_name set by Codex (user can rename a session) */
  threadName?: string
  /** automation derived from in-session automation_update events (create/update/delete replay) */
  sessionAutomation?: RawAutomation
}

function pickFirstRealUserMessage(content: unknown): string {
  if (!Array.isArray(content)) return ''
  for (const c of content) {
    if (c && typeof c === 'object' && 'text' in c) {
      const t = String((c as { text?: unknown }).text || '')
      if (!t) continue
      let isSystem = false
      for (const p of SYSTEM_USER_PREFIXES) {
        if (t.trimStart().startsWith(p)) {
          isSystem = true
          break
        }
      }
      if (isSystem) continue
      return t
    }
  }
  return ''
}

// Memory-bounded line reader. Small files are read whole; very large session
// files (heartbeat automations append forever — some reach 1 GB+) are sampled:
// only the head (meta + first messages) and tail (last timestamp + latest
// rename/automation) are read, skipping the token_count noise in the middle.
const FULL_SCAN_MAX = 8 * 1024 * 1024
const HEAD_BYTES = 2 * 1024 * 1024
const TAIL_BYTES = 1 * 1024 * 1024

function readSampledLines(filePath: string): { lines: string[]; truncated: boolean } | null {
  let fd: number
  let size: number
  try {
    size = fs.statSync(filePath).size
    fd = fs.openSync(filePath, 'r')
  } catch {
    return null
  }
  try {
    if (size <= FULL_SCAN_MAX) {
      const buf = Buffer.allocUnsafe(size)
      const n = fs.readSync(fd, buf, 0, size, 0)
      return { lines: buf.toString('utf8', 0, n).split('\n'), truncated: false }
    }
    const head = Buffer.allocUnsafe(HEAD_BYTES)
    const hb = fs.readSync(fd, head, 0, HEAD_BYTES, 0)
    const tail = Buffer.allocUnsafe(TAIL_BYTES)
    const tb = fs.readSync(fd, tail, 0, TAIL_BYTES, size - TAIL_BYTES)
    const headLines = head.toString('utf8', 0, hb).split('\n')
    headLines.pop() // last head line is probably partial
    const tailLines = tail.toString('utf8', 0, tb).split('\n')
    if (tailLines.length) tailLines.shift() // first tail line is probably partial
    return { lines: headLines.concat(tailLines), truncated: true }
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

function readJsonlSession(filePath: string): RawSession | null {
  const sampled = readSampledLines(filePath)
  if (!sampled) return null
  const lines = sampled.lines
  let meta: any = null
  let firstUserMsg = ''
  let firstAssistantMsg = ''
  let model = ''
  let startTs = ''
  let endTs = ''
  let messageCount = 0
  let threadName = ''   // last thread_name_updated wins
  let sessionAutomation: RawAutomation | undefined  // replay of automation_update events

  function applyAutomationUpdate(args: any) {
    if (!args || typeof args !== 'object') return
    const mode = String(args.mode || '')
    if (mode === 'delete') {
      sessionAutomation = undefined
      return
    }
    // create / update → set/merge current automation state
    const prompt = typeof args.prompt === 'string' ? args.prompt : ''
    sessionAutomation = {
      id: args.id ? String(args.id) : sessionAutomation?.id,
      kind: String(args.kind || sessionAutomation?.kind || 'heartbeat'),
      name: String(args.name || sessionAutomation?.name || args.id || 'automation'),
      status: String(args.status || sessionAutomation?.status || 'ACTIVE').toUpperCase(),
      rrule: args.rrule ? String(args.rrule) : sessionAutomation?.rrule,
      promptSnippet: prompt ? prompt.replace(/\s+/g, ' ').slice(0, 240) : sessionAutomation?.promptSnippet,
    }
  }

  // Fast path: most lines are `token_count` events we don't need. We only
  // JSON.parse a line when a cheap substring check says it carries something we
  // care about. This avoids parsing the bulk of large session files.
  const TS_RE = /"timestamp":"([^"]+)"/
  for (const line of lines) {
    if (!line) continue
    // start timestamp from the first line that has one
    if (!startTs) {
      const m = TS_RE.exec(line)
      if (m) startTs = m[1]
    }
    // cheap message count (no parse)
    const isMessage = line.indexOf('"type":"message"') !== -1
    if (isMessage) messageCount += 1

    if (!meta && line.indexOf('session_meta') !== -1) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'session_meta') {
          meta = obj.payload || {}
          if (meta.model) model = meta.model
        }
      } catch { /* skip */ }
      continue
    }
    if (line.indexOf('thread_name_updated') !== -1) {
      try {
        const p = JSON.parse(line).payload || {}
        if (p.type === 'thread_name_updated' && p.thread_name) {
          const tn = String(p.thread_name).trim()
          if (tn) threadName = tn
        }
      } catch { /* skip */ }
      continue
    }
    if (line.indexOf('automation_update') !== -1) {
      try {
        const p = JSON.parse(line).payload || {}
        if (
          (p.type === 'dynamic_tool_call_request' || p.type === 'dynamic_tool_call_response') &&
          p.tool === 'automation_update'
        ) {
          applyAutomationUpdate(p.arguments)
        }
      } catch { /* skip */ }
      continue
    }
    // turn_context may carry the model before any message
    if (!model && line.indexOf('turn_context') !== -1) {
      try {
        const m = JSON.parse(line).payload?.model
        if (m) model = m
      } catch { /* skip */ }
      continue
    }
    // only parse message lines while we still need the first user/assistant text
    if (isMessage && (!firstUserMsg || !firstAssistantMsg)) {
      try {
        const p = JSON.parse(line).payload || {}
        if (p.type === 'message') {
          if (p.role === 'user' && !firstUserMsg) {
            const text = pickFirstRealUserMessage(p.content)
            if (text) firstUserMsg = text
          } else if (p.role === 'assistant' && !firstAssistantMsg) {
            const text = pickFirstRealUserMessage(p.content)
            if (text) firstAssistantMsg = text
          }
        }
      } catch { /* skip */ }
    }
  }
  // end timestamp from the last line that has one (no full parse)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (!l) continue
    const m = TS_RE.exec(l)
    if (m) { endTs = m[1]; break }
  }

  if (!meta || !meta.id) return null
  const cwd = String(meta.cwd || '')
  if (!cwd) return null

  const transcriptPreview = [
    firstUserMsg ? `user: ${firstUserMsg.slice(0, 400)}` : '',
    firstAssistantMsg ? `assistant: ${firstAssistantMsg.slice(0, 400)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    id: String(meta.id),
    cwd,
    startTs: startTs || meta.timestamp || '',
    endTs: endTs || meta.timestamp || '',
    model: model || meta.model || '',
    cliVersion: meta.cli_version,
    originator: meta.originator,
    firstUserMsg,
    transcriptPreview,
    messageCount,
    filePath,
    threadName: threadName || undefined,
    sessionAutomation,
  }
}

/** ~/.codex/session_index.jsonl maps session uuid → app-renamed thread_name */
function loadSessionIndex(): Map<string, { threadName: string; updatedAt?: string }> {
  const m = new Map<string, { threadName: string; updatedAt?: string }>()
  let raw: string
  try {
    raw = fs.readFileSync(SESSION_INDEX, 'utf8')
  } catch {
    return m
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      const id = String(obj.id || '')
      const name = String(obj.thread_name || '').trim()
      if (!id || !name) continue
      m.set(id, { threadName: name, updatedAt: obj.updated_at })
    } catch {
      /* skip */
    }
  }
  return m
}

/** Minimal flat TOML parser (key = value per line). Strings/numbers/bools only. */
function parseFlatToml(text: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^\s+|\s+$/g, '')
    if (!line || line.startsWith('#') || line.startsWith('[')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const k = line.slice(0, eq).trim()
    let v: string = line.slice(eq + 1).trim()
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) continue
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      try {
        out[k] = JSON.parse(v) as string  // handles escapes
      } catch {
        out[k] = v.slice(1, -1)
      }
    } else if (/^-?\d+$/.test(v)) {
      out[k] = parseInt(v, 10)
    } else if (/^-?\d+\.\d+$/.test(v)) {
      out[k] = parseFloat(v)
    } else if (v === 'true' || v === 'false') {
      out[k] = v === 'true'
    } else {
      out[k] = v
    }
  }
  return out
}

/** Read ~/.codex/automations/[name]/automation.toml grouped by target_thread_id. */
function loadAutomations(): Map<string, SessionAutomation> {
  const m = new Map<string, SessionAutomation>()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(AUTOMATIONS_ROOT, { withFileTypes: true })
  } catch {
    return m
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const file = path.join(AUTOMATIONS_ROOT, ent.name, 'automation.toml')
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const t = parseFlatToml(raw)
    const target = String(t.target_thread_id || '')
    if (!target) continue
    const promptStr = String(t.prompt || '')
    const auto: SessionAutomation = {
      id: String(t.id || ent.name),
      kind: String(t.kind || ''),
      name: String(t.name || t.id || ent.name),
      status: String(t.status || 'UNKNOWN'),
      rrule: t.rrule ? String(t.rrule) : undefined,
      createdAt: typeof t.created_at === 'number' ? t.created_at : undefined,
      updatedAt: typeof t.updated_at === 'number' ? t.updated_at : undefined,
      promptSnippet: promptStr ? promptStr.replace(/\s+/g, ' ').slice(0, 240) : undefined,
    }
    // if multiple automations point to the same thread, keep the most recently updated
    const prev = m.get(target)
    if (!prev || (auto.updatedAt || 0) > (prev.updatedAt || 0)) m.set(target, auto)
  }
  return m
}

function findAllSessionFiles(): string[] {
  const out: string[] = []
  function walk(dir: string) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(full)
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(full)
    }
  }
  walk(SESSIONS_ROOT)
  return out
}

// ----------------- Git repo discovery -----------------

function gitToplevel(cwd: string): string | null {
  const out = safeExec('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], '/')
  const line = out.trim().split('\n')[0]
  return line || null
}

function gitDefaultBranch(repoPath: string): string {
  const branches = safeExec('git', ['-C', repoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], '/')
    .trim()
    .split('\n')
    .filter(Boolean)
  // prefer common trunk names if present
  const preferred = ['main', 'master', 'trunk', 'develop']
  for (const p of preferred) if (branches.includes(p)) return p
  // try origin/HEAD as a secondary hint
  const head = safeExec('git', ['-C', repoPath, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], '/').trim()
  if (head) {
    const m = head.match(/^origin\/(.+)$/)
    if (m && branches.includes(m[1])) return m[1]
  }
  // fallback: first listed branch
  return branches[0] || 'main'
}

interface RawWorktree {
  path: string
  head: string
  branchRef?: string  // e.g. 'refs/heads/main'
  detached: boolean
}

function gitWorktrees(repoPath: string): RawWorktree[] {
  const out = safeExec('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], '/')
  const entries: RawWorktree[] = []
  let cur: Partial<RawWorktree> | null = null
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith('worktree ')) {
      if (cur && cur.path) entries.push({ detached: false, head: '', ...(cur as RawWorktree), path: cur.path } as RawWorktree)
      cur = { path: line.slice('worktree '.length) }
    } else if (line.startsWith('HEAD ')) {
      if (cur) cur.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      if (cur) cur.branchRef = line.slice('branch '.length)
    } else if (line === 'detached') {
      if (cur) cur.detached = true
    } else if (line === '' && cur && cur.path) {
      entries.push({ detached: false, head: '', branchRef: undefined, ...(cur as RawWorktree), path: cur.path } as RawWorktree)
      cur = null
    }
  }
  if (cur && cur.path) entries.push({ detached: false, head: '', ...(cur as RawWorktree), path: cur.path } as RawWorktree)
  return entries
}

interface RawCommit {
  full: string
  short: string
  parents: string[]
  author: string
  date: string
  message: string
  refs: string[]
}

function gitLogAll(repoPath: string): RawCommit[] {
  // %x1f as field sep
  const FMT = ['%H', '%P', '%an', '%aI', '%s', '%D'].join('%x1f')
  const out = safeExec(
    'git',
    ['-C', repoPath, 'log', '--all', `--max-count=${COMMIT_LIMIT}`, `--pretty=format:${FMT}`, '--no-show-signature'],
    '/',
  )
  const commits: RawCommit[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const parts = line.split('\x1f')
    if (parts.length < 6) continue
    const [full, parentsStr, author, date, message, refsStr] = parts
    const refs = refsStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^HEAD -> /, ''))
    commits.push({
      full,
      short: shortHash(full),
      parents: parentsStr.split(' ').filter(Boolean).map(shortHash),
      author,
      date,
      message,
      refs,
    })
  }
  return commits
}

function gitIsDirty(worktreePath: string): boolean {
  const out = safeExec('git', ['-C', worktreePath, 'status', '--porcelain'], '/')
  return out.trim().length > 0
}

// ----------------- Build bundle for a single repo -----------------

function buildBundle(
  repoPath: string,
  rawSessions: RawSession[],
  sessionIndex: Map<string, { threadName: string; updatedAt?: string }>,
  automations: Map<string, SessionAutomation>,
): RepoBundle | null {
  const rawWorktrees = gitWorktrees(repoPath)
  const allCommits = gitLogAll(repoPath)
  if (rawWorktrees.length === 0 || allCommits.length === 0) return null

  // Default branch = primary worktree's branch (= the branch the user has checked
  // out at the repo root). Falls back to git's conventional names if the primary
  // worktree is detached.
  const primaryWt = rawWorktrees.find(
    (w) => path.resolve(w.path) === path.resolve(repoPath),
  )
  let defaultBranchName: string
  if (primaryWt && !primaryWt.detached && primaryWt.branchRef) {
    defaultBranchName = primaryWt.branchRef.replace(/^refs\/heads\//, '')
  } else {
    defaultBranchName = gitDefaultBranch(repoPath)
  }

  // map full hash → short, short → commit
  const byShort = new Map<string, RawCommit>()
  for (const c of allCommits) byShort.set(c.short, c)

  // canonical repoId derives from primary worktree path (= repoPath)
  const repoName = path.basename(repoPath)
  const repoId = slugify(repoName + '-' + path.dirname(repoPath).split(path.sep).slice(-1)[0])

  // Build worktrees + decide branches set
  const usedBranchNames = new Set<string>()
  usedBranchNames.add(defaultBranchName)

  const worktrees: Worktree[] = rawWorktrees.map((rw, i) => {
    const isPrimary = path.resolve(rw.path) === path.resolve(repoPath)
    const branchName = rw.detached || !rw.branchRef
      ? `detached @ ${shortHash(rw.head)}`
      : rw.branchRef.replace(/^refs\/heads\//, '')
    if (!rw.detached && rw.branchRef) usedBranchNames.add(branchName)
    const dirty = gitIsDirty(rw.path)
    const status: WorktreeStatus = rw.detached ? 'unknown' : dirty ? 'dirty' : 'clean'
    const headShort = shortHash(rw.head)
    const headCommit = byShort.get(headShort)
    return {
      id: slugify(`${repoId}-wt-${i}-${branchName}`),
      repoId,
      branchId: rw.detached || !rw.branchRef ? undefined : slugify(`${repoId}-br-${branchName}`),
      branchName,
      path: rw.path.replace(HOME, '~'),
      isPrimary,
      status,
      sessionCount: 0,
      lineageConfidence: 'high',
      head: {
        commitId: headShort,
        fullCommitId: rw.head,
        author: headCommit?.author || '',
        message: headCommit?.message || '',
        date: headCommit?.date || '',
      },
    }
  })

  // Also include branches that have no worktree but appear in refs and have sessions
  // (we'll add them lazily after session attach)

  // Build branches array
  const branchesMap = new Map<string, Branch>()
  let laneCounter = 1
  for (const name of usedBranchNames) {
    const id = slugify(`${repoId}-br-${name}`)
    const isDefault = name === defaultBranchName
    // find head commit of this branch from refs in commits
    const refLabel = `refs/heads/${name}`
    let head: RawCommit | undefined
    for (const c of allCommits) {
      if (c.refs.includes(refLabel) || c.refs.includes(name)) {
        head = c
        break
      }
    }
    const lane = isDefault ? 0 : (laneCounter % 2 === 0 ? -1 : 1) * Math.ceil(laneCounter / 2)
    if (!isDefault) laneCounter += 1
    branchesMap.set(id, {
      id,
      name,
      lane,
      headCommitId: head?.short,
      lineageConfidence: 'high',
      status: 'clean',
      isDefault,
    })
  }

  // Inherit status from worktrees → branch
  for (const wt of worktrees) {
    if (!wt.branchId) continue
    const b = branchesMap.get(wt.branchId)
    if (!b) continue
    if (wt.status === 'dirty') b.status = 'dirty'
    if (wt.status === 'unmerged') b.status = 'unmerged'
  }

  // Compute fork point / merged-into for each non-default branch.
  // Use in-memory BFS of the default branch's reachable set once below.
  const defaultBranchId = slugify(`${repoId}-br-${defaultBranchName}`)
  const defaultBranch = branchesMap.get(defaultBranchId)

  // Build in-memory parent map for BFS (no shell calls!)
  const parents = new Map<string, string[]>()
  for (const c of allCommits) parents.set(c.short, c.parents)

  function reachableFrom(head: string): Set<string> {
    const seen = new Set<string>()
    const stack = [head]
    while (stack.length) {
      const s = stack.pop()!
      if (seen.has(s)) continue
      seen.add(s)
      const ps = parents.get(s)
      if (ps) for (const p of ps) stack.push(p)
    }
    return seen
  }

  // default-branch reachable set
  const defaultReachable = defaultBranch?.headCommitId
    ? reachableFrom(defaultBranch.headCommitId)
    : new Set<string>()

  // For each non-default branch:
  //  - fork point = first ancestor reachable from default head (in-memory)
  //  - merged-into = branch head itself is reachable from default head
  for (const b of branchesMap.values()) {
    if (b.isDefault) continue
    if (!b.headCommitId || !defaultBranch?.headCommitId) continue
    const headShort = b.headCommitId
    // walk first-parent chain from branch head until we hit a defaultReachable commit
    let cur: string | undefined = headShort
    let fork: string | undefined
    const guard = new Set<string>()
    while (cur && !guard.has(cur)) {
      guard.add(cur)
      if (defaultReachable.has(cur)) {
        fork = cur
        break
      }
      const ps = parents.get(cur)
      cur = ps && ps.length ? ps[0] : undefined
    }
    if (!fork) {
      // fallback: BFS for any reachable commit in default set
      const stack = [headShort]
      const seen = new Set<string>()
      while (stack.length && !fork) {
        const s = stack.pop()!
        if (seen.has(s)) continue
        seen.add(s)
        if (defaultReachable.has(s)) {
          fork = s
          break
        }
        const ps = parents.get(s)
        if (ps) for (const p of ps) stack.push(p)
      }
    }
    if (fork) {
      b.forkFromCommitId = fork
      b.forkFromBranchId = defaultBranchId
      if (defaultReachable.has(headShort) && headShort !== fork) {
        b.mergedIntoBranchId = defaultBranchId
        b.mergedIntoCommitId = defaultBranch.headCommitId
        b.status = 'clean'
      }
    }
  }

  // Order branches by activity: most-recent head first, so it claims commits
  // before older sibling branches.
  const nonDefaultBranchOrder = [...branchesMap.values()].filter((b) => !b.isDefault)
  nonDefaultBranchOrder.sort((a, b) => {
    const ah = a.headCommitId ? byShort.get(a.headCommitId)?.date || '' : ''
    const bh = b.headCommitId ? byShort.get(b.headCommitId)?.date || '' : ''
    return ah > bh ? -1 : 1
  })

  const commitBranch = new Map<string, string>()
  // Phase 1: explicit refs win
  for (const c of allCommits) {
    for (const r of c.refs) {
      const m = r.match(/^refs\/heads\/(.+)$/)
      const name = m ? m[1] : r
      const id = slugify(`${repoId}-br-${name}`)
      if (branchesMap.has(id)) {
        commitBranch.set(c.short, id)
        break
      }
    }
  }
  // Phase 2: walk each non-default branch's first-parent chain. Claim commits that
  // are NOT reachable from the default branch head and not yet claimed.
  for (const b of nonDefaultBranchOrder) {
    if (!b.headCommitId) continue
    let cur: string | undefined = b.headCommitId
    while (cur) {
      if (defaultReachable.has(cur)) break
      if (!commitBranch.has(cur)) commitBranch.set(cur, b.id)
      const ps = parents.get(cur)
      cur = ps && ps.length ? ps[0] : undefined
    }
  }
  // Phase 3: everything else → default
  for (const c of allCommits) {
    if (!commitBranch.has(c.short)) commitBranch.set(c.short, defaultBranchId)
  }

  // Track branch heads for later
  const branchHeadByShort = new Map<string, string>()
  for (const b of branchesMap.values()) {
    if (b.headCommitId) branchHeadByShort.set(b.headCommitId, b.id)
  }

  // Sort commits by date ascending → x index
  const sortedCommits = [...allCommits].sort((a, b) => (a.date < b.date ? -1 : 1))
  const xByShort = new Map<string, number>()
  sortedCommits.forEach((c, idx) => xByShort.set(c.short, idx))

  // Build Commit objects
  const headFullByPath = new Map<string, string>()
  for (const rw of rawWorktrees) headFullByPath.set(shortHash(rw.head), rw.head)
  const isHeadSet = new Set<string>(headFullByPath.keys())
  // also flag branch heads as HEAD
  for (const b of branchesMap.values()) if (b.headCommitId) isHeadSet.add(b.headCommitId)

  const commits: Commit[] = sortedCommits.map((c) => ({
    id: c.short,
    fullId: c.full,
    parents: c.parents,
    message: c.message,
    author: c.author,
    date: c.date,
    branchId: commitBranch.get(c.short) || defaultBranchId,
    x: xByShort.get(c.short) || 0,
    isMerge: c.parents.length > 1,
    isHead: isHeadSet.has(c.short),
    refNames: c.refs,
  }))

  // Now reorder branch lanes by activity (most recent commits closer to main)
  const branchLastCommit = new Map<string, number>()
  for (const c of commits) {
    const cur = branchLastCommit.get(c.branchId) || 0
    if (c.x > cur) branchLastCommit.set(c.branchId, c.x)
  }
  const nonDefault = [...branchesMap.values()].filter((b) => !b.isDefault)
  nonDefault.sort((a, b) => (branchLastCommit.get(b.id) || 0) - (branchLastCommit.get(a.id) || 0))
  let above = 1
  let below = 1
  nonDefault.forEach((b, i) => {
    if (i % 2 === 0) {
      b.lane = below
      below += 1
    } else {
      b.lane = -above
      above += 1
    }
  })

  // Attach sessions to worktrees: match by cwd
  const wtByPath = new Map<string, Worktree>()
  for (const wt of worktrees) {
    const absPath = wt.path.startsWith('~') ? wt.path.replace('~', HOME) : wt.path
    wtByPath.set(absPath, wt)
  }
  const primary = worktrees.find((w) => w.isPrimary)!

  const codexSessions: CodexSession[] = []
  // group raw sessions by worktree, sort by start time, assign labels
  const groups = new Map<string, RawSession[]>()
  for (const s of rawSessions) {
    const cwd = s.cwd
    const wt = wtByPath.get(cwd) || primary
    if (!groups.has(wt.id)) groups.set(wt.id, [])
    groups.get(wt.id)!.push(s)
  }

  for (const [wtId, list] of groups) {
    list.sort((a, b) => (a.startTs < b.startTs ? -1 : 1))
    const wt = worktrees.find((w) => w.id === wtId)!
    list.forEach((s, idx) => {
      const start = new Date(s.startTs).getTime()
      const end = new Date(s.endTs).getTime()
      const durationMin = Math.max(0, Math.round((end - start) / 60000))

      // attach to commit on the worktree's branch closest in time (≤ s.startTs)
      const branchId = wt.branchId
      let attach: Commit | undefined
      if (branchId) {
        const candidates = commits.filter((c) => c.branchId === branchId && c.date <= s.startTs)
        candidates.sort((a, b) => (a.date > b.date ? -1 : 1))
        attach = candidates[0]
        if (!attach) {
          // fall back to branch head
          attach = commits.find((c) => c.id === branchHeadByShort.has(c.id) ? false : false)
          const b = branchesMap.get(branchId)
          if (b?.headCommitId) attach = commits.find((c) => c.id === b.headCommitId)
        }
      }
      if (!attach) {
        // last resort: worktree HEAD
        attach = commits.find((c) => c.id === wt.head.commitId)
      }

      const firstUser = s.firstUserMsg || ''
      // Rename source priority: Codex app (session_index.jsonl) > CLI thread_name_updated event
      const appRename = sessionIndex.get(s.id)?.threadName?.trim() || ''
      const cliRename = (s.threadName || '').trim()
      const renamed = appRename || cliRename
      const renameSource: 'app' | 'cli' | undefined =
        appRename ? 'app' : cliRename ? 'cli' : undefined
      const title = renamed
        ? renamed.replace(/\s+/g, ' ').slice(0, 120)
        : firstUser
          ? firstUser.replace(/\s+/g, ' ').trim().slice(0, 80) || '(empty prompt)'
          : '(no user prompt)'
      const snippet = firstUser ? firstUser.replace(/\s+/g, ' ').trim().slice(0, 220) : ''
      // Automation binding: prefer the live toml (authoritative current status),
      // else fall back to the automation the session created itself (in-session
      // automation_update replay) — catches automations with no toml on disk.
      let automation: SessionAutomation | undefined = automations.get(s.id)
      if (!automation && s.sessionAutomation) {
        const ra = s.sessionAutomation
        automation = {
          id: ra.id || s.id,
          kind: ra.kind,
          name: ra.name,
          status: ra.status,
          rrule: ra.rrule,
          promptSnippet: ra.promptSnippet,
        }
      }

      codexSessions.push({
        id: s.id,
        label: `S${idx + 1}`,
        repoId,
        worktreeId: wt.id,
        branchId: wt.branchId,
        attachCommitId: attach?.id,
        cwd: s.cwd.replace(HOME, '~'),
        date: s.startTs,
        endDate: s.endTs,
        durationMin,
        title,
        titleRenamed: !!renamed,
        renameSource,
        promptSnippet: snippet,
        prompt: (firstUser || '').slice(0, 4000),
        model: s.model || 'unknown',
        cliVersion: s.cliVersion,
        originator: s.originator,
        transcriptPreview: s.transcriptPreview,
        messageCount: s.messageCount,
        automation,
      })
      wt.sessionCount += 1
    })
  }

  // Lineage info on worktrees from branch data
  for (const wt of worktrees) {
    if (!wt.branchId) continue
    const b = branchesMap.get(wt.branchId)
    if (!b) continue
    if (b.forkFromCommitId && b.forkFromBranchId) {
      const forkBranch = branchesMap.get(b.forkFromBranchId)
      wt.forkedFrom = `${forkBranch?.name || ''} @ ${b.forkFromCommitId}`
      wt.mergeBase = b.forkFromCommitId
    }
    if (b.mergedIntoBranchId && b.mergedIntoCommitId) {
      const mergedB = branchesMap.get(b.mergedIntoBranchId)
      wt.mergedInto = mergedB?.name || ''
      wt.mergeCommit = b.mergedIntoCommitId
    } else {
      wt.mergedInto = wt.mergedInto || '—'
      wt.mergeCommit = wt.mergeCommit || '—'
    }
    wt.lineageConfidence = b.lineageConfidence
  }

  // Date range = first session - last session (else commits range)
  const allDates = codexSessions.map((s) => s.date).filter(Boolean)
  let rangeStart = ''
  let rangeEnd = ''
  if (allDates.length > 0) {
    allDates.sort()
    rangeStart = allDates[0]
    rangeEnd = allDates[allDates.length - 1]
  } else if (commits.length) {
    rangeStart = commits[0].date
    rangeEnd = commits[commits.length - 1].date
  }

  // Build daily buckets across rangeStart..rangeEnd
  const sessionBuckets: DaySessionBucket[] = []
  if (rangeStart && rangeEnd) {
    const startDate = new Date(rangeStart.slice(0, 10))
    const endDate = new Date(rangeEnd.slice(0, 10))
    const day = 24 * 3600 * 1000
    const counts = new Map<string, number>()
    for (const s of codexSessions) {
      const d = s.date.slice(0, 10)
      counts.set(d, (counts.get(d) || 0) + 1)
    }
    for (let t = startDate.getTime(); t <= endDate.getTime(); t += day) {
      const d = new Date(t).toISOString().slice(0, 10)
      sessionBuckets.push({ date: d, count: counts.get(d) || 0 })
    }
  }

  const repo: Repo = {
    id: repoId,
    name: repoName,
    path: repoPath.replace(HOME, '~'),
    worktreeIds: worktrees.map((w) => w.id),
    branchIds: [...branchesMap.values()].map((b) => b.id),
    defaultBranchId,
    sessionCount: codexSessions.length,
    commitCount: commits.length,
  }

  // Drop branches with no commits at all
  const branchHasCommit = new Set<string>()
  for (const c of commits) branchHasCommit.add(c.branchId)
  const branchList = [...branchesMap.values()].filter((b) => branchHasCommit.has(b.id) || b.isDefault)

  return {
    repo,
    worktrees,
    branches: branchList,
    commits,
    sessions: codexSessions,
    sessionBuckets,
    dateRange: { start: rangeStart, end: rangeEnd, label: formatRangeLabel(rangeStart, rangeEnd) },
  }
}

function formatRangeLabel(start: string, end: string): string {
  if (!start || !end) return ''
  const s = new Date(start)
  const e = new Date(end)
  const opt: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  const sLabel = s.toLocaleDateString('en-US', opt)
  const eLabel = e.toLocaleDateString('en-US', { ...opt, year: 'numeric' })
  return `${sLabel} – ${eLabel}`
}

// ----------------- Top-level scan -----------------

let cache: { payload: ApiPayload; ts: number } | null = null
const CACHE_TTL_MS = 30 * 60 * 1000

// persistent cwd → git toplevel cache (paths rarely move)
const TOPLEVEL_CACHE_PATH = path.join(os.tmpdir(), 'sessiontree-toplevel-cache.json')
let toplevelDisk: Record<string, string | null> | null = null
function loadToplevelCache(): Record<string, string | null> {
  if (toplevelDisk) return toplevelDisk
  try {
    toplevelDisk = JSON.parse(fs.readFileSync(TOPLEVEL_CACHE_PATH, 'utf8'))
  } catch {
    toplevelDisk = {}
  }
  return toplevelDisk!
}
function saveToplevelCache(obj: Record<string, string | null>) {
  try { fs.writeFileSync(TOPLEVEL_CACHE_PATH, JSON.stringify(obj)) } catch { /* best effort */ }
}

// ---- disk-persisted per-file cache (keyed by path + mtime + size) ----
const FILE_CACHE_PATH = path.join(os.tmpdir(), 'sessiontree-session-cache.json')
interface FileCacheEntry { mtimeMs: number; size: number; session: RawSession | null }
let fileCache: Map<string, FileCacheEntry> | null = null

function loadFileCache(): Map<string, FileCacheEntry> {
  if (fileCache) return fileCache
  fileCache = new Map()
  try {
    const raw = fs.readFileSync(FILE_CACHE_PATH, 'utf8')
    const obj = JSON.parse(raw) as Record<string, FileCacheEntry>
    for (const [k, v] of Object.entries(obj)) fileCache.set(k, v)
  } catch { /* no cache yet */ }
  return fileCache
}

function saveFileCache(c: Map<string, FileCacheEntry>) {
  try {
    const obj: Record<string, FileCacheEntry> = {}
    for (const [k, v] of c) obj[k] = v
    fs.writeFileSync(FILE_CACHE_PATH, JSON.stringify(obj))
  } catch { /* best effort */ }
}

/** Read a session, reusing the disk cache when the file is unchanged (mtime+size). */
function readJsonlSessionCached(filePath: string, c: Map<string, FileCacheEntry>): RawSession | null {
  let st: fs.Stats
  try {
    st = fs.statSync(filePath)
  } catch {
    return null
  }
  const hit = c.get(filePath)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return hit.session
  }
  const session = readJsonlSession(filePath)
  c.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, session })
  return session
}

export function scanAll(force = false): ApiPayload {
  if (!force && cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.payload

  // 1. read all session files — incremental: only re-parse changed/new files
  const files = findAllSessionFiles().slice(0, SESSION_FILE_LIMIT)
  const fc = loadFileCache()
  const seenPaths = new Set<string>()
  const sessions: RawSession[] = []
  let reparsed = 0
  for (const f of files) {
    seenPaths.add(f)
    const before = fc.get(f)
    const s = readJsonlSessionCached(f, fc)
    if (!before || before.mtimeMs !== fc.get(f)!.mtimeMs) reparsed += 1
    if (s) sessions.push(s)
  }
  // drop cache entries for files that no longer exist
  for (const k of [...fc.keys()]) if (!seenPaths.has(k)) fc.delete(k)
  saveFileCache(fc)
  if (process.env.SESSIONTREE_DEBUG) {
    console.log(`[scan] ${files.length} files, ${reparsed} (re)parsed, ${files.length - reparsed} from cache`)
  }

  // 2. group by repo root (via git toplevel of cwd) — toplevel is disk-cached
  const repoToSessions = new Map<string, RawSession[]>()
  const tlCache = loadToplevelCache()
  let tlChanged = false
  for (const s of sessions) {
    let top = tlCache[s.cwd]
    if (top === undefined) {
      top = gitToplevel(s.cwd)
      tlCache[s.cwd] = top
      tlChanged = true
    }
    if (!top) continue
    if (!repoToSessions.has(top)) repoToSessions.set(top, [])
    repoToSessions.get(top)!.push(s)
  }
  if (tlChanged) saveToplevelCache(tlCache)

  // Collapse worktrees that share the same primary repo (canonical via .git common dir)
  // Use `git rev-parse --git-common-dir` to canonicalize — disk-cached (stable)
  const canonical = new Map<string, string>() // toplevel -> canonical primary worktree path
  const canonCache = loadToplevelCache() // reuse same store with a "canon:" prefix
  let canonChanged = false
  for (const top of repoToSessions.keys()) {
    const ck = `canon:${top}`
    let primaryRoot = canonCache[ck] as string | undefined
    if (primaryRoot === undefined || primaryRoot === null) {
      const commonDir = safeExec('git', ['-C', top, 'rev-parse', '--git-common-dir'], '/').trim().split('\n')[0]
      if (!commonDir) {
        primaryRoot = top
      } else {
        let primaryGitDir = commonDir
        if (!path.isAbsolute(primaryGitDir)) primaryGitDir = path.resolve(top, primaryGitDir)
        primaryRoot = top
        if (path.basename(primaryGitDir) === '.git') primaryRoot = path.dirname(primaryGitDir)
        else {
          const wts = gitWorktrees(top)
          if (wts.length) primaryRoot = wts[0].path
        }
      }
      canonCache[ck] = primaryRoot
      canonChanged = true
    }
    canonical.set(top, primaryRoot)
  }
  if (canonChanged) saveToplevelCache(canonCache)

  const merged = new Map<string, RawSession[]>()
  for (const [top, sList] of repoToSessions) {
    const c = canonical.get(top) || top
    if (!merged.has(c)) merged.set(c, [])
    merged.get(c)!.push(...sList)
  }

  // 3. load auxiliary indices used across bundles
  const sessionIndex = loadSessionIndex()
  const automations = loadAutomations()

  // 4. build bundles
  const bundles: Record<string, RepoBundle> = {}
  const repos: Repo[] = []
  for (const [repoPath, sList] of merged) {
    const bundle = buildBundle(repoPath, sList, sessionIndex, automations)
    if (!bundle) continue
    bundles[bundle.repo.id] = bundle
    repos.push(bundle.repo)
  }

  // sort repos by session count desc
  repos.sort((a, b) => b.sessionCount - a.sessionCount)

  // default repo: prefer 'EditReward' if present (per requirements doc), else top of list
  const preferred = repos.find((r) => r.name === 'EditReward')
  const defaultRepoId = preferred?.id || repos[0]?.id || ''

  const payload: ApiPayload = {
    syncedAt: new Date().toISOString(),
    repos,
    bundles,
    defaultRepoId,
  }
  cache = { payload, ts: Date.now() }
  return payload
}
