# Spec DSL / Blueprint-Glossary — Project Brief

## Origin & Goal

Two prior approaches produced opposite problems:

- **Spec-first (AgentLink)**: precise upfront specs of logic/flows/models worked well for
  backend, workflow-heavy software.
- **Vibe Coding (Thunder Blazer, a Phaser shmup)**: describing general intent each time
  ("add a power-up," "new enemy with new behavior") was fast but broke down — there was
  no shared vocabulary between end-user/PM and the AI coding agent to refer to specific
  things precisely.

The goal of this project: build a **shared, structured vocabulary** (a "Spec DSL") that
a human (product/end-user role) and an AI coding agent can both read and write, which
sits *above* the actual code. The human should be able to author and evolve the spec
through a UI without ever needing to look at or organize code. The AI agent implements
the spec in whatever language/structure it chooses — possibly generating multiple
files, helper functions, classes — none of which the human needs to see unless useful.

Key inspiration and key departure: **Unreal Blueprints**, but:
- Not a node/wire graph — a **glossary with typed relationships** (like a wiki with
  backlinks), since positions/wires added maintenance overhead without adding meaning.
- No runtime to fall back on for debugging — this is a *design-time* spec/expression
  system, not an executing engine. Tests are the primary observability layer.

## Core Concepts

### Term (the "Model")
The atomic unit of the glossary. Roughly a Class:

- `name` — stable identifier, e.g. `Drops`, `Ship`, `Protection`
- `type` — `entity | event | function | attribute-type`
- `spec` — short natural-language description (spec-worthy, not just a comment)
- `attributes` — named, typed fields (a type can itself be a Term reference, not just
  a primitive — e.g. `Ship.protection: Protection`, where `Protection` is its own Term
  with its own spec)
- `parent` — optional single supertype (is-a), e.g. `PowerUp` is-a `Drops`
- `tags` — optional free cross-cutting labels (not a strict hierarchy), e.g. `Bomb`
  tagged `AreaEffect`, `Consumable`

### Relationship
Typed edges between terms. Minimal set to start:
- `is-a` (subtype)
- `has-a` / attribute reference (composition)
- `references` (mentioned-by — e.g. a Function references an Entity or another
  Function)

### Event & Function
Both are Terms (type: `event` / `function`), distinguished by role:
- **Event** — a trigger, e.g. `onCollision`, `onDropCollision` (subtype of
  `onCollision`)
- **Function** — behavior invoked by an event or by another function, with a spec
  precise enough to generate tests from, e.g.:
  > "Player ship takes damage equal to sprite damage, minus any protection the ship
  > has, clamped at zero (no healing from negative damage)."

Ambiguities the human didn't specify (e.g. "what if protection > damage?") should be
**surfaced back to the human explicitly**, not silently resolved — either as a question
or as a stated default that becomes part of the spec history.

### Changeset
How the AI proposes edits to the glossary. A structured list of ops, not free text:

```json
{
  "id": "cs-001",
  "summary": "Add Nuke drop type + wire collision handling",
  "ops": [
    { "op": "add_entity", "term": "Nuke", "parent": "Drops",
      "spec": "..." },
    { "op": "add_reference", "from": "onDropCollision", "to": "Nuke" }
  ],
  "tests": [ "..." ]
}
```

- Ops can depend on each other (op 2 needs op 1's term to exist) — the UI should
  detect broken/dangling references before allowing accept.
- Accept/reject/cherry-pick at the changeset level, with per-op override.
- A changeset with generated tests, all passing, is safer to auto-approve than one
  that's spec text only.

## UI (thin view over the store, not the store)

- **Source of truth is a flat, hand-editable file** (JSON/YAML) — the UI is a live
  view + structured writer, always re-reading before rendering. No positions/layout
  state to persist (this is the explicit departure from Blueprints).
- **Search-first, not spatial-first**: find a term, see its spec, its parent, its
  children, everything that references it (backlinks).
- **Click a term → highlight everything connected to it** (subtypes, referrers,
  referenced-by).
- **Chat panel integrated**, writing to the same store the highlight view reads from —
  proposed changes appear as a changeset, rendered as colored highlights over the
  existing glossary (green = add, amber = modify, red = remove) rather than a separate
  diff screen.
- **Instance vs. type**: decide explicitly whether the glossary holds only type-level
  specs, or also per-instance data (e.g. "this wave's enemy has HP=50"). Recommend
  starting type-only to avoid recreating the "gigantic UI" problem early.

## Build Plan

### Phase 1 — ToDo app (proves the core loop end to end)
Deliberately boring: CRUD, real attributes, a couple of subtypes, a handful of
Functions with genuine edge cases (e.g. `completeTask` when already complete,
`deleteProject` with tasks still inside — cascade or block?). No timing, no
reactive fan-out. Build:
1. The schema (Term, Relationship, Changeset) as the actual storage format
2. A minimal UI: browse/search terms, click-to-highlight backlinks, view a term's
   spec + attributes
3. Chat-driven changeset proposals → accept/reject/cherry-pick UI
4. Spec → AI proposes refined spec + tests + surfaced ambiguities loop

Ship this to a genuine "done" — don't let it become permanent scaffolding.

### Phase 2 — small classic game (stress-tests Events + fan-out)
Candidate: Pac-Man-style (one `onCollision` event branching into different Functions
depending on state — powered vs. not — is a good test of conditional behavior without
a shmup's full wave/boss/weapon-upgrade scope). Use this phase specifically to break
assumptions baked into Phase 1's schema/UI — expect friction, and let it reshape the
proto rather than bolting fixes onto a half-finished v1.

## Open Questions to Resolve While Building
- Instance vs. type modeling — in scope now, or deferred entirely to a later phase?
- Attribute types as Term references vs. primitives — enforce Term-reference where
  possible from the start, or allow primitives and tighten later?
- Changeset dependency detection — auto-pull dependent ops on cherry-pick, or just warn?
- What counts as "spec-worthy" enough for a Function before the AI will generate tests
  from it (vs. bouncing back with clarifying questions)?
