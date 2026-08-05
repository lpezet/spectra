import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5174',
    },
  },
  // @tb/shared is TypeScript source in a workspace, not a built package — let Vite
  // transform it directly instead of trying to pre-bundle it.
  optimizeDeps: { exclude: ['@tb/shared'] },
})
