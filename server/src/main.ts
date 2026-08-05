/**
 * Entry point. Exists only so `.env` is loaded before `index.ts` — and everything it
 * imports — reads `process.env` at module scope.
 */
import { loadDotEnv } from './env.js'

const envFile = loadDotEnv()
console.log(envFile ? `[server] env: ${envFile}` : '[server] env: no .env file — using the process environment')

await import('./index.js')
