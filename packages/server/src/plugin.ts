/**
 * The one mechanism behind every pluggable seam.
 *
 * Storage, transcripts, and auth are all "a built-in, or a module the server does not ship" — the
 * same shape, so they share this loader rather than each re-implementing dynamic import + a clear
 * error. A seam's resolver checks for its built-in names first; anything else is a module specifier
 * passed here, imported, and asked for a factory (`createX`, or a default export). The factory is
 * handed the seam's context (it reads its own config from `context.env`), and its result is validated
 * so a malformed module fails loudly here rather than as a late `undefined is not a function`.
 */
export async function loadPlugin<T>(
  spec: string,
  namedExport: string,
  context: unknown,
  label: string,
  validate: (value: unknown) => value is T,
): Promise<T> {
  let module: Record<string, unknown>
  try {
    module = (await import(spec)) as Record<string, unknown>
  } catch (cause) {
    throw new Error(`${label}="${spec}" could not be imported as a module: ${(cause as Error).message}`)
  }
  const factory = (module[namedExport] ?? module.default) as ((c: unknown) => unknown) | undefined
  if (typeof factory !== 'function') {
    throw new Error(`${label} module "${spec}" must export ${namedExport} (or a default factory function).`)
  }
  const value = await factory(context)
  if (!validate(value)) {
    throw new Error(`${label} module "${spec}" returned something that is not a valid ${label.toLowerCase()}.`)
  }
  return value
}
