/**
 * Reading the agents out loud, and typing by talking.
 *
 * Entirely in the browser. Nothing here touches the server, the agents, the sandbox or the
 * credential — which is why it can be added without thinking about any of them. The one
 * exception is worth knowing: dictation in Chrome sends your audio to Google. It is your
 * microphone and your browser rather than anything this tool controls, but in a project this
 * careful about egress it should be a thing you chose, not a thing you discovered.
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
 * The opening sentence, when the whole thing is too long to sit through.
 *
 * A crude split on purpose. The better fix is upstream — an agent told to lead with its
 * conclusion produces a first sentence worth hearing, and that helps the folded view and
 * plain skimming at the same time. This is what makes do until then, and it is why the
 * cut-off is generous rather than tight: truncating a paragraph that was not written to be
 * truncated loses more than it saves.
 */
export function firstSentence(text: string, max = 240): string {
  if (text.length <= max) return text

  const cut = text.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  return stop > 60 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`
}

export interface VoiceChoice {
  /** `SpeechSynthesisVoice.voiceURI`, or null to use whatever the browser defaults to. */
  uri: string | null
  pitch: number
  rate: number
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
}

export function speechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/**
 * Says one thing, cancelling whatever was being said.
 *
 * Cancelling rather than queueing is the right default here: if a newer conclusion has
 * arrived, the older one has stopped being what you wanted to hear, and a queue would leave
 * you listening to history while the present scrolls past.
 */
export function speak(text: string, options: SpeakOptions): void {
  if (!speechAvailable() || text.trim() === '') return

  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  const voice = options.uri ? options.voices.find((candidate) => candidate.voiceURI === options.uri) : undefined
  if (voice) utterance.voice = voice
  utterance.pitch = options.pitch
  utterance.rate = options.rate
  window.speechSynthesis.speak(utterance)
}

export function stopSpeaking(): void {
  if (speechAvailable()) window.speechSynthesis.cancel()
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
