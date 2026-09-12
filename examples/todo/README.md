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
and the `implements` drift check) lived in `app/` and is now on the `backup/todo-app` branch.
That app is the kind of thing `@coder` implements into: a *standalone* project you supply at
`spectra init` time via `--dir` (mounted at `/work/project`), deliberately not bundled with the
tool. It stays on that branch as a worked example you can point `@coder` at if you want one.
