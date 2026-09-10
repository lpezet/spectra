// Bundle the CLI to a single, dependency-free file that runs on plain node — no tsx, no
// node_modules. This is what `install.sh` drops into ~/.local/bin/spectra.
//
// The CLI imports only node builtins (esbuild externalises those on platform:node), so the bundle
// is self-contained. The version is inlined via `define` because a single file has no package.json
// beside it to read at runtime.
import esbuild from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

// The release is named by its git tag, so the tag is the source of truth for the shipped version:
// the workflow passes SPECTRA_VERSION (the tag, minus its leading `v`). package.json's version is the
// fallback for a local/dev build, so `spectra --version` still reports something sensible off a tree.
const version = process.env.SPECTRA_VERSION || pkg.version

await esbuild.build({
  entryPoints: [path.join(root, 'src', 'cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: path.join(root, 'dist', 'cli.mjs'),
  banner: { js: '#!/usr/bin/env node' },
  define: { __SPECTRA_VERSION__: JSON.stringify(version) },
})

console.log(`built packages/cli/dist/cli.mjs (spectra ${version})`)
