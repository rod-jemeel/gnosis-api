/**
 * Shadow-mode tests (RANK-09): the counterfactual ranking is recorded
 * but user-facing selection stays exactly the baseline. Separate file
 * so the process env pins JEV_MODE=shadow.
 */

process.env.JEV_MODE = 'shadow'
process.env.TYPESAFE_API_KEY = 'test-key'
process.env.JEV_ALLOWED_WORKSPACE_IDS = '11111111-1111-4111-8111-111111111101'
process.env.JEV_TIMEOUT_MS = '200'

const { test } = await import('node:test')
const assert = (await import('node:assert/strict')).default
const { rerankCandidates } = await import('../../src/services/jev/rerank.ts')

const WS = '11111111-1111-4111-8111-111111111101'

function makeCandidates(n) {
  return Array.from({ length: n }, (_, i) => ({
    chunkId: `c${i + 1}`,
    documentId: 'd1',
    versionId: 'v1',
    buildId: 'b1',
    contentHash: `hash${i + 1}`,
    text: `passage text ${i + 1}`,
    baselineRank: i + 1,
  }))
}

test('shadow records the counterfactual but keeps baseline order', async () => {
  const candidates = makeCandidates(3)
  let calls = 0
  const fetchImpl = async (_url, init) => {
    calls++
    const body = JSON.parse(init.body)
    const answers = {}
    Object.keys(body.questions).forEach((key, index) => {
      const score = { c1: 1, c2: 3, c3: 2 }[`c${index + 1}`] ?? 0
      const probabilities = { '0': 0, '1': 0, '2': 0, '3': 0 }
      probabilities[String(Math.round(score))] = 1
      answers[key] = { score, confidence: 0.9, probabilities }
    })
    return new Response(JSON.stringify({ model: 'jev-latest-2026-01', answers }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const decision = await rerankCandidates(candidates, {
    runId: 'shadow-1',
    workspaceId: WS,
    question: 'shadow question',
    fetchImpl,
  })

  assert.equal(calls, 1, 'shadow still performs external processing (INV-07)')
  assert.equal(decision.status, 'shadow')
  assert.deepEqual(
    decision.orderedChunkIds,
    ['c1', 'c2', 'c3'],
    'user-facing selection is unchanged'
  )
  assert.deepEqual(
    decision.counterfactualChunkIds,
    ['c2', 'c3', 'c1'],
    'counterfactual order is recorded'
  )
})
