/**
 * Credential storage: the pure merge/remove transforms, and the on-disk round-trip under a temp
 * config home (created and cleaned per test, so nothing touches the real ~/.config).
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  credentialsPath,
  readCredentials,
  removeCredential,
  storeCredential,
  tokenFor,
  withCredential,
  withoutCredential,
} from './credentials.js'

const cred = (token: string) => ({ token, label: 'laptop', coordinator: 'wss://h/r', createdAt: '2026-01-01T00:00:00Z' })
const DEV = 'https://dev.example.com'
const PROD = 'https://prod.example.com'

describe('pure transforms', () => {
  it('withCredential adds/overwrites by origin without mutating the input', () => {
    const a = {}
    const b = withCredential(a, DEV, cred('t1'))
    expect(a).toEqual({})
    expect(b[DEV]?.token).toBe('t1')
    expect(withCredential(b, DEV, cred('t2'))[DEV]?.token).toBe('t2')
  })

  it('withoutCredential removes and reports presence', () => {
    const start = withCredential({}, DEV, cred('t1'))
    expect(withoutCredential(start, PROD)).toEqual({ creds: start, existed: false })
    const { creds, existed } = withoutCredential(start, DEV)
    expect(existed).toBe(true)
    expect(creds).toEqual({})
  })
})

describe('on-disk round-trip', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'spectra-cred-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('missing file reads as empty', () => {
    expect(readCredentials(home)).toEqual({})
    expect(tokenFor(home, DEV)).toBeUndefined()
  })

  it('store then read a token, keyed by coordinator origin', () => {
    storeCredential(home, DEV, cred('dev-token'))
    storeCredential(home, PROD, cred('prod-token'))
    expect(tokenFor(home, DEV)).toBe('dev-token')
    expect(tokenFor(home, PROD)).toBe('prod-token')
    // Two coordinators coexist.
    expect(Object.keys(readCredentials(home)).sort()).toEqual([DEV, PROD])
  })

  it('writes the file 0600 (it holds secrets)', () => {
    storeCredential(home, DEV, cred('x'))
    const mode = statSync(credentialsPath(home)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('remove returns whether there was one, and clears it', () => {
    storeCredential(home, DEV, cred('x'))
    expect(removeCredential(home, DEV)).toBe(true)
    expect(tokenFor(home, DEV)).toBeUndefined()
    expect(removeCredential(home, DEV)).toBe(false)
  })
})
