/**
 * The package entry, so another host can embed `@abseed/spectra-web`'s `App` rather than fork it.
 *
 * The standalone local build enters through `main.tsx` (which renders `App` and imports the styles);
 * this is the *library* door, for a host that renders `App` inside its own shell — e.g. a hosted
 * coordinator wrapping it in an authentication gate. Importing this pulls the styles in as a side
 * effect, so an embedder gets the styled UI from one import. `App` self-bootstraps against the
 * same-origin `/api`, so the host needs only to serve that API and mount `<App />`.
 */
import '@abseed/spectra-web-lib/styles.css'
export { App } from './App.js'

// For a host that drives the agents differently than the local tool: install a live chat transport
// (see setChatTransport) and address project-scoped calls with these. The static chat/glossary reads
// still go over plain REST the host serves. These now live in @abseed/spectra-web-lib and are
// re-exported here so an embedder of this app's `App` still reaches them from one package.
export { setChatTransport, apiPath, currentProject } from '@abseed/spectra-web-lib'
export type { ChatTransport, StreamHandlers, ChatEvent } from '@abseed/spectra-web-lib'
