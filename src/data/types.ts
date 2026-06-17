export type WorktreeStatus = 'clean' | 'dirty' | 'unmerged' | 'unknown'

export type LineageConfidence = 'high' | 'medium' | 'low'

export interface Repo {
  id: string                // slug derived from repo root path
  name: string              // basename of repo root
  path: string              // absolute repo root (primary worktree)
  lastUsedAt: string        // latest session event timestamp; falls back to latest commit date
  worktreeIds: string[]
  branchIds: string[]
  defaultBranchId: string
  sessionCount: number
  /** total commits collected for this repo (capped) */
  commitCount: number
}

export interface Commit {
  id: string                // short hash
  fullId: string
  parents: string[]         // short hashes
  message: string
  author: string
  date: string              // ISO
  /** branch id this commit primarily belongs to in our layout */
  branchId: string
  /** layout x index (0..N) — older = smaller */
  x: number
  isMerge: boolean
  isHead: boolean           // is HEAD of some branch/worktree
  refNames: string[]        // refs pointing at this commit
}

export interface Branch {
  id: string                // slug
  name: string              // ref name without refs/heads/
  lane: number              // 0 = main, +/-N for laid-out lanes
  headCommitId?: string
  forkFromCommitId?: string
  forkFromBranchId?: string
  mergedIntoCommitId?: string
  mergedIntoBranchId?: string
  lineageConfidence: LineageConfidence
  status: WorktreeStatus
  isDefault: boolean
}

export interface Worktree {
  id: string                // slug
  repoId: string
  branchId?: string         // undefined when detached
  branchName: string        // 'detached @ abc1234' fallback
  path: string
  isPrimary: boolean        // primary worktree (= repo root)
  status: WorktreeStatus
  sessionCount: number
  forkedFrom?: string       // "<branch> @ <short>"
  mergeBase?: string
  mergedInto?: string
  mergeCommit?: string
  lineageConfidence: LineageConfidence
  head: {
    commitId: string
    fullCommitId: string
    author: string
    message: string
    date: string
  }
}

export type AutomationStatus = 'ACTIVE' | 'PAUSED' | 'STOPPED' | 'COMPLETED' | string

export interface SessionAutomation {
  id: string
  kind: string            // 'heartbeat', etc
  name: string
  status: AutomationStatus
  rrule?: string          // 'FREQ=HOURLY;INTERVAL=1' etc
  createdAt?: number      // ms
  updatedAt?: number      // ms
  promptSnippet?: string  // first 240 chars of automation prompt
}

export interface CodexSession {
  id: string                // session id (uuid)
  label: string             // 'S1', 'S2', … within the worktree, oldest first
  repoId: string
  worktreeId: string
  branchId?: string
  /** commit nearest in time on the worktree's branch */
  attachCommitId?: string
  /** raw cwd recorded in session_meta */
  cwd: string
  date: string              // ISO start
  endDate: string           // ISO end (= last event timestamp)
  durationMin: number
  title: string             // user-renamed thread name (if any) or first-prompt summary
  /** true when title comes from a user rename in Codex (vs. auto-derived from the prompt) */
  titleRenamed: boolean
  /** where the rename came from: 'app' (session_index.jsonl) | 'cli' (thread_name_updated event) | undefined */
  renameSource?: 'app' | 'cli'
  promptSnippet: string     // longer truncation of the first user msg
  prompt: string            // full first user msg (truncated to a few KB)
  lastUserSnippet: string   // short snippet of the LAST user message (empty if same as first)
  lastUserPrompt: string    // longer last user message (truncated)
  model: string
  cliVersion?: string
  originator?: string
  transcriptPreview: string // a couple of msgs joined
  messageCount: number
  /** Codex automation attached to this session, if any */
  automation?: SessionAutomation
  /** True when this session id is in ~/.codex/.codex-global-state.json's pinned-thread-ids */
  pinned: boolean
}

export interface DaySessionBucket {
  date: string              // YYYY-MM-DD
  count: number
}

export interface RepoBundle {
  repo: Repo
  worktrees: Worktree[]
  branches: Branch[]
  commits: Commit[]
  sessions: CodexSession[]
  sessionBuckets: DaySessionBucket[]
  dateRange: { start: string; end: string; label: string }
}

export interface ApiPayload {
  syncedAt: string
  repos: Repo[]
  bundles: Record<string, RepoBundle>
  defaultRepoId: string
}
