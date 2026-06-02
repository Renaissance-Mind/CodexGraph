import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sessionTreeApi } from './server/vite-plugin'

export default defineConfig({
  plugins: [react(), sessionTreeApi()],
  server: {
    port: 17001,
    host: true,
    strictPort: true,
  },
})
