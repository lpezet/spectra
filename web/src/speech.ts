/**
 * Reading the agents out loud, and typing by talking.
 *
 * In the browser by default, and that default is load-bearing: the local voice needs no
 * server, no credential and no network, so it is what speaks when anything else fails.
 *
 * Two things do leave, and both should be chosen rather than discovered, because this project
 * is careful about egress everywhere else. Dictation in Chrome sends your audio to Google —
 * your microphone and your browser, not something this tool controls. And picking a remote
 * voice sends the sentence being spoken to ElevenLabs, by way of the server, which holds the
 * key so the browser never learns it. Pick no remote voice and neither happens.
 *
 * What gets spoken is deliberately narrow. Not every message — the *last* thing an agent said
 * in a run, which is the same unit the fold already treats as the conclusion. Silence while it
 * works, a sentence when it finishes. Errors are the exception and are spoken whenever they
 * arrive, because with @coder running unattended a failed run is the one thing you need to
 * know about while you are not looking at the screen.
 */
import { parseBlocks } from './markdown.js'
import type { Block, Token } from './markdown.js'

/**
 * Prose to say, with everything unsayable removed.
 *
 * Dropping code is the single biggest difference between this being useful and being
 * unbearable. `app/src/domain/completeTask.ts` read character by character is thirty seconds
 * of nothing, and @coder's messages are full of paths, tool names and identifiers. Headings,
 * emphasis and list markers go too — they are layout, and layout has no sound.
 *
 * Reuses the parser the rendering already uses, rather than a second one that would drift
 * from it. A `@mention` is spoken as the bare name: "at spec" is how you would say it.
 */
function speakTokens(tokens: Token[]): string {
  return tokens
    .map((token) => {
      switch (token.kind) {
        case 'text':
          return token.text
        // Inline code is almost always an identifier or a path. Saying "code" in its place
        // would be worse than the gap it leaves.
        case 'code':
          return ' '
        case 'mention':
          return token.name
        case 'strong':
        case 'em':
          return speakTokens(token.children)
      }
    })
    .join('')
}

export function speakableText(markdown: string): string {
  const spoken = parseBlocks(markdown)
    .map((block: Block) => {
      switch (block.kind) {
        case 'heading':
        case 'paragraph':
          return speakTokens(block.tokens)
        // A list reads as sentences; the bullets themselves are punctuation for the eye.
        case 'list':
          return block.items.map((item) => speakTokens(item)).join('. ')
        // Never spoken, and not summarised either — "a code block" is noise, not information.
        case 'code':
          return ''
      }
    })
    .filter((part) => part.trim() !== '')
    .join('. ')

  return spoken.replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').replace(/\.{2,}/g, '.').trim()
}

/**
 * The conclusion, which both agents are now told to put first.
 *
 * The prompt does the real work here: "the first sentence of your final message must be a
 * single plain sentence saying what happened". This reads that sentence and stops, which is
 * why the whole thing costs no summariser and no second model call — the agent was going to
 * write a conclusion anyway, it just used to be buried.
 *
 * Two allowances for the times it is not followed. A very short opener ("Done.") is joined to
 * the one after it, because a two-word utterance tells you less than the silence it replaced.
 * And a passage with no sentence break at all is truncated rather than read whole, since the
 * alternative is a paragraph nobody asked to hear.
 */
/**
 * Shorter than the shortest reply that stands on its own.
 *
 * "Raised q-009." is thirteen characters and says everything it needs to; "Done." is five and
 * says nothing the silence did not. The line goes between them, and it goes there rather than
 * anywhere higher because a real conclusion is often short — "The tests pass and q-009 is
 * still open." is thirty-nine, and a generous threshold swallowed the sentence after it.
 */
const ENOUGH = 12

export function leadSentence(text: string, max = 240): string {
  const trimmed = text.trim()
  if (trimmed === '') return ''

  // Split after . ? or ! when followed by a space and a capital or a digit — enough to keep
  // "e.g." and "q-009." from ending a sentence that has not ended.
  const parts = trimmed.split(/(?<=[.?!])\s+(?=[A-Z0-9@#"'(])/)

  let spoken = ''
  for (const part of parts) {
    if (spoken !== '' && spoken.length >= ENOUGH) break
    spoken = spoken === '' ? part : `${spoken} ${part}`
  }

  if (spoken.length <= max) return spoken

  const cut = spoken.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  return stop > 60 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`
}

export interface VoiceChoice {
  /** `SpeechSynthesisVoice.voiceURI`, or null to use whatever the browser defaults to. */
  uri: string | null
  pitch: number
  rate: number
  /**
   * An ElevenLabs voice id, or null for the browser's own synthesiser.
   *
   * Kept alongside `uri` rather than replacing it, because the browser voice is not a lesser
   * option to be forgotten once a remote one is picked — it is what speaks when the network is
   * slow, the quota is spent, or the key was never set. Both are always chosen.
   */
  remoteId?: string | null
}

/**
 * Told apart even when the machine has one voice.
 *
 * Voice availability is entirely the operating system's business — a Windows browser has
 * plenty, a bare Linux one may have none — so distinct voices cannot be assumed. Pitch and
 * rate are always available, so the two agents stay distinguishable by manner even when they
 * have to share a voice. That is the fallback, not the design; a real second voice is picked
 * whenever there is one.
 */
export const DEFAULT_VOICES: Record<string, VoiceChoice> = {
  spec: { uri: null, pitch: 1.05, rate: 1.0 },
  coder: { uri: null, pitch: 0.9, rate: 1.05 },
}

/** English voices first, then everything else — the glossary and its agents are in English. */
export function rankVoices(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  return [...voices].sort((left, right) => {
    const score = (voice: SpeechSynthesisVoice) =>
      (voice.lang.startsWith('en') ? 0 : 1) + (voice.localService ? 0 : 0.5)
    return score(left) - score(right) || left.name.localeCompare(right.name)
  })
}

/**
 * Two different voices from what the machine actually has.
 *
 * Returns nulls rather than repeating one voice when there is only one: the caller falls back
 * to pitch and rate, and a "choice" that picked the same voice twice would look like a bug.
 */
export function suggestVoices(voices: SpeechSynthesisVoice[]): { spec: string | null; coder: string | null } {
  const ranked = rankVoices(voices)
  return {
    spec: ranked[0]?.voiceURI ?? null,
    coder: ranked.length > 1 ? (ranked[1]?.voiceURI ?? null) : null,
  }
}

export interface SpeakOptions extends VoiceChoice {
  voices: SpeechSynthesisVoice[]
  /** Told when a remote voice could not speak and the local one took over, and why. */
  onFallback?: (error: RemoteError) => void
}

export function speechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/* ----------------------------------------------------------------------------------------
   The remote voice
   ---------------------------------------------------------------------------------------- */

export type SpeechFailure = 'no-credential' | 'quota' | 'rate-limit' | 'rejected' | 'unreachable'

export interface RemoteError {
  reason: SpeechFailure
  status: number | null
  detail: string
}

export interface RemoteVoice {
  id: string
  name: string
  /** The vendor's word for where the voice came from — what a plan grants access by. */
  category: string
  description: string
}

/**
 * Sorted into the vendor's own categories, `premade` first.
 *
 * Which categories a plan actually includes is between the listener and their vendor, and
 * this deliberately does not try to know: a voice that is refused says so at the moment it is
 * refused, which is the only account of it that cannot go out of date. What grouping buys is
 * narrower and worth having anyway — the refusals arrive in blocks, so one 402 tells you
 * something about the twenty voices next to it instead of only about itself.
 *
 * `premade` leads because it is the set every plan has had, which makes it the useful thing
 * to try first rather than the fortieth thing to try.
 */
export function voicesByCategory(voices: RemoteVoice[]): Array<{ category: string; voices: RemoteVoice[] }> {
  const groups = new Map<string, RemoteVoice[]>()
  for (const voice of voices) {
    const key = voice.category || 'other'
    groups.set(key, [...(groups.get(key) ?? []), voice])
  }

  return [...groups.entries()]
    .sort(([left], [right]) => {
      if (left === right) return 0
      if (left === 'premade') return -1
      if (right === 'premade') return 1
      return left.localeCompare(right)
    })
    .map(([category, found]) => ({ category, voices: found }))
}

/**
 * Whether a failure is the kind worth giving up on.
 *
 * A spent quota, a missing key and a rejected request will all still be true in thirty
 * seconds, so continuing to ask costs a round trip of silence before every sentence for the
 * rest of the session. A rate limit and an unreachable host might not be, so those are
 * forgiven — but only so many times, because a host that is down stays down and the delay is
 * paid on every utterance until something stops asking.
 */
export function disarmsImmediately(reason: SpeechFailure): boolean {
  return reason === 'quota' || reason === 'no-credential' || reason === 'rejected'
}

/** How many forgivable failures in a row before the remote voice is dropped anyway. */
export const FORGIVEN = 3

let armed = true
let stumbles = 0
let lastError: RemoteError | null = null

export function remoteVoiceState(): { armed: boolean; error: RemoteError | null } {
  return { armed, error: lastError }
}

/** Called when the listener changes something, since a new choice deserves a fresh try. */
export function rearmRemoteVoice(): void {
  armed = true
  stumbles = 0
  lastError = null
}

function noteFailure(error: RemoteError): void {
  lastError = error
  if (disarmsImmediately(error.reason)) {
    armed = false
    return
  }
  stumbles += 1
  if (stumbles >= FORGIVEN) armed = false
}

export interface RemoteVoices {
  configured: boolean
  voices: RemoteVoice[]
  /** Which voice each agent should start on, named server-side next to the key. */
  defaults: Record<string, string | null>
}

export async function fetchRemoteVoices(): Promise<RemoteVoices> {
  try {
    const response = await fetch('/api/speech')
    if (!response.ok) return { configured: false, voices: [], defaults: {} }
    const body = (await response.json()) as Partial<RemoteVoices>
    return {
      configured: body.configured === true,
      voices: body.voices ?? [],
      defaults: body.defaults ?? {},
    }
  } catch {
    return { configured: false, voices: [], defaults: {} }
  }
}

/**
 * Applies the server's defaults without overruling a choice already made.
 *
 * The distinction that makes this safe is `undefined` versus `null`: never having decided is
 * not the same as having chosen the browser voice. Picking a system voice writes an explicit
 * null, so a listener who deliberately went local does not find themselves back on a paid
 * voice the next time the page loads.
 */
export function withDefaultVoices(
  choices: Record<string, VoiceChoice>,
  defaults: Record<string, string | null>,
): Record<string, VoiceChoice> {
  let changed = false
  const next: Record<string, VoiceChoice> = { ...choices }

  for (const [agent, id] of Object.entries(defaults)) {
    if (!id || !next[agent] || next[agent]!.remoteId !== undefined) continue
    next[agent] = { ...next[agent]!, remoteId: id }
    changed = true
  }

  return changed ? next : choices
}

/* ----------------------------------------------------------------------------------------
   Saying it
   ---------------------------------------------------------------------------------------- */

/**
 * Rises every time speaking is superseded, so a slow remote answer can tell that the sentence
 * it was fetching is no longer the one anybody is waiting for. Without it, a two-second
 * synthesis that lands after the next run finished would talk over the newer conclusion —
 * the exact history-while-the-present-scrolls-past problem `stopSpeaking` exists to prevent.
 */
let generation = 0
let playing: HTMLAudioElement | null = null

function speakLocally(text: string, options: SpeakOptions): void {
  if (!speechAvailable()) return
  const utterance = new SpeechSynthesisUtterance(text)
  const voice = options.uri ? options.voices.find((candidate) => candidate.voiceURI === options.uri) : undefined
  if (voice) utterance.voice = voice
  utterance.pitch = options.pitch
  utterance.rate = options.rate
  window.speechSynthesis.speak(utterance)
}

async function speakRemotely(text: string, options: SpeakOptions, mine: number): Promise<void> {
  const response = await fetch('/api/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voiceId: options.remoteId }),
  })

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as RemoteError | null
    throw error ?? { reason: 'unreachable' as const, status: response.status, detail: response.statusText }
  }

  const blob = await response.blob()
  // Superseded while the audio was being made. Say nothing at all rather than say the old one.
  if (mine !== generation) return

  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  // Pitch has no meaning for recorded audio, and the voices are distinct enough not to need
  // it; rate still does, so the one setting that survives the crossing is kept.
  audio.playbackRate = options.rate
  audio.onended = () => {
    URL.revokeObjectURL(url)
    if (playing === audio) playing = null
  }
  playing = audio
  await audio.play()
  stumbles = 0
}

/**
 * Says one thing, cancelling whatever was being said.
 *
 * Cancelling rather than queueing is the right default here: if a newer conclusion has
 * arrived, the older one has stopped being what you wanted to hear, and a queue would leave
 * you listening to history while the present scrolls past.
 *
 * Stays synchronous for callers even though a remote voice is not, because the caller is an
 * effect that fires when a run ends and has nothing to do with the result. Every path that
 * fails ends up at the local voice, so the sentence is spoken either way.
 */
export function speak(text: string, options: SpeakOptions): void {
  if (text.trim() === '') return

  stopSpeaking()
  const mine = generation

  if (!options.remoteId || !armed) {
    speakLocally(text, options)
    return
  }

  void speakRemotely(text, options, mine).catch((cause: unknown) => {
    const error: RemoteError =
      cause && typeof cause === 'object' && 'reason' in cause
        ? (cause as RemoteError)
        : { reason: 'unreachable', status: null, detail: (cause as Error)?.message ?? 'failed' }

    noteFailure(error)
    options.onFallback?.(error)
    // Only if nothing newer has started talking in the meantime — a fallback for a sentence
    // that has already been superseded is just the old sentence arriving late.
    if (mine === generation) speakLocally(text, options)
  })
}

export function stopSpeaking(): void {
  generation += 1
  if (speechAvailable()) window.speechSynthesis.cancel()
  if (playing) {
    playing.pause()
    playing.src = ''
    playing = null
  }
}

/* ----------------------------------------------------------------------------------------
   Dictation
   ---------------------------------------------------------------------------------------- */

type RecognitionCtor = new () => SpeechRecognitionLike

interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}

function recognitionCtor(): RecognitionCtor | null {
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionCtor
    webkitSpeechRecognition?: RecognitionCtor
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

export function dictationAvailable(): boolean {
  return typeof window !== 'undefined' && recognitionCtor() !== null
}

/**
 * The composer's grammar does not dictate.
 *
 * Addressing is `@spec` and referring to a term is `#Task`, and no speech engine produces
 * either — you say "at spec" and get the words. This maps the few forms worth mapping and
 * accepts that the rest is wrong, which is exactly why dictation fills the box and never
 * sends: you read it back and fix it, the same as any dictated message.
 */
export function applySigils(text: string): string {
  return text
    .replace(/\b(?:at|@)\s+(spec|coder)\b/gi, '@$1')
    .replace(/\b(?:hash|hashtag|number)\s+([A-Za-z][A-Za-z0-9_-]*)/gi, '#$1')
    .replace(/\s+([.,;:?!])/g, '$1')
    .trim()
}

export interface Dictation {
  stop: () => void
}

/**
 * Starts dictating. `onText` receives the whole utterance so far, final segments only —
 * interim results rewrite themselves constantly and a textarea that flickers while you talk
 * is harder to use than one that lags slightly behind you.
 */
export function dictate(
  onText: (text: string) => void,
  onEnd: (error?: string) => void,
): Dictation | null {
  const Ctor = recognitionCtor()
  if (!Ctor) return null

  const recognition = new Ctor()
  recognition.continuous = true
  recognition.interimResults = false
  recognition.lang = 'en-US'

  let said = ''

  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index]!
      if (result.isFinal) said += `${result[0]?.transcript ?? ''} `
    }
    onText(applySigils(said))
  }

  recognition.onerror = (event) => onEnd(event.error)
  recognition.onend = () => onEnd()

  recognition.start()
  return { stop: () => recognition.stop() }
}
