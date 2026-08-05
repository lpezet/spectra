# todo-blueprints — M5: Implement the App from the Specs

Follows M0–M4 (see `todo-blueprints-project-spec.md`). After M4 you have a
complete spec-authoring loop — browse, search, review a proposed change,
apply it — but no running ToDo app yet. That's a distinct piece: something
has to read the specs and *implement* an actual application from them. M5
covers that.

## Structure

Add a second directory alongside `/specs`:

```
todo-blueprints/
  specs/           # unchanged — the glossary
  app/             # the actual ToDo app, implemented FROM the specs
    src/
      ...
  server/
  web/
```

## Process

This is not an automated compiler — for Phase 1, "implement the app" is a
directed pass: point Claude Code at the current contents of `/specs/terms/*.json`
and have it write/update `/app` to match. Re-running this after a changeset is
applied is a manual, explicit step for now (not automatic regeneration) —
treat it as its own task each time the spec meaningfully changes.

**Glue back to the spec**: each generated file that implements a term should
carry a lightweight marker so a later spec change can be traced to the code
that needs updating — a header comment is enough for Phase 1:
```ts
// implements: Task, completeTask
```
No enforcement needed yet, just a convention Claude Code follows when writing
`/app`.

## Acceptance Criteria

The app should let an end-user, through a minimal UI, actually exercise the
seed domain's behavior:
- Create a Project, create Tasks inside it
- Complete a Task (idempotent — completing an already-done Task is a no-op,
  matching `completeTask`'s spec)
- Reopen a completed Task (`reopenTask`)
- Delete a Project that still has incomplete Tasks — behavior must match
  whatever `deleteProject`'s spec says (cascade or block — pick one, make
  sure the spec and the implementation agree)
- Add a RecurringTask and see it distinguished from a plain Task in the UI
  (even minimally — e.g. a badge showing the recurrence rule)

This app's UI can be intentionally bare — the point is proving the spec
produced *correct, runnable behavior*, not a polished ToDo app.

## Dev Server

`/app` should have its own `npm run dev` (or reuse `/web`'s Vite setup with a
second entry point, if simpler) that a person can run to actually open the
ToDo app in a browser and click through it. Claude Code should leave the repo
in a state where both the spec tool (`/web`) and the implemented app (`/app`)
can be started with a documented command each — add those two commands to the
repo README once M5 is done.

## Next

Stop and reassess after M5 — that's the full loop end to end (author a spec →
review/apply a change → have it implemented into a running app you can click
through) and the right point to decide whether to wire live AI changeset
generation into the spec UI, or move to Phase 2 (the Pac-Man-style pilot) to
stress-test the schema against Events/reactive fan-out.