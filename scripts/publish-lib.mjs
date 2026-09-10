// Publish an internally-consumed workspace package to npm without disturbing the monorepo.
//
// The problem: these packages point `main` at `src` so the rest of the monorepo (and other local
// consumers) resolve their TypeScript source directly — instant edits, no build step, the dev flow
// everyone relies on. But an npm consumer needs built JS + types. Rather than flip `main` to `dist`
// (which would force every internal consumer to build before it could resolve the package), this builds
// `dist` and publishes a *transformed* package.json from a staging dir — so the checked-in package
// stays source-first and only the tarball is dist-first.
//
// Usage:  node scripts/publish-lib.mjs packages/core [--dry-run] [--otp <code>]
//
// It rewrites workspace inter-deps (`"@abseed/spectra-*": "*"`) to `^<this version>`, so a published
// package pins its published siblings rather than carrying a workspace wildcard.
import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const otpIndex = args.indexOf('--otp')
const otp = otpIndex >= 0 ? args[otpIndex + 1] : undefined
const pkgDir = path.resolve(args.find((a) => !a.startsWith('--') && a !== otp) ?? '')
if (!existsSync(path.join(pkgDir, 'package.json'))) {
  console.error(`No package.json at ${pkgDir}. Usage: node scripts/publish-lib.mjs packages/<name> [--dry-run] [--otp <code>]`)
  process.exit(2)
}

const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
console.log(`\n▶ ${pkg.name}@${pkg.version}${dryRun ? ' (dry run)' : ''}`)

// 1. Build dist (the package's own build script: tsc -p tsconfig.build.json).
console.log('  building dist…')
execSync('npm run build', { cwd: pkgDir, stdio: 'inherit' })

// 2. Stage the tarball contents: dist + the docs npm should ship.
const stage = mkdtempSync(path.join(os.tmpdir(), 'spectra-pub-'))
cpSync(path.join(pkgDir, 'dist'), path.join(stage, 'dist'), { recursive: true })
for (const file of ['README.md', 'LICENSE', 'NOTICE']) {
  const from = path.join(pkgDir, file)
  if (existsSync(from)) cpSync(from, path.join(stage, file))
}

// 3. The transformed, dist-first package.json — source-only fields stripped, siblings pinned.
const pinned = Object.fromEntries(
  Object.entries(pkg.dependencies ?? {}).map(([name, range]) =>
    name.startsWith('@abseed/spectra-') ? [name, `^${pkg.version}`] : [name, range],
  ),
)
const published = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  author: pkg.author,
  homepage: pkg.homepage,
  repository: pkg.repository,
  keywords: pkg.keywords,
  type: pkg.type,
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
  sideEffects: pkg.sideEffects ?? false,
  dependencies: pinned,
  // Carried as-is: a type-carrying lib (zod schemas cross the boundary) declares zod a peer so the
  // consumer's single copy is used, rather than nesting its own and breaking type identity.
  peerDependencies: pkg.peerDependencies,
  publishConfig: { access: 'public' },
}
writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(published, null, 2)}\n`)

// 4. Publish (or dry-run) from the staging dir.
const publishCmd = `npm publish --access public${dryRun ? ' --dry-run' : ''}${otp ? ` --otp ${otp}` : ''}`
console.log(`  ${publishCmd}`)
execSync(publishCmd, { cwd: stage, stdio: 'inherit' })
rmSync(stage, { recursive: true, force: true })
console.log(`✓ ${dryRun ? 'dry-run complete' : 'published'} ${pkg.name}@${pkg.version}\n`)
