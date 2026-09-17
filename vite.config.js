import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// TypeSafe's API does not answer browser requests, so /api/typesafe/* is
// forwarded to it — here in development, by netlify.toml in production.
const typesafeProxy = {
  '/api/typesafe': {
    target: 'https://api.typesafe.ai',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api\/typesafe/, '/v1'),
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: typesafeProxy },
  preview: { proxy: typesafeProxy },
})
