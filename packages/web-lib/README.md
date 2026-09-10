# @abseed/spectra-web-lib

The reusable half of the Spectra spec-tool UI: the presentational React components, the
transport-injected glossary behavior (`useGlossary`), and the chat subsystem — everything a host
composes into its own shell.

Nothing here reaches for a `fetch` of its own. The behavior depends only on a `GlossaryTransport`
interface, so the same flows (bootstrap, project selection, the commit/answer/expectation cycle) run
against any backend a host implements. The components take data and callbacks as props. The chat
subsystem's live half (send, approve, stream) is swapped with `setChatTransport`; its static reads are
same-origin REST a host serves.

```tsx
import { useGlossary, TermList, TermDetail, type GlossaryTransport } from '@abseed/spectra-web-lib'
import '@abseed/spectra-web-lib/styles.css'

const transport: GlossaryTransport = {
  /* fetchGlossary, applyChangeset, … — one implementation per backend */
}

function Shell() {
  const g = useGlossary(transport)
  // lay the pieces out however this host wants
}
```

`react` and `react-dom` are peer dependencies — the host brings its single copy.

Apache-2.0.
