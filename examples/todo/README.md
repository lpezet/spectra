# examples/todo

The **example glossary** Spectra operates on in development — the ToDo domain (tasks,
projects, recurring tasks) that this repo grew up around. It is *not* part of the engine.
Spectra ships empty, the way a database ships with no data; this is a sample you can point
it at, not content baked into the tool.

- `specs/` — the glossary itself: `terms/`, `changesets/` (with `applied/`, `rejected/`),
  `questions/`, `expectations/`, and `project.json` (the glossary's identity).

`npm run dev` points `SPECS_DIR` here so the tool boots against a populated glossary. Run the
engine with no `SPECS_DIR` and it operates on an empty glossary instead.

The *consumer app* written from these specs (the actual ToDo app, its `specs.snapshot.json`
and the `implements` drift check) lived in `app/` and is currently on the `backup/todo-app`
branch. When it is wired back (blocker E), it belongs beside this glossary as
`examples/todo/app/` — a standalone project the sandboxed `@coder` targets.
