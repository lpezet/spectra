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

/**
 * Where each agent's runtime lives, when it runs out-of-process. Unset means "run in-process":
 * express runs that agent itself. @coder has always had CODER_URL; @spec now has the symmetric
 * SPEC_URL, so it too can be pulled out into its own runtime (the runner relays to whichever is set).
 */
export const CODER_URL = process.env.CODER_URL?.trim() || null
export const SPEC_URL = process.env.SPEC_URL?.trim() || null

export interface Reachability {
  reachable: boolean
  /** Whatever /health returned, verbatim, when we got one. */
  health: unknown
  error: string | null
}

/** Ping a runtime's /health — the shared check behind both probeSandbox and the runner's relay. */
export async function probe(url: string): Promise<Reachability> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!response.ok) return { reachable: false, health: null, error: `answered ${response.status}` }
    return { reachable: true, health: await response.json(), error: null }
  } catch (cause) {
    // Down, still booting, or not on this network. All three look the same from here and all three
    // mean the same thing to the caller, so do not pretend to tell them apart.
    return { reachable: false, health: null, error: (cause as Error).message }
  }
}

export interface SandboxStatus extends Reachability {
  /** False when CODER_URL is unset — @coder runs in-process, unsandboxed. */
  configured: boolean
  url: string | null
}

export async function probeSandbox(): Promise<SandboxStatus> {
  if (!CODER_URL) {
    return { configured: false, url: null, reachable: false, health: null, error: null }
  }
  return { configured: true, url: CODER_URL, ...(await probe(CODER_URL)) }
}
