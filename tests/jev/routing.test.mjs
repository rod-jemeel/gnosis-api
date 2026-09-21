/**
 * Routing service tests (spec §20.5 ROUTE-01..ROUTE-04 essentials).
 * Per-file env pins routing on; the score-style fetch helper returns a
 * Choice-shaped response.
 */

process.env.JEV_ROUTING_MODE = 'on'
process.env.TYPESAFE_API_KEY = 'test-key'
process.env.JEV_ALLOWED_WORKSPACE_IDS = '11111111-1111-4111-8111-111111111101'

const { test } = await import('node:test')
const assert = (await import('node:assert/strict')).default
const { routeRequest, ROUTES } = await import('../../src/services/jev/routing.ts')

const WS = '11111111-1111-4111-8111-111111111101'

function choiceFetch(label, confidence = 0.9) {
  let calls = 0
  const fetchImpl = async (_url, init) => {
    calls++
    const body = JSON.parse(init.body)
    if (!body.questions.route || body.questions.route.type !== 'choice') {
      throw new Error('request did not carry a choice question')
    }
    const probabilities = {}
    for (const l of Object.keys(ROUTES)) probabilities[l] = l === label ? confidence : (1 - confidence) / (Object.keys(ROUTES).length - 1)
    return new Response(
      JSON.stringify({ model: 'jev-latest-2026-01', answers: { route: { label, confidence, probabilities } } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }
  return { fetchImpl, calls: () => calls }
}

test('ROUTE-02: applied routing returns a registered label', async () => {
  const { fetchImpl, calls } = choiceFetch('knowledge_question')
  const decision = await routeRequest({
    runId: 'r1',
    workspaceId: WS,
    question: 'What is the procedure?',
    recentQuestions: [],
    deadlineMs: 500,
    fetchImpl,
  })
  assert.equal(decision.status, 'applied')
  assert.equal(decision.label, 'knowledge_question')
  assert.equal(calls(), 1)
})

test('ROUTE-03: workflow_proposal is not in the registry, so it can never be selected', async () => {
  assert.ok(!Object.keys(ROUTES).includes('workflow_proposal'))
})

test('ROUTE-03b: unknown labels are rejected and degrade to fallback', async () => {
  const { fetchImpl } = choiceFetch('execute_arbitrary_tool')
  const decision = await routeRequest({
    runId: 'r2',
    workspaceId: WS,
    question: 'delete everything',
    recentQuestions: [],
    deadlineMs: 500,
    fetchImpl,
  })
  assert.equal(decision.status, 'fallback')
  assert.equal(decision.reason, 'invalid_response')
  assert.equal(decision.label, null)
})

test('ROUTE-04: low confidence on executable routes degrades to unclear', async () => {
  const { fetchImpl } = choiceFetch('document_lookup', 0.3)
  const decision = await routeRequest({
    runId: 'r3',
    workspaceId: WS,
    question: 'the procedure thing',
    recentQuestions: [],
    deadlineMs: 500,
    fetchImpl,
  })
  assert.equal(decision.status, 'applied')
  assert.equal(decision.label, 'unclear')
})

test('provider failure falls back without a label', async () => {
  const fetchImpl = async () => new Response('nope', { status: 500 })
  const decision = await routeRequest({
    runId: 'r4',
    workspaceId: WS,
    question: 'anything',
    recentQuestions: [],
    deadlineMs: 500,
    fetchImpl,
  })
  assert.equal(decision.status, 'fallback')
  assert.equal(decision.label, null)
})
