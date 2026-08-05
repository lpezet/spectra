/**
 * Loads a `.env` before anything else runs.
 *
 * This has to happen before the first import that reads `process.env` at module scope —
 * `SPECS_DIR` and the transcript database path both do — which is why the server boots
 * through `main.ts` rather than `index.ts` directly.
 *
 * Uses Node's own `process.loadEnvFile`, so there is no dotenv dependency.
 */
import path from 'node:path'

/** Returns the file it loaded, or null if there was none to load. */
export function loadDotEnv(): string | null {
  const candidates = [
    process.env.ENV_FILE,
    path.resolve(process.cwd(), '.env'),
    // Run via `npm run dev -w server`, cwd is server/, so the repo root is two up from src/.
    path.resolve(import.meta.dirname, '../../.env'),
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const file of candidates) {
    try {
      process.loadEnvFile(file)
      return file
    } catch {
      // Missing or unreadable — try the next candidate. A missing .env is normal.
    }
  }

  return null
}
