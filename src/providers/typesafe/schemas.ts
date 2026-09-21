/**
 * Runtime validation of the TypeSafe Score response (spec §9.5).
 *
 * Network data is unknown. The whole batch is rejected on any invalid
 * answer — no partial application. Valid billing metadata is kept
 * separate from judgment validity: usage can be present on a rejected
 * payload, and missing usage is `unavailable`, never zero.
 */

import { z } from 'zod'
import type { ScoreQuestion, TypesafeRequest, TypesafeUsage } from './types.js'

const finite = z.number().refine((n) => Number.isFinite(n), 'must be finite')

const unit = finite.pipe(z.number().min(0).max(1))
const probabilityKeySchema = z.object({
  score: finite.pipe(z.number().min(0).max(3)),
  confidence: unit,
  // Strict shape: exactly the four level keys, no extras (RANK-06).
  probabilities: z
    .object({ '0': unit, '1': unit, '2': unit, '3': unit })
    .strict(),
})

export interface ValidatedScoreAnswer {
  score: number
  confidence: number
  probabilities: Record<'0' | '1' | '2' | '3', number>
}

export interface ScoreBatchValidation {
  ok: boolean
  /** Safe reject reason for diagnostics; never upstream error text. */
  reason: 'invalid_response' | 'model_mismatch' | null
  answers: Map<string, ValidatedScoreAnswer>
  returnedModel: string | null
  usage: TypesafeUsage
}

const SUM_TOLERANCE = 0.01
const CONSISTENCY_TOLERANCE = 0.05

function safeNonNegativeInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value
  }
  return null
}

/**
 * Validate a complete Score batch against the exact requested keys.
 * A dev model alias (e.g. jev-latest) accepts any nonempty returned
 * model but records it; a pinned model must match exactly (§8.4).
 */
export function validateScoreBatch(
  request: TypesafeRequest,
  expectedKeys: string[],
  responseBody: unknown,
  opts: { requestedModel: string; modelAliasAllowed: boolean }
): ScoreBatchValidation {
  const usageUnknown: TypesafeUsage = {
    inputTokens: null,
    outputTokens: null,
    status: 'unavailable',
  }

  if (typeof responseBody !== 'object' || responseBody === null) {
    return { ok: false, reason: 'invalid_response', answers: new Map(), returnedModel: null, usage: usageUnknown }
  }
  const body = responseBody as Record<string, unknown>

  const returnedModel =
    typeof body.model === 'string' && body.model.trim().length > 0
      ? body.model.trim()
      : null
  if (!returnedModel) {
    return { ok: false, reason: 'invalid_response', answers: new Map(), returnedModel: null, usage: usageUnknown }
  }
  if (!opts.modelAliasAllowed && returnedModel !== opts.requestedModel) {
    return { ok: false, reason: 'model_mismatch', answers: new Map(), returnedModel, usage: usageUnknown }
  }

  // Usage is billing metadata, not judgment validity.
  const rawUsage = body.usage as Record<string, unknown> | undefined
  const inputTokens = rawUsage ? safeNonNegativeInt(rawUsage.inputTokens ?? rawUsage.input_tokens) : null
  const outputTokens = rawUsage ? safeNonNegativeInt(rawUsage.outputTokens ?? rawUsage.output_tokens) : null
  const usage: TypesafeUsage =
    inputTokens === null && outputTokens === null
      ? usageUnknown
      : { inputTokens, outputTokens, status: 'known' }

  const answersRaw = body.answers
  if (typeof answersRaw !== 'object' || answersRaw === null) {
    return { ok: false, reason: 'invalid_response', answers: new Map(), returnedModel, usage }
  }
  const answers = answersRaw as Record<string, unknown>

  // Exactly the requested answer keys: missing and extra both reject.
  const expected = new Set(expectedKeys)
  const actual = new Set(Object.keys(answers))
  if (actual.size !== expected.size || expectedKeys.some((k) => !actual.has(k))) {
    return { ok: false, reason: 'invalid_response', answers: new Map(), returnedModel, usage }
  }

  const validated = new Map<string, ValidatedScoreAnswer>()
  for (const key of expectedKeys) {
    const parsed = probabilityKeySchema.safeParse(answers[key])
    if (!parsed.success) {
      return { ok: false, reason: 'invalid_response', answers: new Map(), returnedModel, usage }
    }
    const { score, confidence, probabilities } = parsed.data
    const sum = probabilities['0'] + probabilities['1'] + probabilities['2'] + probabilities['3']
    if (Math.abs(sum - 1) > SUM_TOLERANCE) {
      return { ok: false, reason: 'invalid_response', answers: new Map(), returnedModel, usage }
    }
    const expectedScore = Number(
      Object.entries(probabilities).reduce((acc, [level, p]) => acc + Number(level) * p, 0).toFixed(6)
    )
    if (Math.abs(score - expectedScore) > CONSISTENCY_TOLERANCE) {
      return { ok: false, reason: 'invalid_response', answers: new Map(), returnedModel, usage }
    }
    validated.set(key, { score, confidence, probabilities })
  }

  return { ok: true, reason: null, answers: validated, returnedModel, usage }
}

/** Human-visible shape of one Score question, for tests and docs. */
export function describeScoreQuestion(question: ScoreQuestion): string {
  return `${question.type}: ${question.instructions} [${question.criteria.join(' | ')}]`
}
