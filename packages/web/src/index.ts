/**
 * The package entry, so another host can embed `@spectra/web`'s `App` rather than fork it.
 *
 * The standalone local build enters through `main.tsx` (which renders `App` and imports the styles);
 * this is the *library* door, for a host that renders `App` inside its own shell — e.g. a hosted
 * coordinator wrapping it in an authentication gate. Importing this pulls the styles in as a side
 * effect, so an embedder gets the styled UI from one import. `App` self-bootstraps against the
 * same-origin `/api`, so the host needs only to serve that API and mount `<App />`.
 */
import './styles.css'
export { App } from './App.js'
