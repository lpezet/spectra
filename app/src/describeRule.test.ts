import { describe, expect, it } from 'vitest'
import { describeRule } from './describeRule.js'

const say = (rule: string) => {
  const result = describeRule(rule)
  return 'text' in result ? result.text : `PROBLEM: ${result.problem}`
}

describe('describeRule', () => {
  it('says the plain frequencies', () => {
    expect(say('FREQ=DAILY')).toBe('daily')
    expect(say('FREQ=WEEKLY')).toBe('weekly')
    expect(say('FREQ=MONTHLY')).toBe('monthly')
    expect(say('FREQ=YEARLY')).toBe('yearly')
  })

  it('prefers "every other" to "every 2"', () => {
    expect(say('FREQ=DAILY;INTERVAL=2')).toBe('every other day')
    expect(say('FREQ=MONTHLY;INTERVAL=2')).toBe('every other month')
  })

  it('counts larger intervals', () => {
    expect(say('FREQ=DAILY;INTERVAL=3')).toBe('every 3 days')
    expect(say('FREQ=WEEKLY;INTERVAL=6')).toBe('every 6 weeks')
  })

  it('names the weekdays of a weekly rule', () => {
    expect(say('FREQ=WEEKLY;BYDAY=MO')).toBe('every Monday')
    expect(say('FREQ=WEEKLY;BYDAY=MO,FR')).toBe('every Monday and Friday')
    expect(say('FREQ=WEEKLY;BYDAY=MO,WE,FR')).toBe('every Monday, Wednesday and Friday')
  })

  it('says "every other Tuesday" rather than "every other week on Tuesday"', () => {
    expect(say('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU')).toBe('every other Tuesday')
  })

  it('falls back to naming the cadence when several days share a longer interval', () => {
    // "every other Monday and Friday" would be ambiguous about what repeats.
    expect(say('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR')).toBe('every other week on Monday and Friday')
    expect(say('FREQ=WEEKLY;INTERVAL=3;BYDAY=MO')).toBe('every 3 weeks on Monday')
  })

  it('reads monthly ordinals', () => {
    expect(say('FREQ=MONTHLY;BYDAY=1MO')).toBe('the first Monday of each month')
    expect(say('FREQ=MONTHLY;BYDAY=3WE')).toBe('the third Wednesday of each month')
  })

  it('reads negative ordinals as counting from the end', () => {
    expect(say('FREQ=MONTHLY;BYDAY=-1FR')).toBe('the last Friday of each month')
    expect(say('FREQ=MONTHLY;BYDAY=-2FR')).toBe('the second to last Friday of each month')
  })

  it('combines an ordinal with an interval', () => {
    expect(say('FREQ=MONTHLY;INTERVAL=2;BYDAY=1MO')).toBe('the first Monday of every other month')
    expect(say('FREQ=MONTHLY;INTERVAL=3;BYDAY=-1FR')).toBe('the last Friday of every 3 months')
  })

  it('appends an end date', () => {
    expect(say('FREQ=WEEKLY;UNTIL=20261231')).toBe('weekly until 31 December 2026')
    expect(say('FREQ=WEEKLY;BYDAY=TU;UNTIL=20260901')).toBe('every Tuesday until 1 September 2026')
  })

  it('accepts the RRULE: prefix and any casing, like the scheduler', () => {
    expect(say('RRULE:freq=weekly;byday=mo')).toBe('every Monday')
  })

  it('reports anything the scheduler would refuse, rather than inventing a phrase', () => {
    // Sharing the parser is what guarantees this — a phrase can never describe a rule the
    // app would not actually run.
    expect(say('FREQ=DAILY;COUNT=5')).toMatch(/^PROBLEM: COUNT/)
    expect(say('every 2 weeks')).toMatch(/^PROBLEM:/)
    expect(say('')).toMatch(/^PROBLEM:/)
  })
})
