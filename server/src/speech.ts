/**
 * Reading the agents out loud in a voice the operating system does not have.
 *
 * Everything else about speech is browser-local — `web/src/speech.ts` says so in its own
 * header, and that property is why it could be added without thinking about the server, the
 * sandbox or the credential. This module is the deliberate exception, and it is worth being
 * clear about what it costs: agent text leaves this machine for a second vendor. That is a
 * choice, made once, at the top of the file where it can be found.
 *
 * The key lives here for the same reason the Anthropic one does — a key in the browser is a
 * key you have published — so the browser posts text and gets audio back, and never learns
 * the credential. `coder` is deliberately not given this variable: that container has no
 * route out and nothing here is a reason to give it one.
 *
 * What this module will *not* do is decide whether the caller should fall back. It reports
 * what happened — the upstream status, and which of the few failure shapes it was — and the
 * browser decides. Running out of credit and being rate-limited are the same HTTP failure to
 * a naive caller and completely different events to a listener: one means "never mind, use
 * the local voice from now on", the other means "just this once".
 */
const API = 'https://api.elevenlabs.io/v1'

/**
 * Latency is the whole argument for this default.
 *
 * The browser voice starts talking the instant it is asked. Anything remote is a round trip
 * plus generation before the first sound, so a slower, marginally better model is the wrong
 * trade for one spoken sentence at the end of a run. Overridable for anyone who disagrees.
 */
// Empty, not absent, is what an unset variable looks like coming through docker compose —
// `FOO=${FOO:-}` always defines it. `??` would happily pass that empty string upstream.
const MODEL = process.env.ELEVENLABS_MODEL?.trim() || 'eleven_turbo_v2_5'

/** Every distinct thing that can go wrong, named so the browser can tell them apart. */
export type SpeechFailure =
  | 'no-credential'
  | 'quota'
  | 'rate-limit'
  | 'rejected'
  | 'unreachable'

export interface SpeechError {
  reason: SpeechFailure
  /** Upstream HTTP status, or null when the call never got that far. */
  status: number | null
  detail: string
}

export function speechKey(): string | null {
  const key = process.env.ELEVENLABS_API_KEY?.trim()
  return key ? key : null
}

/**
 * Which voice each agent starts with, named where the key already lives.
 *
 * The picker in the browser still decides, and what it decides is remembered — but a first
 * visit should not have to. Naming the two voices next to the credential that pays for them
 * keeps "how is this set up" in one file, and means a second browser, or a cleared
 * localStorage, sounds the same as the first without anybody re-choosing.
 *
 * Absent is a perfectly good answer, and the common one: the browser then starts on a system
 * voice and nothing is sent anywhere until somebody picks otherwise.
 */
export function defaultVoiceIds(): Record<string, string | null> {
  const read = (name: string) => {
    const value = process.env[name]?.trim()
    return value ? value : null
  }
  return {
    spec: read('ELEVENLABS_SPEC_VOICE_ID'),
    coder: read('ELEVENLABS_CODER_VOICE_ID'),
  }
}

/**
 * Reads the failure shape out of a response the upstream already decided.
 *
 * ElevenLabs answers a spent quota with 401 and a body naming it, which is the same status it
 * uses for a bad key. Telling them apart matters: a bad key is worth reporting to whoever set
 * it up, an exhausted quota is worth going quiet about and using the local voice.
 */
function classify(status: number, body: string): SpeechError {
  const named = /"status"\s*:\s*"([a-z_]+)"/.exec(body)?.[1] ?? ''
  if (status === 429 || named === 'too_many_concurrent_requests') {
    return { reason: 'rate-limit', status, detail: named || 'rate limited' }
  }
  // 402 is the plan saying no: out of credit, or a voice this tier does not include. Grouped
  // with quota because the listener's situation is identical — it will not start working on
  // its own, so stop asking and use the local voice.
  if (status === 402 || named.includes('quota') || named === 'detected_unusual_activity') {
    return { reason: 'quota', status, detail: named || 'payment_required' }
  }
  return { reason: 'rejected', status, detail: named || body.slice(0, 200) }
}

export interface RemoteVoice {
  id: string
  name: string
  /** Whatever the vendor labels it with — accent, age, use case. Shown, never parsed. */
  description: string
}

export async function listVoices(): Promise<{ voices: RemoteVoice[] } | { error: SpeechError }> {
  const key = speechKey()
  if (!key) {
    return { error: { reason: 'no-credential', status: null, detail: 'ELEVENLABS_API_KEY is not set.' } }
  }

  try {
    const response = await fetch(`${API}/voices`, { headers: { 'xi-api-key': key } })
    if (!response.ok) return { error: classify(response.status, await response.text()) }

    const body = (await response.json()) as {
      voices?: Array<{ voice_id?: string; name?: string; labels?: Record<string, string>; category?: string }>
    }
    return {
      voices: (body.voices ?? [])
        .filter((voice) => voice.voice_id && voice.name)
        .map((voice) => ({
          id: voice.voice_id!,
          name: voice.name!,
          description: [voice.category, ...Object.values(voice.labels ?? {})]
            .filter(Boolean)
            .join(' · '),
        })),
    }
  } catch (cause) {
    return { error: { reason: 'unreachable', status: null, detail: (cause as Error).message } }
  }
}

/** The audio for one utterance, or why there is none. */
export async function synthesize(
  text: string,
  voiceId: string,
): Promise<{ audio: Buffer; type: string } | { error: SpeechError }> {
  const key = speechKey()
  if (!key) {
    return { error: { reason: 'no-credential', status: null, detail: 'ELEVENLABS_API_KEY is not set.' } }
  }

  try {
    const response = await fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: MODEL }),
    })
    if (!response.ok) return { error: classify(response.status, await response.text()) }

    return {
      audio: Buffer.from(await response.arrayBuffer()),
      type: response.headers.get('content-type') ?? 'audio/mpeg',
    }
  } catch (cause) {
    return { error: { reason: 'unreachable', status: null, detail: (cause as Error).message } }
  }
}

export { MODEL as speechModel }
