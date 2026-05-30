# SessionTree

Local-first, **read-only** visualization of Codex sessions × git worktrees / branch lineage.

Scans `~/.codex/sessions/**/*.jsonl` and your real git repos, then renders each
repo as a horizontal main lane with feature branches forking off, Codex sessions
attached as chips on the commits where they happened.

## Run

```bash
npm install
npm run dev
# open http://localhost:5173
```

First scan takes ~30–60s depending on how many sessions / repos you have.
Results are cached for 5 minutes; subsequent loads are instant.

## What it shows
- Every repo found via your Codex session `cwd`s (sorted by session count)
- Every worktree from `git worktree list --porcelain`
- Real git DAG from `git log --all` (capped at 400 commits per repo)
- Real Codex sessions: first user prompt as title, model, duration, transcript preview
- Lineage: fork point + merged-into computed in-memory from the DAG
- Status: dirty / clean / detached derived from `git status --porcelain`

## What it does **not** do
SessionTree is strictly read-only. There are no buttons or shortcuts to
create / switch / merge / delete branches, run Codex, or write any state.
See `PLAN.md` and `PROGRESS.md` for the full implementation log.
