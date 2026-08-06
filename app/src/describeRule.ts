/**
 * Says an RRULE out loud: `FREQ=DAILY;INTERVAL=3` becomes "every 3 days".
 *
 * Deliberately *not* under `domain/` and carrying no `implements:` marker, because it
 * implements no term. RecurrenceRule already fixes which grammar exists; turning that into
 * English is presentation, and the glossary has never described display. Putting it here
 * keeps that line visible — `domain/` is what the specs say, this is how the app happens
 * to show it.
 *
 * It reads the rule through the same parser the scheduler uses, so a phrase can never
 * describe a rule the app would refuse to run.
 */
import { parseRule } from './domain/recurrence.js'
import type { Rule } from './domain/recurrence.js'

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const ORDINAL_NAMES = ['', 'first', 'second', 'third', 'fourth', 'fifth']
const UNIT: Record<Rule['freq'], string> = {
  DAILY: 'day',
  WEEKLY: 'week',
  MONTHLY: 'month',
  YEARLY: 'year',
}
const PLAIN: Record<Rule['freq'], string> = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
}

/** `{ text }` for anything the scheduler accepts, `{ problem }` for anything it does not. */
export function describeRule(raw: string): { text: string } | { problem: string } {
  const parsed = parseRule(raw)
  if ('problem' in parsed) return parsed

  const { rule } = parsed
  const until = rule.until ? ` until ${longDate(rule.until)}` : ''

  if (rule.freq === 'WEEKLY' && rule.byday.length > 0) {
    const days = list(rule.byday.map((day) => WEEKDAY_NAMES[day.weekday]!))
    // "every other Tuesday" reads better than "every other week on Tuesday", but only
    // while there is one day to name.
    if (rule.interval === 2 && rule.byday.length === 1) return { text: `every other ${days}${until}` }
    if (rule.interval === 1) return { text: `every ${days}${until}` }
    return { text: `${cadence(rule)} on ${days}${until}` }
  }

  if (rule.freq === 'MONTHLY' && rule.byday.length > 0) {
    const days = list(rule.byday.map(ordinalDay))
    const when = rule.interval === 1 ? 'each month' : cadence(rule).replace(/^every /, 'every ')
    return { text: rule.interval === 1 ? `the ${days} of each month${until}` : `the ${days} of ${when}${until}` }
  }

  return { text: `${cadence(rule)}${until}` }
}

/** "daily", "every other week", "every 3 months". */
function cadence(rule: Rule): string {
  if (rule.interval === 1) return PLAIN[rule.freq]
  if (rule.interval === 2) return `every other ${UNIT[rule.freq]}`
  return `every ${rule.interval} ${UNIT[rule.freq]}s`
}

/** "first Monday", "last Friday", "second to last Friday". */
function ordinalDay(day: { weekday: number; ordinal?: number }): string {
  const name = WEEKDAY_NAMES[day.weekday]!
  if (day.ordinal === undefined) return name
  if (day.ordinal === -1) return `last ${name}`
  if (day.ordinal < 0) return `${ORDINAL_NAMES[-day.ordinal] ?? `${-day.ordinal}th`} to last ${name}`
  return `${ORDINAL_NAMES[day.ordinal] ?? `${day.ordinal}th`} ${name}`
}

/** "Monday", "Monday and Friday", "Monday, Wednesday and Friday". */
function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Formatted by hand rather than by locale, so the phrasing is the same everywhere. */
function longDate(iso: string): string {
  const [year, month, day] = iso.split('-')
  return `${Number(day)} ${MONTH_NAMES[Number(month) - 1]} ${year}`
}
