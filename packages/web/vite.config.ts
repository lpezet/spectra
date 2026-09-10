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
  // @abseed/spectra-core and @abseed/spectra-web-lib are TypeScript/TSX source in workspaces, not built
  // packages — let Vite transform them directly instead of trying to pre-bundle them.
  optimizeDeps: { exclude: ['@abseed/spectra-core', '@abseed/spectra-web-lib'] },
})
