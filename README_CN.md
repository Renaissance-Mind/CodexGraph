# 🌐 CodexGraph

[English](./README.md)

> **本地优先、只读** 的 Codex 会话 × Git Worktree × 分支谱系可视化工具。

---

## ✨ 这是什么？

CodexGraph 扫描你本地 **真实的** `~/.codex/sessions/**/*.jsonl` 文件和 Git 仓库，渲染出一个交互式时间线，展示：

- 🔀 **Git 谱系** — 分支、fork、merge、worktree，以水平 DAG 的形式呈现
- 💬 **Codex 会话** — 每次对话挂在对应的 commit 上，显示标题、prompt、时长、模型、自动化状态
- 📌 **置顶会话** — 读取 Codex 自己的置顶列表，一键筛选只看你收藏的会话
- ⚡ **自动化** — 检测 Codex heartbeat 自动化，从 `automation.toml` 文件和会话内 `automation_update` 事件双重解析
- 🔄 **实时会话** — 在右侧面板中高亮显示 active / running / automated 的会话及其状态
- 🔍 **Commit 详情** — 点击任意 commit 查看修改文件列表，展开可看完整 unified diff（类似 GitHub）
- 🆚 **Commit 对比** — Cmd/Ctrl 点击两个 commit，查看完整的 `git diff --numstat`，支持逐文件展开差异
- 🕘 **最近优先项目列表** — 项目列表和默认选中项目按最新 Codex 会话活动排序
- 🗄️ **归档 session 日志** — 同时索引工具运行时写入仓库内的 `codex_session_log/sessions` 归档

**严格只读** 🔒 — CodexGraph 绝不会创建 worktree、切换分支、运行 Codex、merge、删除或写入任何 git/session 状态。

---

## 🚀 快速开始

```bash
git clone https://github.com/caopulan/CodexGraph.git
cd CodexGraph
npm install
npm run dev
# 打开 http://localhost:17001
```

> ⏳ 首次扫描会遍历完整的本地 session 归档。后续加载很快（30 分钟内存缓存 + 磁盘增量文件缓存）。

---

## 🖥️ 功能一览

| 功能 | 说明 |
|------|------|
| 🗂️ **多仓库** | 从 Codex 会话 `cwd` 和已知仓库内的 session 归档自动发现仓库 |
| 🌳 **Git DAG** | 水平主线 + fork/merge 曲线、commit 圆点、分支名标注 |
| 🃏 **会话卡片** | 在 lane 线上方：状态点 · 编号 · 分支标签 · commit hash · 日期 · 标题 · prompt 摘要 · 最后一条消息 |
| 📊 **Commit 卡片** | 在 lane 线下方：hash · 作者 · 日期 · commit message（冷灰底色，与会话卡区分） |
| 📌 **置顶筛选** | 一键切换只显示 Codex 中置顶的会话 |
| 👤 **作者筛选** | 按 git author 过滤 commit / 会话 |
| ⚙️ **设置** | 活跃阈值（1h–30d）、自动化指示开关、脉动动画开关 |
| 🔎 **缩放 + 拖拽** | Cmd/Ctrl + 滚轮缩放时间轴；拖拽平移；Fit 按钮重置到 100% |
| 📅 **日网格线** | 竖向虚线对齐顶部日期轴，间距自适应 |
| 🏷️ **会话重命名** | 读取 Codex App 的重命名（`session_index.jsonl`）+ CLI `thread_name_updated` 事件 |
| ⚡ **自动化检测** | 解析 `automations/*.toml` + 回放会话内 `automation_update` create/update/delete 事件 |
| 🟢 **状态颜色** | 未激活（灰）· 活跃（蓝）· 自动化（紫）· 运行中（绿色脉动） |
| 🗃️ **全量增量扫描** | 扫描每个全局/本地 session 文件和仓库内归档，并使用 mtime+size 缓存、git toplevel 缓存、大文件头尾采样（处理 1GB+ 会话文件不 OOM） |
| 🕘 **最近优先项目列表** | Repo selector 和初始默认项目按最新会话活动排序 |
| 🔍 **Commit Diff 查看器** | 点击 commit 查看修改文件 + 展开 unified diff |
| 🆚 **Commit 对比** | Cmd/Ctrl 点击两个 commit 查看 `git diff`，逐文件横向 bar 图 + 展开差异 |

---

## 📁 项目结构

```
├── server/
│   ├── scanner.ts          # 真实数据扫描器（会话 + git + 自动化 + 置顶）
│   ├── vite-plugin.ts      # /api/data, /api/diff, /api/commit-files, /api/file-diff
│   └── probe.ts            # 独立扫描器测试
├── src/
│   ├── main.tsx
│   ├── App.tsx              # 全局状态 + 设置
│   ├── data/types.ts        # 共享 TypeScript 类型
│   ├── styles/
│   │   ├── global.css       # 主题变量
│   │   └── app.css          # 应用 grid + 设置面板
│   └── components/
│       ├── TopBar.tsx/css    # 顶部栏：仓库选择、搜索、日期范围、只读标识
│       └── GraphCanvas.tsx/css  # 画布：SVG 图、会话/commit 卡片、实时面板、
│                                 # 详情卡、diff 查看器、图例
├── package.json
├── vite.config.ts
└── tsconfig.json
```

---

## 🔧 数据源

| 来源 | 提供的数据 |
|------|-----------|
| `~/.codex/sessions/**/*.jsonl` | 会话元数据、首条/末条用户消息、模型、CLI 版本、自动化事件 |
| `<repo>/**/codex_session_log/sessions/**/*.jsonl` | 仓库内归档的 Codex SDK/runtime session，并按 cwd 匹配回所属 worktree |
| `~/.codex/session_index.jsonl` | App 级会话重命名（thread_name） |
| `~/.codex/.codex-global-state.json` | 置顶会话 ID 列表 |
| `~/.codex/automations/*/automation.toml` | Heartbeat 自动化配置（目标 thread、状态、rrule） |
| `git worktree list --porcelain` | Worktree 路径、分支、detached 状态 |
| `git log --all` | Commit DAG（每个仓库上限 400） |
| `git status --porcelain` | 每个 worktree 的 dirty/clean 状态 |
| `git show --numstat` / `git diff --numstat` | 文件级修改详情（用于 commit 详情 / 对比） |

---

## ⚠️ 不做的事

本工具**不会**：

- ❌ 创建或切换 worktree / 分支
- ❌ 运行 Codex 或任何 agent
- ❌ Merge、删除或写入任何 git 状态
- ❌ 修改会话文件或 Codex 配置

---

## 📄 许可证

MIT

---

<p align="center">
  用 💙 构建 by <a href="https://github.com/caopulan">@caopulan</a> — 基于 Vite + React + TypeScript
</p>
