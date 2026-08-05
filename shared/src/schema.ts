/**
 * Runtime validation for files a human may have edited by hand. The goal is a
 * readable message pointing at the offending field, never a stack trace.
 */
import { z } from 'zod'
import { TERM_TYPES } from './types.js'
import type { Changeset, Question, Term } from './types.js'
import { describeValueTypeError, isValueType } from './valueType.js'

const termName = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a bare identifier (letters, digits, underscore)')

const valueType = z.string().superRefine((raw, ctx) => {
  if (!isValueType(raw)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: describeValueTypeError(raw) })
  }
})

export const attributeSchema = z
  .object({
    name: z.string().min(1),
    valueType,
    default: z.unknown().optional(),
    optional: z.boolean().optional(),
  })
  .strict()

export const termSchema = z
  .object({
    name: termName,
    type: z.enum(TERM_TYPES as unknown as [string, ...string[]]),
    spec: z.string(),
    parent: termName.nullable().default(null),
    tags: z.array(z.string()).default([]),
    attributes: z.array(attributeSchema).default([]),
  })
  .strict()

const opSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('add_entity'),
      term: termName,
      termType: z.enum(TERM_TYPES as unknown as [string, ...string[]]).optional(),
      parent: termName.nullable().optional(),
      spec: z.string(),
      tags: z.array(z.string()).optional(),
      attributes: z.array(attributeSchema).optional(),
    })
    .strict(),
  z.object({ op: z.literal('remove_entity'), term: termName }).strict(),
  z.object({ op: z.literal('add_attribute'), term: termName, attribute: attributeSchema }).strict(),
  z
    .object({ op: z.literal('remove_attribute'), term: termName, attribute: z.string().min(1) })
    .strict(),
  z.object({ op: z.literal('modify_spec'), term: termName, spec: z.string() }).strict(),
])

export const changesetSchema = z
  .object({
    id: z.string().min(1),
    summary: z.string(),
    ops: z.array(opSchema),
    tests: z.array(z.string()).default([]),
    fromQuestion: z.string().min(1).optional(),
  })
  .strict()

export const proposalSchema = z
  .object({
    summary: z.string(),
    ops: z.array(opSchema),
    tests: z.array(z.string()).default([]),
  })
  .strict()

export const questionSchema = z
  .object({
    id: z.string().min(1),
    asks: z.string().min(1),
    because: z.string().min(1),
    raisedBy: z
      .object({
        pass: z.string().min(1),
        file: z.string().optional(),
        terms: z.array(termName).default([]),
      })
      .strict(),
    options: z
      .array(
        z
          .object({
            label: z.string().min(1),
            detail: z.string().optional(),
            proposal: proposalSchema.nullable().default(null),
          })
          .strict(),
      )
      .default([]),
    answer: z
      .object({
        chose: z.string().nullable(),
        note: z.string(),
        answeredAt: z.string(),
        changesetId: z.string().optional(),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((question, ctx) => {
    // An answer naming an option that does not exist would silently lose the decision.
    const chose = question.answer?.chose
    if (chose && !question.options.some((option) => option.label === chose)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['answer', 'chose'],
        message: `no option labelled "${chose}"`,
      })
    }
  })

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
}

export function parseTerm(data: unknown): ParseResult<Term> {
  const result = termSchema.safeParse(data)
  return result.success
    ? { ok: true, value: result.data as Term }
    : { ok: false, errors: formatIssues(result.error) }
}

export function parseChangeset(data: unknown): ParseResult<Changeset> {
  const result = changesetSchema.safeParse(data)
  return result.success
    ? { ok: true, value: result.data as Changeset }
    : { ok: false, errors: formatIssues(result.error) }
}

export function parseQuestion(data: unknown): ParseResult<Question> {
  const result = questionSchema.safeParse(data)
  return result.success
    ? { ok: true, value: result.data as Question }
    : { ok: false, errors: formatIssues(result.error) }
}
