/**
 * The loopback code-catcher — the one bit of the login flow that isn't pure parsing or plain fs. It
 * must resolve with the `code` the coordinator redirects to `/cb`, and ignore anything else.
 */
import { describe, expect, it } from 'vitest'
import { awaitCode } from './login.js'

describe('awaitCode (loopback server)', () => {
  it('resolves with the code delivered to /cb and serves a close-the-tab page', async () => {
    const { port, code } = await awaitCode()
    const res = await fetch(`http://127.0.0.1:${port}/cb?code=abc123`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Authorized')
    expect(await code).toBe('abc123')
  })

  it('times out when no code arrives', async () => {
    const { code } = await awaitCode(50)
    await expect(code).rejects.toThrow(/Timed out/)
  })
})
