# 🌐 CodexGraph

> **Local-first, read-only visualization** of your Codex sessions × git worktrees × branch lineage.

<p align="center">
  <img src="./sessiontree-light-ui.png" alt="CodexGraph screenshot" width="900" />
</p>

---

## ✨ What is this?

CodexGraph scans your **real** `~/.codex/sessions/**/*.jsonl` files and your local git repos, then renders an interactive timeline showing:

- 🔀 **Git lineage** — branches, forks, merges, worktrees as a horizontal DAG
- 💬 **Codex sessions** — each conversation pinned to its commit, with title, prompt, duration, model, automation status
- 📌 **Pinned sessions** — reads Codex's own pin list and lets you filter to just your starred conversations
- ⚡ **Automations** — detects Codex heartbeat automations from both `automation.toml` files and in-session `automation_update` events
- 🔄 **Live sessions** — active / running / automated sessions highlighted in a side panel with real-time status
- 🔍 **Commit details** — click any commit to see changed files; expand to view unified diffs inline (like GitHub)
- 🆚 **Commit compare** — Cmd/Ctrl-click two commits to see a full `git diff --numstat` with expandable per-file diffs

**Strictly read-only** 🔒 — CodexGraph never creates worktrees, switches branches, runs Codex, merges, deletes, or writes any git/session state.

---

## 🚀 Quick Start

```bash
cd ~/workspace/SessionTree   # (or wherever you cloned this)
npm install
npm run dev
# open http://localhost:17001
```

> ⏳ First scan takes ~14s (335+ sessions, 19 repos). Subsequent loads are instant (30-min memory cache + disk-persisted incremental file cache).

---

## 🖥️ Features at a Glance

| Feature | Description |
|---------|-------------|
| 🗂️ **Multi-repo** | Auto-discovers all repos from your Codex session `cwd`s |
| 🌳 **Git DAG** | Horizontal main branch + fork/merge curves, commit dots, HEAD labels |
| 🃏 **Session cards** | Multi-line cards above the lane: status dot · label · branch pill · hash · date · title · prompt snippet · last user message |
| 📊 **Commit cards** | Below the lane: hash · author · date · commit message (cool-grey background to distinguish from session cards) |
| 📌 **Pinned filter** | Toggle to show only Codex-pinned sessions |
| 👤 **Author filter** | Filter commits/sessions by git author |
| ⚙️ **Settings** | Activity threshold (1h–30d), automation indicators, pulse animation |
| 🔎 **Zoom + Pan** | Cmd/Ctrl+scroll to zoom time axis; drag to pan; Fit button resets to 100% |
| 📅 **Day gridlines** | Vertical dashed lines aligned with the top date axis, adaptive spacing |
| 🏷️ **Session rename** | Reads Codex app renames (`session_index.jsonl`) + CLI `thread_name_updated` events |
| ⚡ **Automation detection** | Parses `automations/*.toml` + replays in-session `automation_update` create/update/delete events |
| 🟢 **Status colors** | inactive (grey) · active (blue) · automated (purple) · running (green pulse) |
| 🗃️ **Incremental scan** | Per-file mtime+size cache, git toplevel cache, large-file head+tail sampling (handles 1GB+ session files without OOM) |

---

## 📁 Project Structure

```
├── server/
│   ├── scanner.ts          # Real data scanner (sessions + git + automations + pins)
│   ├── vite-plugin.ts      # /api/data, /api/diff, /api/commit-files, /api/file-diff
│   └── probe.ts            # Standalone scanner test
├── src/
│   ├── main.tsx
│   ├── App.tsx              # Global state + settings
│   ├── data/types.ts        # Shared TypeScript types
│   ├── styles/
│   │   ├── global.css       # Theme variables
│   │   └── app.css          # App grid + settings popover
│   └── components/
│       ├── TopBar.tsx/css    # Header: repo selector, search, date range, read-only badge
│       └── GraphCanvas.tsx/css  # The entire canvas: SVG graph, session/commit cards,
│                                 # live panel, pinned card, diff viewer, legend
├── PLAN.md                  # Implementation plan
├── PROGRESS.md              # Detailed changelog (v1–v12+)
├── package.json
├── vite.config.ts
└── tsconfig.json
```

---

## 🔧 Data Sources

| Source | What it provides |
|--------|-----------------|
| `~/.codex/sessions/**/*.jsonl` | Session metadata, first/last user message, model, CLI version, automation events |
| `~/.codex/session_index.jsonl` | App-level session renames (thread_name) |
| `~/.codex/.codex-global-state.json` | Pinned thread IDs |
| `~/.codex/automations/*/automation.toml` | Heartbeat automation configs (target thread, status, rrule) |
| `git worktree list --porcelain` | Worktree paths, branches, detached state |
| `git log --all` | Commit DAG (capped at 400 per repo) |
| `git status --porcelain` | Dirty/clean state per worktree |
| `git show --numstat` / `git diff --numstat` | File-level changes for commit detail / compare |

---

## ⚠️ Non-Goals

This tool intentionally does **not**:

- ❌ Create or switch worktrees/branches
- ❌ Run Codex or any agent
- ❌ Merge, delete, or write any git state
- ❌ Modify session files or Codex config

---

## 📄 License

MIT

---

<p align="center">
  Built with 💙 by <a href="https://github.com/caopulan">@caopulan</a> — powered by Vite + React + TypeScript
</p>
