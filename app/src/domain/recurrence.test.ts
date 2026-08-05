/**
 * RRULE parsing and scheduling, per q-003. Replaces the suite that covered the grammar
 * this file used to invent.
 */
import { describe, expect, it } from 'vitest'
import { nextOccurrence, parseRule } from './recurrence.js'

/** 2026-08-04 is a Tuesday — most cases below lean on that. */
const TUE = '2026-08-04'

const next = (from: string, rule: string) => nextOccurrence(from, rule).date
const problem = (from: string, rule: string) => nextOccurrence(from, rule).problem

describe('parseRule', () => {
  it('accepts a bare rule and the RRULE: prefixed form alike', () => {
    expect(parseRule('FREQ=WEEKLY')).toHaveProperty('rule')
    expect(parseRule('RRULE:FREQ=WEEKLY')).toHaveProperty('rule')
  })

  it('is case-insensitive', () => {
    expect(parseRule('freq=weekly;interval=2')).toEqual({
      rule: { freq: 'WEEKLY', interval: 2, byday: [], until: null },
    })
  })

  it('requires FREQ', () => {
    expect(parseRule('INTERVAL=2')).toEqual({ problem: 'FREQ is required' })
  })

  it('rejects a frequency it does not schedule', () => {
    expect(parseRule('FREQ=HOURLY')).toMatchObject({ problem: expect.stringContaining('FREQ=HOURLY') })
  })

  it('rejects an interval that is not a positive whole number', () => {
    expect(parseRule('FREQ=DAILY;INTERVAL=0')).toMatchObject({ problem: expect.stringContaining('INTERVAL=0') })
  })

  it('reads BYDAY with and without an ordinal', () => {
    expect(parseRule('FREQ=MONTHLY;BYDAY=1MO,-1FR')).toEqual({
      rule: {
        freq: 'MONTHLY',
        interval: 1,
        byday: [
          { weekday: 1, ordinal: 1 },
          { weekday: 5, ordinal: -1 },
        ],
        until: null,
      },
    })
  })

  it('reads UNTIL in both date and timestamp forms', () => {
    expect(parseRule('FREQ=DAILY;UNTIL=20260818')).toMatchObject({ rule: { until: '2026-08-18' } })
    expect(parseRule('FREQ=DAILY;UNTIL=20260818T000000Z')).toMatchObject({ rule: { until: '2026-08-18' } })
  })

  it('names the RRULE parts it does not support instead of ignoring them', () => {
    // Silently dropping COUNT would schedule a bounded series forever.
    expect(parseRule('FREQ=DAILY;COUNT=5')).toMatchObject({ problem: expect.stringContaining('COUNT') })
    expect(parseRule('FREQ=MONTHLY;BYSETPOS=-1')).toMatchObject({ problem: expect.stringContaining('BYSETPOS') })
  })

  it('rejects the grammar this file used to invent', () => {
    expect(parseRule('every 2 weeks')).toHaveProperty('problem')
    expect(parseRule('weekly')).toHaveProperty('problem')
  })
})

describe('nextOccurrence', () => {
  it('steps daily, with and without an interval', () => {
    expect(next(TUE, 'FREQ=DAILY')).toBe('2026-08-05')
    expect(next('2026-08-05', 'FREQ=DAILY;INTERVAL=3')).toBe('2026-08-08')
  })

  it('defaults a weekly rule to the weekday it started on', () => {
    // Without this, "weekly" from a Tuesday would match Wednesday.
    expect(next(TUE, 'FREQ=WEEKLY')).toBe('2026-08-11')
  })

  it('honours a weekly interval', () => {
    expect(next(TUE, 'FREQ=WEEKLY;INTERVAL=2')).toBe('2026-08-18')
  })

  it('takes the next listed weekday when BYDAY is given', () => {
    // From Tuesday, the next Monday-or-Friday is Friday the 7th.
    expect(next(TUE, 'FREQ=WEEKLY;BYDAY=MO,FR')).toBe('2026-08-07')
  })

  it('steps monthly on the same day of the month', () => {
    expect(next('2026-08-04', 'FREQ=MONTHLY')).toBe('2026-09-04')
  })

  it('skips a month that has no such day rather than sliding into the next one', () => {
    // 31 Jan monthly: February has no 31st, so the next occurrence is 31 March.
    expect(next('2026-01-31', 'FREQ=MONTHLY')).toBe('2026-03-31')
  })

  it('resolves an ordinal weekday', () => {
    expect(next(TUE, 'FREQ=MONTHLY;BYDAY=1MO')).toBe('2026-09-07')
  })

  it('resolves a negative ordinal as counting back from the end of the month', () => {
    expect(next('2026-08-01', 'FREQ=MONTHLY;BYDAY=-1FR')).toBe('2026-08-28')
  })

  it('steps yearly on the same month and day', () => {
    expect(next(TUE, 'FREQ=YEARLY')).toBe('2027-08-04')
  })

  it('reports the end of a series bounded by UNTIL', () => {
    expect(next('2026-08-11', 'FREQ=WEEKLY;UNTIL=20260812')).toBeNull()
    expect(problem('2026-08-11', 'FREQ=WEEKLY;UNTIL=20260812')).toMatch(/series ended on 2026-08-12/)
  })

  it('still schedules inside UNTIL', () => {
    expect(next(TUE, 'FREQ=WEEKLY;UNTIL=20261231')).toBe('2026-08-11')
  })

  it('rejects a date it cannot read', () => {
    expect(problem('not-a-date', 'FREQ=DAILY')).toMatch(/is not a date/)
  })

  it('passes the parse problem through rather than inventing a schedule', () => {
    expect(problem(TUE, 'FREQ=DAILY;COUNT=3')).toMatch(/COUNT/)
  })
})
