/**
 * implements: RecurringTask (the `recurrenceRule` string it carries)
 *
 * The glossary types `recurrenceRule` as a plain `string` and says nothing about its
 * grammar, so the grammar below is the implementation's choice, not the spec's:
 * `daily | weekly | monthly`, or `every N day(s) | week(s) | month(s)`.
 * Anything else is reported back rather than guessed at.
 */

const SHORTHAND: Record<string, Unit> = { daily: 'day', weekly: 'week', monthly: 'month' }
const RULE = /^every\s+(\d+)\s+(day|week|month)s?$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

type Unit = 'day' | 'week' | 'month'

export interface NextOccurrence {
  date: string | null
  problem?: string
}

/** Advances `from` (ISO `yyyy-mm-dd`) by one interval of `rule`. */
export function nextOccurrence(from: string, rule: string): NextOccurrence {
  const parsed = parseRule(rule)
  if (!parsed) {
    return {
      date: null,
      problem: `"${rule}" is not a recurrence rule this app understands (try "weekly" or "every 2 weeks").`,
    }
  }

  const match = ISO_DATE.exec(from)
  if (!match) return { date: null, problem: `"${from}" is not a date.` }

  const [, year, month, day] = match
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (Number.isNaN(date.getTime())) return { date: null, problem: `"${from}" is not a date.` }

  if (parsed.unit === 'day') date.setUTCDate(date.getUTCDate() + parsed.count)
  if (parsed.unit === 'week') date.setUTCDate(date.getUTCDate() + parsed.count * 7)
  if (parsed.unit === 'month') addMonths(date, parsed.count)

  return { date: date.toISOString().slice(0, 10) }
}

function parseRule(rule: string): { count: number; unit: Unit } | null {
  const normalized = rule.trim().toLowerCase()

  const shorthand = SHORTHAND[normalized]
  if (shorthand) return { count: 1, unit: shorthand }

  const match = RULE.exec(normalized)
  if (!match) return null

  const count = Number(match[1])
  if (count < 1) return null

  return { count, unit: match[2] as Unit }
}

/** Clamps to the end of the target month, so 31 Jan + 1 month is 28 Feb, not 3 Mar. */
function addMonths(date: Date, count: number): void {
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + count)
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, lastDay))
}
