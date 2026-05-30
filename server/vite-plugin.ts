import type { Plugin } from 'vite'
import { scanAll } from './scanner'

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
    },
  }
}
