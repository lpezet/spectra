#!/usr/bin/env node
/*
 * Thin launcher so `spectra` runs straight from TypeScript source, no build step — matching how
 * the rest of the repo runs (tsx, not a compiled dist). The bootstrap installer will later
 * replace this with a bundled, self-contained binary; for dev and build-local this is what makes
 * the `spectra` bin work off a checkout.
 *
 * tsx is resolved from this package's dependencies and run with node directly, rather than spawned
 * by name — so it works whether or not node_modules/.bin happens to be on PATH.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.join(here, '..', 'src', 'cli.ts')

const require = createRequire(import.meta.url)
const tsxPkgPath = require.resolve('tsx/package.json')
const tsxPkg = JSON.parse(readFileSync(tsxPkgPath, 'utf8'))
const tsxBinRel = typeof tsxPkg.bin === 'string' ? tsxPkg.bin : tsxPkg.bin.tsx
const tsxBin = path.join(path.dirname(tsxPkgPath), tsxBinRel)

const child = spawn(process.execPath, [tsxBin, entry, ...process.argv.slice(2)], { stdio: 'inherit' })
child.on('error', (error) => {
  console.error(String(error))
  process.exit(1)
})
child.on('close', (code) => process.exit(code ?? 0))
