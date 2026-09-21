/**
 * TypeSafe transport and judgment types (spec §9, §14).
 *
 * These describe the researched wire contract from the official SDK
 * sources; live endpoint behavior is a separate release gate (§28).
 */

/** Safe reason taxonomy — a documented finite set (spec §17.2). */
export type SafeReason =
  | 'off'
  | 'kill_switch'
  | 'workspace_not_allowed'
  | 'processing_not_approved'
  | 'missing_key'
  | 'invalid_configuration'
  | 'too_few_candidates'
  | 'too_many_candidates'
  | 'duplicate_candidates'
  | 'request_too_large'
  | 'response_too_large'
  | 'timeout'
  | 'rate_limited'
  | 'authentication_failed'
  | 'provider_unavailable'
  | 'invalid_response'
  | 'model_mismatch'
  | 'capacity_exhausted'
  | 'budget_exhausted'
  | 'source_changed'
  | 'authorization_revoked'
  | 'cancelled'
  | 'stale_worker'

export interface ScoreQuestion {
  type: 'score'
  /** Instructions must identify the state member and judgment explicitly. */
  instructions: string
  criteria: [string, string, string, string]
}

export interface TypesafeRequest {
  model: string
  state: Record<string, unknown>
  questions: Record<string, ScoreQuestion>
}

export interface TypesafeUsage {
  inputTokens: number | null
  outputTokens: number | null
  /** known when the provider reported counts; unavailable is not zero. */
  status: 'known' | 'unavailable'
}

export interface TransportSuccess {
  ok: true
  httpStatus: number
  body: unknown
  returnedModel: string | null
  usage: TypesafeUsage
}

export interface TransportFailure {
  ok: false
  reason: SafeReason
  /** Sanitized HTTP status for internal debugging; never raw error text. */
  httpStatus: number | null
}

export type TransportResult = TransportSuccess | TransportFailure

export interface TransportOptions {
  /** Injected for tests; production uses globalThis.fetch. */
  fetchImpl?: typeof fetch
  /** One total deadline covering connection, headers, and body (§10.2). */
  deadlineMs: number
  /** Parent cancellation (run cancellation) — authoritative. */
  signal?: AbortSignal
  maxRequestBytes: number
  maxResponseBytes: number
}

export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
