/**
 * Jev policy tests (spec §20.1 CFG-01..CFG-06): configuration parsing,
 * kill switch, allowlist strictness, and deterministic sampling.
 * parseJevConfig takes an explicit env object — no process state.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJevConfig, resolveProcessingDecision } from '../../src/services/jev/policy.ts'

const WS = '11111111-1111-4111-8111-111111111101'
const OTHER_WS = '22222222-2222-4222-8222-222222222202'

function validEnv(overrides = {}) {
  return {
    JEV_MODE: 'on',
    JEV_KILL_SWITCH: 'false',
    TYPESAFE_API_KEY: 'test-key',
    JEV_ALLOWED_WORKSPACE_IDS: WS,
    ...overrides,
  }
}

test('CFG-01: mode off disables processing even with a valid key', () => {
  const state = parseJevConfig(validEnv({ JEV_MODE: 'off' }))
  const decision = resolveProcessingDecision(state, {
    invocationId: 'inv',
    workspaceId: WS,
    candidateCount: 10,
  })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, 'off')
})

test('CFG-02: kill switch overrides an enabled mode and allowlist', () => {
  const state = parseJevConfig(validEnv({ JEV_KILL_SWITCH: 'true' }))
  assert.equal(state.config.killSwitch, true)
  const decision = resolveProcessingDecision(state, {
    invocationId: 'inv',
    workspaceId: WS,
    candidateCount: 10,
  })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, 'kill_switch')
})

test('CFG-03: empty allowlist and wildcard values cannot enable a workspace', () => {
  const empty = parseJevConfig(validEnv({ JEV_ALLOWED_WORKSPACE_IDS: '' }))
  assert.deepEqual(empty.config.allowedWorkspaceIds, [])
  assert.equal(
    resolveProcessingDecision(empty, { invocationId: 'i', workspaceId: WS, candidateCount: 5 }).reason,
    'workspace_not_allowed'
  )

  const wildcard = parseJevConfig(validEnv({ JEV_ALLOWED_WORKSPACE_IDS: '*' }))
  // The wildcard entry is dropped as invalid, never treated as a match,
  // and marks the whole configuration degraded (§8.2 accepts only valid
  // UUIDs) — which denies before the workspace check is even reached.
  assert.deepEqual(wildcard.config.allowedWorkspaceIds, [])
  assert.equal(wildcard.issues.includes('invalid_allowed_workspace'), true)
  const wildcardDecision = resolveProcessingDecision(wildcard, {
    invocationId: 'i',
    workspaceId: WS,
    candidateCount: 5,
  })
  assert.equal(wildcardDecision.allowed, false)
  assert.equal(wildcardDecision.reason, 'invalid_configuration')
})

test('CFG-04: missing key and malformed config disable egress without throwing', () => {
  const noKey = parseJevConfig(validEnv({ TYPESAFE_API_KEY: '' }))
  assert.equal(noKey.config.apiKey, null)
  assert.equal(
    resolveProcessingDecision(noKey, { invocationId: 'i', workspaceId: WS, candidateCount: 5 }).reason,
    'missing_key'
  )

  const malformed = parseJevConfig(
    validEnv({ JEV_TIMEOUT_MS: '999999', JEV_MAX_CANDIDATES: 'not-a-number' })
  )
  assert.equal(malformed.valid, false)
  assert.equal(
    malformed.config.timeoutMs,
    1500,
    'invalid value falls back to the documented default'
  )
  assert.equal(
    resolveProcessingDecision(malformed, { invocationId: 'i', workspaceId: WS, candidateCount: 5 }).reason,
    'invalid_configuration'
  )
})

test('CFG-05: JEV_MODE governs reranking only — decision is scoped to the rerank stage', () => {
  // Shadow mode resolves allowed for the rerank stage; there is no
  // master switch that would also enable routing or claim assessment.
  const shadow = parseJevConfig(validEnv({ JEV_MODE: 'shadow' }))
  assert.equal(shadow.config.mode, 'shadow')
})

test('CFG-06: hard bounds — timeout outside 50..5000 cannot bypass', () => {
  const low = parseJevConfig(validEnv({ JEV_TIMEOUT_MS: '10' }))
  assert.equal(low.config.timeoutMs, 1500)
  const high = parseJevConfig(validEnv({ JEV_TIMEOUT_MS: '6000' }))
  assert.equal(high.config.timeoutMs, 1500)
  const fractional = parseJevConfig(validEnv({ JEV_MAX_CANDIDATES: '2.5' }))
  assert.equal(fractional.config.maxCandidates, 20)
})

test('too few candidates skips before any egress decision', () => {
  const state = parseJevConfig(validEnv())
  const decision = resolveProcessingDecision(state, {
    invocationId: 'i',
    workspaceId: WS,
    candidateCount: 1,
  })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, 'too_few_candidates')
})

test('a workspace not on the exact allowlist is denied', () => {
  const state = parseJevConfig(validEnv())
  const decision = resolveProcessingDecision(state, {
    invocationId: 'i',
    workspaceId: OTHER_WS,
    candidateCount: 10,
  })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, 'workspace_not_allowed')
})

test('shadow sampling is deterministic for the same invocation id', async () => {
  const { deterministicSample } = await import('../../src/services/jev/policy.ts')
  const a = deterministicSample('inv-123', 0.5)
  const b = deterministicSample('inv-123', 0.5)
  assert.equal(a, b)
  assert.equal(deterministicSample('inv-123', 0), false)
  assert.equal(deterministicSample('inv-123', 1), true)
})
