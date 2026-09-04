/**
 * Turning a term or changeset into the exact bytes a human would have hand-authored.
 *
 * Lifted out of commit.ts so the storage layer (which now owns the writes) and the write
 * orchestration can share it without a cycle. The format is load-bearing, not cosmetic:
 * fixed key order, 2-space indent, one line per attribute. Break it and the first applied
 * changeset reformats every file it touches and buries the real change in whitespace.
 */
import type { Attribute, Changeset, Term } from '@spectra/core'

/** `RecurringTask` → `recurring-task.json`, matching the seed files. */
export function termFileName(name: string): string {
  return `${name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}.json`
}

/** `{ "name": "title", "valueType": "string" }` — one line, with the spacing a human would use. */
function inlineObject(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 1).replace(/\n\s*/g, ' ')
}

/**
 * Writes a term the way a human would have written it: fixed key order, 2-space indent,
 * and one line per attribute.
 */
export function serializeTerm(term: Term): string {
  const attribute = (source: Attribute) => {
    const ordered: Record<string, unknown> = { name: source.name, valueType: source.valueType }
    if (source.default !== undefined) ordered.default = source.default
    if (source.optional !== undefined) ordered.optional = source.optional
    return inlineObject(ordered)
  }

  const attributes = term.attributes.map((source) => `    ${attribute(source)}`)

  const lines = [
    '{',
    `  "name": ${JSON.stringify(term.name)},`,
    `  "type": ${JSON.stringify(term.type)},`,
    `  "spec": ${JSON.stringify(term.spec)},`,
    `  "parent": ${JSON.stringify(term.parent)},`,
    `  "tags": ${JSON.stringify(term.tags)},`,
    attributes.length > 0
      ? `  "attributes": [\n${attributes.join(',\n')}\n  ]`
      : '  "attributes": []',
    '}',
  ]

  return `${lines.join('\n')}\n`
}

export function serializeChangeset(changeset: Changeset): string {
  return `${JSON.stringify(changeset, null, 2)}\n`
}
