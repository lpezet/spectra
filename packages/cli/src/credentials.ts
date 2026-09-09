/**
 * Where `spectra login` stores the device token it fetches, and where `spectra attach` reads it back.
 *
 * Tokens are keyed by **coordinator origin** (the https/http base derived from the `--coordinator` ws
 * URL), so one machine can hold a token for a dev coordinator and a prod one at once and `attach`
 * picks the right one. The file lives beside the shared credential file under the config home and is
 * written `0600` — it holds live secrets.
 *
 * The transforms (`withCredential`/`withoutCredential`) are pure so they can be tested without a disk;
 * the read/write wrappers are the only impure part and take `configHome` rather than reading it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface Credential {
  token: string
  label: string
  coordinator: string
  createdAt: string
}

/** Every stored token, keyed by coordinator origin. */
export type Credentials = Record<string, Credential>

/** The credentials file path under the config home (`~/.config/spectra/credentials.json` by default). */
export function credentialsPath(configHome: string): string {
  return path.join(configHome, 'spectra', 'credentials.json')
}

/** A copy of `creds` with `origin` set — pure, so the merge is testable without touching disk. */
export function withCredential(creds: Credentials, origin: string, cred: Credential): Credentials {
  return { ...creds, [origin]: cred }
}

/** A copy of `creds` with `origin` removed, and whether it was present. Pure. */
export function withoutCredential(creds: Credentials, origin: string): { creds: Credentials; existed: boolean } {
  if (!(origin in creds)) return { creds, existed: false }
  const next = { ...creds }
  delete next[origin]
  return { creds: next, existed: true }
}

/** Read the credentials file, or an empty set if it is absent or unreadable. */
export function readCredentials(configHome: string): Credentials {
  try {
    return JSON.parse(readFileSync(credentialsPath(configHome), 'utf8')) as Credentials
  } catch {
    return {}
  }
}

/** Write the credentials file, creating the directory and keeping it `0600` (it holds secrets). */
export function writeCredentials(configHome: string, creds: Credentials): void {
  const file = credentialsPath(configHome)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 })
}

/** Store one coordinator's token. */
export function storeCredential(configHome: string, origin: string, cred: Credential): void {
  writeCredentials(configHome, withCredential(readCredentials(configHome), origin, cred))
}

/** Remove one coordinator's token; returns whether there was one. */
export function removeCredential(configHome: string, origin: string): boolean {
  const { creds, existed } = withoutCredential(readCredentials(configHome), origin)
  if (existed) writeCredentials(configHome, creds)
  return existed
}

/** The stored token for a coordinator origin, or undefined. Used by `attach` as a `--token` fallback. */
export function tokenFor(configHome: string, origin: string): string | undefined {
  return readCredentials(configHome)[origin]?.token
}

/** Whether a credentials file exists at all — for friendlier "run spectra login first" messaging. */
export function hasCredentialsFile(configHome: string): boolean {
  return existsSync(credentialsPath(configHome))
}
