import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 5173 is the spec tool's UI and 5174 its API — the implemented app gets its own port
// so both can run side by side while you check whether one matches the other.
export default defineConfig({
  plugins: [react()],
  server: { port: 5175 },
})
