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

export interface ValidatedChoiceAnswer {
  label: string
  confidence: number
  probabilities: Record<string, number>
}

export interface ChoiceBatchValidation {
  ok: boolean
  reason: 'invalid_response' | 'model_mismatch' | null
  answers: Map<string, ValidatedChoiceAnswer>
  returnedModel: string | null
  usage: TypesafeUsage
}

/**
 * Validate a Choice batch: labels must be members of the allowed set,
 * probability keys must be exactly the allowed labels, each in [0,1],
 * summing to 1 within tolerance. Unknown labels reject the batch.
 */
export function validateChoiceBatch(
  request: TypesafeRequest,
  expectedKeys: string[],
  allowedLabels: readonly string[],
  responseBody: unknown,
  opts: { requestedModel: string; modelAliasAllowed: boolean }
): ChoiceBatchValidation {
  const usageUnknown: TypesafeUsage = { inputTokens: null, outputTokens: null, status: 'unavailable' }
  const invalid = (): ChoiceBatchValidation => ({
    ok: false, reason: 'invalid_response', answers: new Map(), returnedModel: null, usage: usageUnknown,
  })

  if (typeof responseBody !== 'object' || responseBody === null) return invalid()
  const body = responseBody as Record<string, unknown>

  const returnedModel =
    typeof body.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : null
  if (!returnedModel) return invalid()
  if (!opts.modelAliasAllowed && returnedModel !== opts.requestedModel) {
    return { ok: false, reason: 'model_mismatch', answers: new Map(), returnedModel, usage: usageUnknown }
  }

  const rawUsage = body.usage as Record<string, unknown> | undefined
  const inputTokens = rawUsage ? safeNonNegativeInt(rawUsage.inputTokens ?? rawUsage.input_tokens) : null
  const outputTokens = rawUsage ? safeNonNegativeInt(rawUsage.outputTokens ?? rawUsage.output_tokens) : null
  const usage: TypesafeUsage =
    inputTokens === null && outputTokens === null
      ? usageUnknown
      : { inputTokens, outputTokens, status: 'known' }

  const answersRaw = body.answers
  if (typeof answersRaw !== 'object' || answersRaw === null) return invalid()
  const answers = answersRaw as Record<string, unknown>

  const expected = new Set(expectedKeys)
  const actual = new Set(Object.keys(answers))
  if (actual.size !== expected.size || expectedKeys.some((k) => !actual.has(k))) {
    return invalid()
  }

  const allowed = new Set(allowedLabels)
  const validated = new Map<string, ValidatedChoiceAnswer>()
  for (const key of expectedKeys) {
    const answer = answers[key]
    if (typeof answer !== 'object' || answer === null) return invalid()
    const a = answer as Record<string, unknown>
    const label = a.choice ?? a.label
    if (typeof label !== 'string' || !allowed.has(label)) return invalid()
    const confidence = a.confidence
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return invalid()
    }
    const probabilities = a.probabilities
    if (typeof probabilities !== 'object' || probabilities === null) return invalid()
    const p = probabilities as Record<string, unknown>
    // The provider omits zero-mass labels: keys must be a subset of the
    // allowed labels; unknown labels reject.
    const pKeys = Object.keys(p)
    if (pKeys.length > allowed.size || !pKeys.every((k) => allowed.has(k))) return invalid()
    let sum = 0
    const cleaned: Record<string, number> = {}
    for (const k of pKeys) {
      const v = p[k]
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return invalid()
      sum += v
      cleaned[k] = v
    }
    if (Math.abs(sum - 1) > SUM_TOLERANCE) return invalid()
    validated.set(key, { label, confidence, probabilities: cleaned })
  }

  return { ok: true, reason: null, answers: validated, returnedModel, usage }
}
