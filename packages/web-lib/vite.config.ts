import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// A library build, not an app: ESM only, react/react-dom/jsx-runtime and core left external (the
// consumer brings its own single copy of each — react as a peer, core as a dependency it resolves).
// The CSS the components reference is emitted as one styles.css the consumer imports once. tsc emits
// the .d.ts alongside (see the build script); vite bundles JS + CSS, tsc handles types.
const dir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(dir, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index',
      cssFileName: 'styles',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime', '@abseed/spectra-core'],
    },
  },
  // @abseed/spectra-core is TypeScript source in a workspace, not a built package — do not pre-bundle.
  optimizeDeps: { exclude: ['@abseed/spectra-core'] },
})
