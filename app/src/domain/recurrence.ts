/**
 * implements: RecurrenceRule
 *
 * spec: "A recurrence rule in RFC 5545 (iCalendar) RRULE form, such as
 * `FREQ=WEEKLY;INTERVAL=2` or `FREQ=MONTHLY;BYDAY=1MO`. A defined subset of the grammar
 * applies: FREQ (DAILY, WEEKLY, MONTHLY, YEARLY), INTERVAL, BYDAY — plain weekdays, or
 * ordinals such as 1MO and -1FR for monthly rules — and UNTIL. A weekly rule without BYDAY
 * repeats on the weekday it started from. Anything else, including COUNT, BYSETPOS,
 * BYMONTHDAY, BYMONTH, BYWEEKNO, BYYEARDAY, WKST and the sub-daily frequencies, is rejected
 * rather than approximated."
 *
 * q-003 replaced the grammar this file used to invent (`every 2 weeks`) with the calendar
 * standard, so this is a rewrite rather than a rename.
 *
 * The subset above is the spec's, not this file's choice. q-006 asked whether to narrow the
 * prose or grow the implementation to meet it, and narrowing won — so the constants below
 * restate RecurrenceRule rather than deviating from it, and this is the one changeset so
 * far that needed no behaviour change at all.
 *
 * Occurrences are found by scanning forward a day at a time and testing each date against
 * the rule. Slower than closed-form arithmetic and far easier to get right, which is the
 * correct trade for a design-time demonstration.
 */

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const BYDAY_PART = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/
const UNSUPPORTED = ['COUNT', 'BYSETPOS', 'BYMONTHDAY', 'BYMONTH', 'BYWEEKNO', 'BYYEARDAY', 'WKST']

/** Ten years. A rule with no occurrence inside that is reported, not looped over forever. */
const SCAN_LIMIT_DAYS = 3700

type Frequency = (typeof FREQUENCIES)[number]

interface ByDay {
  /** 0 = Sunday. */
  weekday: number
  /** 1 = first of the month, -1 = last. Absent for a plain weekday. */
  ordinal?: number
}

export interface Rule {
  freq: Frequency
  interval: number
  byday: ByDay[]
  until: string | null
}

export interface NextOccurrence {
  date: string | null
  problem?: string
}

export function parseRule(raw: string): { rule: Rule } | { problem: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { problem: 'the recurrence rule is empty' }

  // RRULE:FREQ=… is how the property appears in an iCalendar file; accept either form.
  const body = trimmed.toUpperCase().replace(/^RRULE:/, '')
  const parts = new Map<string, string>()

  for (const chunk of body.split(';')) {
    if (!chunk) continue
    const at = chunk.indexOf('=')
    if (at === -1) return { problem: `"${chunk}" is not a NAME=VALUE pair` }
    parts.set(chunk.slice(0, at), chunk.slice(at + 1))
  }

  const unsupported = UNSUPPORTED.filter((name) => parts.has(name))
  if (unsupported.length > 0) {
    return {
      problem: `${unsupported.join(', ')} ${unsupported.length === 1 ? 'is' : 'are'} valid RRULE but outside the subset RecurrenceRule defines`,
    }
  }

  const freq = parts.get('FREQ')
  if (!freq) return { problem: 'FREQ is required' }
  if (!FREQUENCIES.includes(freq as Frequency)) {
    return { problem: `FREQ=${freq} is not one of ${FREQUENCIES.join(', ')}` }
  }

  let interval = 1
  if (parts.has('INTERVAL')) {
    interval = Number(parts.get('INTERVAL'))
    if (!Number.isInteger(interval) || interval < 1) {
      return { problem: `INTERVAL=${parts.get('INTERVAL')} must be a positive whole number` }
    }
  }

  const byday: ByDay[] = []
  if (parts.has('BYDAY')) {
    for (const entry of parts.get('BYDAY')!.split(',')) {
      const match = BYDAY_PART.exec(entry)
      if (!match) return { problem: `BYDAY=${entry} is not a weekday` }
      byday.push({
        weekday: WEEKDAYS.indexOf(match[2] as (typeof WEEKDAYS)[number]),
        ...(match[1] ? { ordinal: Number(match[1]) } : {}),
      })
    }
  }

  let until: string | null = null
  if (parts.has('UNTIL')) {
    const value = parts.get('UNTIL')!
    // RRULE writes UNTIL as 20260818 or 20260818T000000Z; both reduce to a date here.
    const match = /^(\d{4})(\d{2})(\d{2})/.exec(value)
    if (!match) return { problem: `UNTIL=${value} is not a date` }
    until = `${match[1]}-${match[2]}-${match[3]}`
  }

  return { rule: { freq: freq as Frequency, interval, byday, until } }
}

/** Advances `from` (ISO `yyyy-mm-dd`) to the next date the rule produces. */
export function nextOccurrence(from: string, raw: string): NextOccurrence {
  const parsed = parseRule(raw)
  if ('problem' in parsed) return { date: null, problem: parsed.problem }

  const start = toDate(from)
  if (!start) return { date: null, problem: `"${from}" is not a date` }

  const { rule } = parsed
  const cursor = new Date(start)

  for (let step = 0; step < SCAN_LIMIT_DAYS; step += 1) {
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    if (!matches(cursor, start, rule)) continue

    const date = iso(cursor)
    // UNTIL bounds the series; past it there is no next occurrence at all.
    if (rule.until && date > rule.until) {
      return { date: null, problem: `the series ended on ${rule.until}` }
    }
    return { date }
  }

  return { date: null, problem: `no occurrence within ${Math.floor(SCAN_LIMIT_DAYS / 365)} years` }
}

/**
 * Whether `date` is an occurrence of `rule` anchored at `start`. A Task carries no
 * DTSTART, so its current dueDate is the anchor — which is what makes INTERVAL mean
 * "every N since the last one".
 */
function matches(date: Date, start: Date, rule: Rule): boolean {
  const weekdayAllowed =
    rule.byday.length === 0
      ? true
      : rule.byday.some((day) => day.weekday === date.getUTCDay() && ordinalMatches(date, day))

  if (!weekdayAllowed) return false

  switch (rule.freq) {
    case 'DAILY':
      return daysBetween(start, date) % rule.interval === 0

    case 'WEEKLY':
      if (weeksBetween(start, date) % rule.interval !== 0) return false
      // With BYDAY, every listed weekday inside a qualifying week is an occurrence. Without
      // it, RFC 5545 defaults to the weekday of DTSTART — here, of the current dueDate.
      // Skipping that default makes "weekly" match the very next day.
      return rule.byday.length > 0 || date.getUTCDay() === start.getUTCDay()

    case 'MONTHLY':
      if (monthsBetween(start, date) % rule.interval !== 0) return false
      return rule.byday.length > 0 || date.getUTCDate() === start.getUTCDate()

    case 'YEARLY':
      if ((date.getUTCFullYear() - start.getUTCFullYear()) % rule.interval !== 0) return false
      return (
        rule.byday.length > 0 ||
        (date.getUTCMonth() === start.getUTCMonth() && date.getUTCDate() === start.getUTCDate())
      )
  }
}

/** `1MO` is the first Monday of the month; `-1FR` the last Friday. */
function ordinalMatches(date: Date, day: ByDay): boolean {
  if (day.ordinal === undefined) return true

  if (day.ordinal > 0) {
    const nth = Math.floor((date.getUTCDate() - 1) / 7) + 1
    return nth === day.ordinal
  }

  const lastOfMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate()
  const fromEnd = Math.floor((lastOfMonth - date.getUTCDate()) / 7) + 1
  return fromEnd === -day.ordinal
}

function toDate(value: string): Date | null {
  const match = ISO_DATE.exec(value)
  if (!match) return null
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return Number.isNaN(date.getTime()) ? null : date
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000)
}

/** Whole weeks between the two dates' containing weeks, counting from Sunday. */
function weeksBetween(from: Date, to: Date): number {
  const startOfWeek = (date: Date) => {
    const copy = new Date(date)
    copy.setUTCDate(copy.getUTCDate() - copy.getUTCDay())
    return copy
  }
  return Math.round(daysBetween(startOfWeek(from), startOfWeek(to)) / 7)
}

function monthsBetween(from: Date, to: Date): number {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
}
