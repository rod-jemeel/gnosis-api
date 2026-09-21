/**
 * Jev policy: validated configuration and the external-processing
 * decision (spec §7.2, §8).
 *
 * Configuration is parsed leniently: invalid optional Jev configuration
 * disables egress and exposes a degraded state instead of preventing
 * the baseline API from starting (§8.2). The kill switch overrides
 * every stage; an API key alone can never enable anything (INV-06).
 */

import { z } from 'zod'
import type { SafeReason } from '../../providers/typesafe/types.js'

export type JevMode = 'off' | 'shadow' | 'on'

export interface JevConfig {
  mode: JevMode
  killSwitch: boolean
  apiKey: string | null
  model: string
  allowedWorkspaceIds: string[]
  timeoutMs: number
  maxCandidates: number
  maxExcerptBytes: number
  maxRequestBytes: number
  maxResponseBytes: number
  maxInflightPerWorkspace: number
  maxInflightPerCredential: number
  shadowSampleRate: number
}

export interface JevConfigState {
  valid: boolean
  /** Safe issue labels; never include values that could leak secrets. */
  issues: string[]
  config: JevConfig
}

const booleanEnv = z
  .string()
  .refine((v) => ['true', 'false', '1', '0'].includes(v.trim().toLowerCase()))

const uuid = z.string().uuid()

export function parseJevConfig(env: NodeJS.ProcessEnv): JevConfigState {
  const issues: string[] = []

  const modeRaw = (env.JEV_MODE ?? 'off').trim().toLowerCase()
  const mode: JevMode =
    modeRaw === 'off' || modeRaw === 'shadow' || modeRaw === 'on'
      ? (modeRaw as JevMode)
      : (() => {
          issues.push('invalid_mode')
          return 'off' as JevMode
        })()

  const killSwitchRaw = booleanEnv.safeParse(env.JEV_KILL_SWITCH ?? 'false')
  if (!killSwitchRaw.success) issues.push('invalid_kill_switch')
  const killSwitch = killSwitchRaw.success
    ? ['true', '1'].includes((env.JEV_KILL_SWITCH ?? 'false').trim().toLowerCase())
    : false

  const apiKey = env.TYPESAFE_API_KEY?.trim() ? env.TYPESAFE_API_KEY.trim() : null

  const modelRaw = (env.TYPESAFE_MODEL ?? 'jev-latest').trim()
  if (modelRaw.length === 0) issues.push('invalid_model')
  const model = modelRaw.length > 0 ? modelRaw : 'jev-latest'

  const allowedWorkspaceIds: string[] = []
  for (const part of (env.JEV_ALLOWED_WORKSPACE_IDS ?? '').split(',')) {
    const id = part.trim()
    if (id.length === 0) continue
    // Exact UUID allowlist; no wildcard forms (CFG-03).
    if (id === '*' || !uuid.safeParse(id).success) {
      issues.push('invalid_allowed_workspace')
      continue
    }
    allowedWorkspaceIds.push(id)
  }

  const numeric = (name: string, min: number, max: number | null, fallback: number): number => {
    // Absent optional variables take the documented default; only a
    // PRESENT invalid value marks the configuration degraded.
    if (env[name] === undefined || env[name] === '') {
      return fallback
    }
    const raw = Number(env[name])
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < min || (max !== null && raw > max)) {
      issues.push(`invalid_${name.toLowerCase()}`)
      return fallback
    }
    return raw
  }

  const timeoutMs = numeric('JEV_TIMEOUT_MS', 50, 5000, 1500)
  const maxCandidates = numeric('JEV_MAX_CANDIDATES', 1, null, 20)
  const maxExcerptBytes = numeric('JEV_MAX_EXCERPT_BYTES', 64, null, 1600)
  const maxRequestBytes = numeric('JEV_MAX_REQUEST_BYTES', 1024, null, 48000)
  const maxResponseBytes = numeric('JEV_MAX_RESPONSE_BYTES', 1024, null, 65536)
  const maxInflightPerWorkspace = numeric('JEV_MAX_INFLIGHT_PER_WORKSPACE', 1, null, 2)
  const maxInflightPerCredential = numeric('JEV_MAX_INFLIGHT_PER_CREDENTIAL', 1, null, 4)

  const rateRaw = env.JEV_SHADOW_SAMPLE_RATE === undefined ? 1 : Number(env.JEV_SHADOW_SAMPLE_RATE)
  let shadowSampleRate = 1
  if (!Number.isFinite(rateRaw) || rateRaw < 0 || rateRaw > 1) {
    issues.push('invalid_shadow_sample_rate')
    shadowSampleRate = 1
  } else {
    shadowSampleRate = rateRaw
  }

  return {
    valid: issues.length === 0,
    issues,
    config: {
      mode,
      killSwitch,
      apiKey,
      model,
      allowedWorkspaceIds,
      timeoutMs,
      maxCandidates,
      maxExcerptBytes,
      maxRequestBytes,
      maxResponseBytes,
      maxInflightPerWorkspace,
      maxInflightPerCredential,
      shadowSampleRate,
    },
  }
}

/** Process-wide, validated once (spec §8.2: one validated object). */
export const jevConfigState = parseJevConfig(process.env)

/** Development alias accepts any nonempty returned model (§8.4). */
export function modelAliasAllowed(config: JevConfig): boolean {
  return config.model === 'jev-latest'
}

export interface ProcessingDecisionInput {
  invocationId: string
  workspaceId: string
  candidateCount: number
}

export interface ProcessingDecision {
  allowed: boolean
  /** Safe reason for diagnostics when not allowed; null when allowed. */
  reason: SafeReason | null
}

/**
 * The full external-processing decision (§7.2). Every condition must
 * hold: stage enabled, kill switch off, workspace allowlisted, key
 * present, config valid, enough candidates, and deterministic shadow
 * sampling. Capacity and breaker are evaluated separately (§10.5).
 */
export function resolveProcessingDecision(
  configState: JevConfigState,
  input: ProcessingDecisionInput
): ProcessingDecision {
  const config = configState.config
  if (config.mode === 'off') return { allowed: false, reason: 'off' }
  if (config.killSwitch) return { allowed: false, reason: 'kill_switch' }
  if (!configState.valid) return { allowed: false, reason: 'invalid_configuration' }
  if (!config.apiKey) return { allowed: false, reason: 'missing_key' }
  if (!config.allowedWorkspaceIds.includes(input.workspaceId)) {
    return { allowed: false, reason: 'workspace_not_allowed' }
  }
  if (input.candidateCount < 2) {
    return { allowed: false, reason: 'too_few_candidates' }
  }
  if (
    config.mode === 'shadow' &&
    !deterministicSample(input.invocationId, config.shadowSampleRate)
  ) {
    return { allowed: false, reason: 'off' }
  }
  return { allowed: true, reason: null }
}

/** Deterministic sampling so retries of a run keep the same decision. */
export function deterministicSample(invocationId: string, rate: number): boolean {
  if (rate >= 1) return true
  if (rate <= 0) return false
  let hash = 0x811c9dc5
  for (let i = 0; i < invocationId.length; i++) {
    hash ^= invocationId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) / 0x100000000 < rate
}
