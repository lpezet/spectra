/** A stand-in transcript-store plugin for resolveTranscriptStore's test — loaded by specifier. */
import type { TranscriptStore, TranscriptStoreContext } from './transcripts.js'

export function createTranscriptStore(context: TranscriptStoreContext): TranscriptStore {
  const noop = async () => undefined
  // Echoes the context's dataDir through a session id, so the test can prove it was loaded + handed one.
  return {
    createSession: noop,
    listSessions: async () => [{ id: `from-plugin:${context.dataDir}`, projectId: 'p', title: '', createdAt: '', updatedAt: '' }],
    append: async () => 0,
    read: async () => [],
  } as unknown as TranscriptStore
}
