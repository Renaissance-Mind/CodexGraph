import type { Plugin } from 'vite'
import { scanAll, gitDiffBetween, gitCommitFiles, gitFileDiff } from './scanner'

export function sessionTreeApi(): Plugin {
  return {
    name: 'sessiontree-api',
    configureServer(server) {
      server.middlewares.use('/api/data', (req, res) => {
        try {
          const force = req.url?.includes('force=1') || false
          const t0 = Date.now()
          const payload = scanAll(force)
          const ms = Date.now() - t0
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('X-Scan-Ms', String(ms))
          res.statusCode = 200
          res.end(JSON.stringify(payload))
        } catch (err) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: (err as Error).message, stack: (err as Error).stack }))
        }
      })

      // git diff stat between two commits in a repo
      server.middlewares.use('/api/diff', (req, res) => {
        try {
          const url = new URL(req.url || '', 'http://x')
          const repoId = url.searchParams.get('repo') || ''
          const a = url.searchParams.get('a') || ''
          const b = url.searchParams.get('b') || ''
          if (!repoId || !a || !b) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'repo, a, b required' }))
            return
          }
          const diff = gitDiffBetween(repoId, a, b)
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.statusCode = 200
          res.end(JSON.stringify(diff))
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: (err as Error).message }))
        }
      })

      // files touched by one commit
      server.middlewares.use('/api/commit-files', (req, res) => {
        try {
          const url = new URL(req.url || '', 'http://x')
          const repoId = url.searchParams.get('repo') || ''
          const commit = url.searchParams.get('commit') || ''
          if (!repoId || !commit) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'repo, commit required' }))
            return
          }
          const files = gitCommitFiles(repoId, commit)
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.statusCode = 200
          res.end(JSON.stringify(files))
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: (err as Error).message }))
        }
      })

      // unified diff of one file: either a single commit (b omitted) or a..b
      server.middlewares.use('/api/file-diff', (req, res) => {
        try {
          const url = new URL(req.url || '', 'http://x')
          const repoId = url.searchParams.get('repo') || ''
          const a = url.searchParams.get('a') || ''
          const b = url.searchParams.get('b') || ''
          const file = url.searchParams.get('file') || ''
          if (!repoId || !a || !file) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'repo, a, file required' }))
            return
          }
          const diff = gitFileDiff(repoId, a, b || null, file)
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.statusCode = 200
          res.end(JSON.stringify(diff))
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: (err as Error).message }))
        }
      })
    },
  }
}
