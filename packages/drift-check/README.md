# @abseed/spectra-drift-check

The offline drift check between a Spectra glossary and the code that implements it.

Your project keeps two things: a `specs.snapshot.json` (written by `@coder`'s `export_specs` tool and
committed with the code) and `// implements: <Term>` markers in your source. This package checks that
the two agree — **offline, with no coordinator running** — so the check works in a bare copy of the
project and inside `@coder`'s sandbox alike.

It catches:

- a marker that isn't comma-separated bare identifiers (put prose on the next line);
- a marker naming a term the glossary no longer has (renamed or removed);
- an entity/function/event term that nothing implements (an implementation pass is due).

It cannot catch a term whose spec was *rewritten* — the marker still names it. That's what each term's
`hash` in the snapshot is for: refresh the file and `git diff specs.snapshot.json` names the terms
that moved, so the test fails loud for structure and review catches the rest.

## Use it

Add it as a dev-dependency, then write a one-line test in whatever runner you already use:

```ts
import { driftCheck } from '@abseed/spectra-drift-check'
import { expect, it } from 'vitest'

it('the glossary and the code are in sync', () => {
  const { ok, findings } = driftCheck({ srcDir: 'src', snapshotPath: 'specs.snapshot.json' })
  expect(ok, findings.map((f) => f.message).join('\n')).toBe(true)
})
```

`driftCheck` returns `{ ok, findings }`; each finding has a `kind` and a human-readable `message`.
The reader functions (`readMarkers`, `readSnapshot`, `implementersOf`) and the pure `checkDrift` are
exported too, if you want to assemble the check differently.

## Keep the snapshot fresh

`specs.snapshot.json` is a pure function of the glossary (no timestamp), so re-exporting when nothing
changed leaves it byte-identical. Have `@coder` run `export_specs` before an implementation pass and
commit the result; a stale snapshot is your branch being behind, the way `git status` reports it — a
signal to refresh, not a wall.
