/**
 * Attribute value types are a tiny string grammar rather than a nested object, so
 * the JSON stays hand-editable:
 *
 *   string | number | boolean | date | ref:<TermName>     (each with an optional `[]` suffix)
 */

export const PRIMITIVES = ['string', 'number', 'boolean', 'date'] as const

export type Primitive = (typeof PRIMITIVES)[number]

export type ParsedValueType =
  | { kind: 'primitive'; name: Primitive; array: boolean }
  | { kind: 'ref'; name: string; array: boolean }

const VALUE_TYPE = /^(ref:)?([A-Za-z_][A-Za-z0-9_]*)(\[\])?$/

export function parseValueType(raw: string): ParsedValueType | null {
  const match = VALUE_TYPE.exec(raw.trim())
  if (!match) return null

  const [, refPrefix, name, arraySuffix] = match
  const array = arraySuffix === '[]'

  if (refPrefix) return { kind: 'ref', name: name!, array }
  if ((PRIMITIVES as readonly string[]).includes(name!)) {
    return { kind: 'primitive', name: name as Primitive, array }
  }
  // A bare capitalised word is almost certainly a Term reference missing its prefix.
  return null
}

export function isValueType(raw: string): boolean {
  return parseValueType(raw) !== null
}

/** The referenced Term name, or null when the value type is a primitive or unparseable. */
export function refName(raw: string): string | null {
  const parsed = parseValueType(raw)
  return parsed?.kind === 'ref' ? parsed.name : null
}

export function formatValueType(parsed: ParsedValueType): string {
  const prefix = parsed.kind === 'ref' ? 'ref:' : ''
  return `${prefix}${parsed.name}${parsed.array ? '[]' : ''}`
}

export function describeValueTypeError(raw: string): string {
  const bare = raw.trim().replace(/\[\]$/, '')
  if (/^[A-Z]/.test(bare)) {
    return `"${raw}" looks like a Term reference — did you mean "ref:${raw}"?`
  }
  return `"${raw}" is not a valid value type (expected ${PRIMITIVES.join(', ')} or ref:<TermName>, with an optional [] suffix)`
}
