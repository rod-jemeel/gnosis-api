/**
 * Claim-support assessment tests (spec §20.5 CLAIM-01..CLAUIM-06
 * essentials). Per-file env pins claim checking on; the fetch helper
 * returns Choice-shaped assessments keyed claim_<ordinal>.
 */

process.env.JEV_CLAIM_CHECK_MODE = 'on'
process.env.TYPESAFE_API_KEY = 'test-key'
process.env.JEV_ALLOWED_WORKSPACE_IDS = '11111111-1111-4111-8111-111111111101'

const { test } = await import('node:test')
const assert = (await import('node:assert/strict')).default
const { assessClaims, CLAIM_LABELS } = await import('../../src/services/jev/claim-support.ts')

const WS = '11111111-1111-4111-8111-111111111101'

const CLAIMS = [
  { ordinal: 1, text: 'The office opens at 09:00.', evidenceIds: ['E1'] },
  { ordinal: 2, text: 'The device restarts itself weekly.', evidenceIds: ['E2'] },
]

const EVIDENCE = [
  { evidenceId: 'E1', quote: 'The office is open from 09:00 to 17:00 on weekdays.' },
  { evidenceId: 'E2', quote: 'Rainfall in the region averages 900mm annually.' },
]

function assessmentFetch(labels, confidence = 0.9) {
  let calls = 0
  let lastBody = null
  const fetchImpl = async (_url, init) => {
    calls++
    lastBody = JSON.parse(init.body)
    const answers = {}
    for (const key of Object.keys(lastBody.questions)) {
      const ordinal = Number(key.split('_')[1])
      const label = labels[ordinal] ?? 'insufficient'
      const probabilities = {}
      for (const l of CLAIM_LABELS) probabilities[l] = l === label ? confidence : (1 - confidence) / 3
      answers[key] = { label, confidence, probabilities }
    }
    return new Response(
      JSON.stringify({ model: 'jev-latest-2026-01', answers }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }
  return { fetchImpl, calls: () => calls, lastBody: () => lastBody }
}

test('CLAIM-01: each claim is judged only against its own cited evidence', async () => {
  const { fetchImpl, lastBody } = assessmentFetch({ 1: 'supported', 2: 'insufficient' })
  const { assessments, run } = await assessClaims({
    runId: 'r1',
    workspaceId: WS,
    claims: CLAIMS,
    evidence: EVIDENCE,
    deadlineMs: 500,
    fetchImpl,
  })
  assert.equal(run.status, 'applied')
  assert.equal(run.assessedCount, 2)
  // Claim 2 cites E2 (rainfall), so its assessment must be insufficient
  // even though E1 (office hours) would have supported a time claim.
  assert.equal(assessments.get(2)?.relation, 'insufficient')
  // The group binding: question claim_2 only carries E2's quote.
  const state = lastBody().state
  const group2 = state.claims.find((c) => c.ordinal === 2)
  assert.equal(group2.evidence.length, 1)
  assert.ok(group2.evidence[0].includes('Rainfall'))
})

test('CLAIM-04: provider failure is not_evaluated, never supported', async () => {
  const fetchImpl = async () => new Response('down', { status: 500 })
  const { assessments, run } = await assessClaims({
    runId: 'r2',
    workspaceId: WS,
    claims: CLAIMS,
    evidence: EVIDENCE,
    deadlineMs: 500,
    fetchImpl,
  })
  assert.equal(run.status, 'fallback')
  for (const claim of CLAIMS) {
    const a = assessments.get(claim.ordinal)
    assert.equal(a.semanticStatus, 'not_evaluated')
    assert.notEqual(a.relation, 'supported')
  }
})

test('CLAIM-03: a group over budget is not_evaluated, others still assess', async () => {
  const bigClaims = [
    { ordinal: 1, text: 'small claim', evidenceIds: ['E1'] },
    { ordinal: 2, text: 'huge claim ' + 'x'.repeat(6000), evidenceIds: ['E2'] },
  ]
  const { fetchImpl } = assessmentFetch({ 1: 'supported', 2: 'contradicted' })
  const { assessments, run } = await assessClaims({
    runId: 'r3',
    workspaceId: WS,
    claims: bigClaims,
    evidence: EVIDENCE,
    deadlineMs: 500,
    maxGroupBytes: 2000,
    fetchImpl,
  })
  assert.equal(run.status, 'applied')
  assert.equal(assessments.get(1)?.semanticStatus, 'assessed')
  assert.equal(assessments.get(2)?.semanticStatus, 'not_evaluated')
  assert.equal(assessments.get(2)?.reason, 'input_budget_exceeded')
})

test('CLAIM-05/06: assessed claims keep citation validity separate and advisory status', async () => {
  const { fetchImpl } = assessmentFetch({ 1: 'supported', 2: 'insufficient' })
  const { assessments } = await assessClaims({
    runId: 'r4',
    workspaceId: WS,
    claims: CLAIMS,
    evidence: EVIDENCE,
    deadlineMs: 500,
    fetchImpl,
  })
  for (const claim of CLAIMS) {
    const a = assessments.get(claim.ordinal)
    assert.equal(a.citationValidity, 'valid')
    if (a.semanticStatus === 'assessed') {
      assert.equal(a.decisionStatus, a.relation === 'supported' ? 'advisory' : 'needs_review')
    }
  }
})
