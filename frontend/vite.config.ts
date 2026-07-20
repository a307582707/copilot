import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Build bust: ensure every deploy produces a new hashed asset filename,
  // otherwise browsers may keep using immutable cached /assets/*.js.
  define: {
    __FRONTEND_BUILD_BUST__: JSON.stringify(process.env.FRONTEND_BUILD_BUST || ''),
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8030',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
