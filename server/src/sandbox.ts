/**
 * Whether the @coder sandbox is up, and what it says about itself.
 *
 * The container is on an internal network, so it is unreachable from the host by design —
 * a published port does not help, docker does not route them on an internal network. Only
 * something on that network can see it, and express is now the only such thing. That makes
 * "is the sandbox there?" a question nothing but express can answer, which is why this
 * lives here rather than in the UI.
 *
 * Nothing routes @coder's turns here yet; that is the next step. This is the link itself,
 * reported honestly so the difference between "not configured", "configured but down" and
 * "up" is visible rather than inferred from a failure later.
 */
const PROBE_TIMEOUT_MS = 3_000

/** Unset when express is running on the host, where there is no sandbox to reach. */
export const CODER_URL = process.env.CODER_URL?.trim() || null

export interface SandboxStatus {
  /** False when CODER_URL is unset — @coder runs in-process, unsandboxed. */
  configured: boolean
  url: string | null
  reachable: boolean
  /** Whatever /health returned, verbatim, when we got one. */
  health: unknown
  error: string | null
}

export async function probeSandbox(): Promise<SandboxStatus> {
  if (!CODER_URL) {
    return { configured: false, url: null, reachable: false, health: null, error: null }
  }

  try {
    const response = await fetch(`${CODER_URL}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) {
      return {
        configured: true,
        url: CODER_URL,
        reachable: false,
        health: null,
        error: `The sandbox answered ${response.status}.`,
      }
    }
    return {
      configured: true,
      url: CODER_URL,
      reachable: true,
      health: await response.json(),
      error: null,
    }
  } catch (cause) {
    // Down, still booting, or not on this network. All three look the same from here and
    // all three mean the same thing to the caller, so do not pretend to tell them apart.
    return {
      configured: true,
      url: CODER_URL,
      reachable: false,
      health: null,
      error: (cause as Error).message,
    }
  }
}
