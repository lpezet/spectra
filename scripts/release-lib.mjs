// Tag a workspace library for release, so CI publishes it to npm.
//
// Publishing is entirely tag-driven (.github/workflows/publish.yml): pushing `<name>-v<version>`
// triggers the Trusted-Publishing workflow, which refuses the tag unless packages/<name>/package.json
// is already at <version>. This script does NOT publish — the pushed tag does; it is a guarded
// convenience for creating that tag correctly.
//
// Safe by default: it DRY-RUNS (prints the exact git commands and stops) unless you pass --push.
// Before tagging it checks the things that would otherwise publish the wrong commit — you are on
// main, the tree is clean, main matches origin/main, and the tag does not already exist. The version
// always comes from the package's own package.json, so the recipe is: bump-and-merge first, then run
// this from an up-to-date main.
//
// Usage:
//   node scripts/release-lib.mjs <name>            # dry run — prints what it would tag
//   node scripts/release-lib.mjs <name> --push     # create the annotated tag and push it
//   npm run release:lib -- <name> [--push]         # the same, via npm (note the `--`)
//
// <name> ∈ core | agent-tools | drift-check | web-lib  (the packages publish.yml watches)
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// Keep in sync with the tag globs in .github/workflows/publish.yml.
const PUBLISHABLE = ['core', 'agent-tools', 'drift-check', 'web-lib']

const args = process.argv.slice(2)
const push = args.includes('--push')
const name = args.find((arg) => !arg.startsWith('--'))

const die = (message, code = 1) => {
  console.error(`✗ ${message}`)
  process.exit(code)
}
const git = (command) => execSync(`git ${command}`, { encoding: 'utf8' }).trim()

if (!name) die(`Usage: node scripts/release-lib.mjs <name> [--push]\n  <name> ∈ ${PUBLISHABLE.join(' | ')}`, 2)
if (!PUBLISHABLE.includes(name)) die(`"${name}" is not a publishable package. One of: ${PUBLISHABLE.join(', ')}.`, 2)

const dir = `packages/${name}`
const pkgPath = path.join(dir, 'package.json')
if (!existsSync(pkgPath)) die(`No package.json at ${dir}.`, 2)
const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'))
const tag = `${name}-v${version}`

// Guards — each of these is a way to publish the wrong thing.
const branch = git('rev-parse --abbrev-ref HEAD')
if (branch !== 'main') die(`On "${branch}", not main. Releases are cut from main — check it out first.`)
if (git('status --porcelain')) die('Working tree is not clean. Commit or stash first.')

execSync('git fetch origin main --quiet', { stdio: 'inherit' })
if (git('rev-parse HEAD') !== git('rev-parse origin/main')) {
  die('Local main is not in sync with origin/main. Pull (and push any local commits) so HEAD matches, then retry.')
}

if (git(`tag --list ${tag}`) || git(`ls-remote --tags origin ${tag}`)) {
  die(`Tag ${tag} already exists — bump the version in ${pkgPath} for a new release.`)
}

console.log(`\n▶ ${name} @ ${version}  →  tag ${tag}`)
const tagCmd = `git tag -a ${tag} -m ${JSON.stringify(`${name} ${version}`)}`
const pushCmd = `git push origin ${tag}`

if (!push) {
  console.log('\n(dry run — nothing tagged. Re-run with --push to publish.)\n')
  console.log(`  ${tagCmd}`)
  console.log(`  ${pushCmd}\n`)
  process.exit(0)
}

execSync(tagCmd, { stdio: 'inherit' })
execSync(pushCmd, { stdio: 'inherit' })
console.log(`\n✓ Pushed ${tag}. CI will publish ${name}@${version} to npm (Trusted Publishing).`)
