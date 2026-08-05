# todo-blueprints — Project Spec

Phase 1 pilot of the Spec DSL / glossary concept (see companion doc
`spec-dsl-glossary-brief.md` for the "why"). This repo builds the tool itself,
seeded with a ToDo-app domain to prove the core loop end to end.

## Scope (Phase 1 only)

Build:
1. A file-based glossary store (Terms, Relationships) — human-editable JSON
2. A read UI: browse/search terms, view a term's spec + attributes, click a term
   to highlight everything referencing it (backlinks)
3. A changeset format + UI: apply/reject/cherry-pick structured proposed edits,
   rendered as colored highlights over the glossary
4. A seeded ToDo domain (Task, Project, etc.) as the test content

Explicitly **out of scope** for Phase 1 (defer to Phase 2 / later):
- Instance data (only type-level specs — no "this task's actual due date")
- Any node/graph canvas — list + search + backlinks only, no spatial layout
- Chat-driven AI proposing changesets live (build the changeset *format* and
  *UI* first; wiring an actual agent to generate them can come after — for now,
  hand-author a few example changesets as fixtures to drive the UI)
- Auth, multi-user, real-time collab

## Tech Stack (assumption — flag if you want to change this)

- **Frontend**: React + Vite + TypeScript
- **Backend**: minimal Node (Express or Fastify) — only job is reading/writing
  spec files on disk and serving them to the frontend; no database
- **Storage**: plain JSON files on disk under `/specs`, one file per term
  (git-diff-friendly, matches "I could hand-edit this directly")
- **Styling**: keep minimal (plain CSS or Tailwind) — this is a functional
  prototype, not a polished product

## Repo Structure

```
todo-blueprints/
  specs/
    terms/
      task.json
      project.json
      recurring-task.json
      ...
    changesets/
      cs-001-add-priority.json    # example/fixture changesets
  server/
    src/
      index.ts          # serves /api/terms, /api/changesets, applies changesets
  web/
    src/
      components/
        TermList.tsx
        TermDetail.tsx
        BacklinkHighlight.tsx
        ChangesetReview.tsx
      App.tsx
  README.md
```

## Data Model

### Term (`specs/terms/<name>.json`)

```json
{
  "name": "Task",
  "type": "entity",
  "spec": "A single actionable item within a Project.",
  "parent": null,
  "tags": [],
  "attributes": [
    { "name": "title", "valueType": "string" },
    { "name": "done", "valueType": "boolean", "default": false },
    { "name": "dueDate", "valueType": "date", "optional": true },
    { "name": "project", "valueType": "ref:Project" }
  ]
}
```

- `valueType` is either a primitive (`string`, `boolean`, `date`, `number`) or
  `ref:<TermName>` when the attribute's type is itself a Term.
- `parent`: single term name (is-a) or `null`.
- References to other terms elsewhere (e.g. inside a Function's spec) don't need
  a separate field — backlinks are computed by scanning all terms for mentions in
  `attributes[].valueType` (`ref:X`) and `parent`. Keep this scan simple for
  Phase 1 (exact-name matching); no NLP needed.

### Function / Event (also a Term, `type: "function"` or `"event"`)

```json
{
  "name": "completeTask",
  "type": "function",
  "spec": "Marks a Task as done. If already done, this is a no-op (idempotent) — does not error and does not un-complete it.",
  "parent": null,
  "tags": [],
  "attributes": [
    { "name": "target", "valueType": "ref:Task" }
  ]
}
```

Include at least these Functions in the seed domain, chosen because each has a
genuine edge case worth surfacing in the spec text itself (not left implicit):

- `completeTask` — behavior when already complete (see above)
- `deleteProject` — behavior when the project still has incomplete Tasks
  (cascade-delete them, or block the deletion?) — pick one, state it explicitly
  in the spec
- `reopenTask` — behavior on a Task that was never completed

### Changeset (`specs/changesets/<id>.json`)

```json
{
  "id": "cs-001",
  "summary": "Add Priority attribute to Task",
  "ops": [
    {
      "op": "add_attribute",
      "term": "Task",
      "attribute": { "name": "priority", "valueType": "string", "default": "normal" }
    }
  ],
  "tests": [
    "creating a Task without specifying priority defaults it to 'normal'"
  ]
}
```

Supported `op` types for Phase 1: `add_entity`, `remove_entity`, `add_attribute`,
`remove_attribute`, `modify_spec`. (`add_reference`/`remove_reference` can wait —
Phase 1's only cross-term refs are via attributes and `parent`.)

Applying a changeset = replaying its ops against the term files in order. Before
allowing apply, validate: does `remove_attribute`/`remove_entity` orphan any
`ref:` pointing at it elsewhere? If so, warn in the UI rather than silently
applying.

## Seed Domain (initial `specs/terms/*.json` content)

- `Project` — entity, attributes: `name: string`, `tasks: ref:Task[]` *(note:
  arrays of refs — decide if `valueType` needs a `[]` suffix convention, or a
  separate `cardinality` field; pick one and be consistent)*
- `Task` — entity, as shown above
- `RecurringTask` — entity, `parent: "Task"`, adds `recurrenceRule: string`
- `completeTask`, `reopenTask`, `deleteProject` — functions, as above

## Milestones

1. **M0 — scaffold**: repo structure, backend serves `GET /api/terms` reading
   from `/specs/terms/*.json`, frontend renders a flat list of term names
2. **M1 — term detail + backlinks**: click a term → show its spec/attributes;
   compute and show "referenced by" (scan all terms for `ref:<name>` matches)
3. **M2 — search**: filter the term list by name/spec text
4. **M3 — changeset review UI**: load fixture changesets from
   `/specs/changesets/*.json`, render each op as a colored line (add=green,
   remove=red, modify=amber) against the current term state, with
   accept-all / reject / per-op cherry-pick
5. **M4 — apply**: accepting a changeset writes the resulting term JSON back to
   disk (via the backend), with the orphan-reference validation check before
   allowing it

Stop and reassess after M4 — that's a complete Phase 1 loop (browse, search,
review a proposed change, apply it) and the right point to decide whether to
wire live AI changeset generation into this same UI, or move to Phase 2 (the
Pac-Man-style pilot) to stress-test the schema against Events/reactive fan-out.