/**
 * Rerank orchestration tests (spec §20.3 RANK-01..RANK-04, RANK-09,
 * RANK-10, RANK-15) in apply mode. Per-file process isolation lets the
 * suite pin its own JEV_* environment before the modules initialize.
 */

process.env.JEV_MODE = 'on'
process.env.TYPESAFE_API_KEY = 'test-key'
process.env.JEV_ALLOWED_WORKSPACE_IDS = '11111111-1111-4111-8111-111111111101'
process.env.JEV_TIMEOUT_MS = '200'

const { test } = await import('node:test')
const assert = (await import('node:assert/strict')).default
const { rerankCandidates, RUBRIC_VERSION } = await import('../../src/services/jev/rerank.ts')

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

/** Fetch impl answering passage_i with scores by candidate id. */
function scoreFetch(scoreById) {
  let calls = 0
  let lastBody = null
  const fetchImpl = async (_url, init) => {
    calls++
    lastBody = JSON.parse(init.body)
    const answers = {}
    Object.keys(lastBody.questions).forEach((key, index) => {
      // passage_i maps to candidates[index] (input order binding).
      const chunkId = `c${index + 1}`
      const score = scoreById[chunkId] ?? 0
      const lower = Math.floor(score)
      const upper = Math.ceil(score)
      const t = score - lower
      const probabilities = { '0': 0, '1': 0, '2': 0, '3': 0 }
      if (lower !== upper) {
        probabilities[String(lower)] = 1 - t
        probabilities[String(upper)] = t
      } else {
        probabilities[String(lower)] = 1
      }
      answers[key] = { score, confidence: 0.9, probabilities }
    })
    return new Response(
      JSON.stringify({ model: 'jev-latest-2026-01', answers, usage: { inputTokens: 5, outputTokens: 1 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }
  return { fetchImpl, calls: () => calls, lastBody: () => lastBody }
}

test('applied mode reorders candidates by descending expected score', async () => {
  const candidates = makeCandidates(3)
  const { fetchImpl, calls } = scoreFetch({ c1: 1, c2: 3, c3: 2 })
  const decision = await rerankCandidates(candidates, {
    runId: 'run-1',
    workspaceId: WS,
    question: 'how do things work?',
    fetchImpl,
  })
  assert.equal(decision.status, 'applied')
  assert.deepEqual(decision.orderedChunkIds, ['c2', 'c3', 'c1'])
  assert.equal(decision.rubricVersion, RUBRIC_VERSION)
  assert.equal(calls(), 1, 'exactly one transport request')
  assert.equal(decision.usage.status, 'known')
})

test('RANK-04: exact ties keep baseline rank order', async () => {
  const candidates = makeCandidates(3)
  const { fetchImpl } = scoreFetch({ c1: 2, c2: 2, c3: 2 })
  const decision = await rerankCandidates(candidates, {
    runId: 'run-2',
    workspaceId: WS,
    question: 'ties',
    fetchImpl,
  })
  assert.equal(decision.status, 'applied')
  assert.deepEqual(decision.orderedChunkIds, ['c1', 'c2', 'c3'])
})

test('RANK-10: candidate objects and text are never mutated', async () => {
  const candidates = makeCandidates(3)
  const snapshot = JSON.stringify(candidates)
  const { fetchImpl } = scoreFetch({ c1: 3, c2: 1, c3: 2 })
  await rerankCandidates(candidates, {
    runId: 'run-3',
    workspaceId: WS,
    question: 'immutability',
    fetchImpl,
  })
  assert.equal(JSON.stringify(candidates), snapshot)
})

test('provider 5xx falls back to baseline ordering without throwing', async () => {
  const candidates = makeCandidates(3)
  const fetchImpl = async () => new Response('boom', { status: 500 })
  const decision = await rerankCandidates(candidates, {
    runId: 'run-4',
    workspaceId: WS,
    question: 'outage',
    fetchImpl,
  })
  assert.equal(decision.status, 'fallback')
  assert.equal(decision.reason, 'provider_unavailable')
  assert.deepEqual(decision.orderedChunkIds, ['c1', 'c2', 'c3'])
})

test('RANK-02: duplicate candidate ids reject without any call', async () => {
  const candidates = makeCandidates(3)
  candidates[2].chunkId = 'c1' // duplicate of c1
  const { fetchImpl, calls } = scoreFetch({})
  const decision = await rerankCandidates(candidates, {
    runId: 'run-5',
    workspaceId: WS,
    question: 'dupes',
    fetchImpl,
  })
  assert.equal(decision.status, 'fallback')
  assert.equal(decision.reason, 'duplicate_candidates')
  assert.equal(calls(), 0)
})

test('RANK-01: a single candidate skips inference', async () => {
  const candidates = makeCandidates(1)
  const { fetchImpl, calls } = scoreFetch({})
  const decision = await rerankCandidates(candidates, {
    runId: 'run-6',
    workspaceId: WS,
    question: 'single',
    fetchImpl,
  })
  assert.equal(decision.status, 'skipped')
  assert.equal(decision.reason, 'too_few_candidates')
  assert.equal(calls(), 0)
  assert.deepEqual(decision.orderedChunkIds, ['c1'])
})

test('parent cancellation reports cancelled, not fallback', async () => {
  const candidates = makeCandidates(3)
  const parent = new AbortController()
  const fetchImpl = (_url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () =>
        reject(new DOMException('AbortError', 'AbortError'))
      )
    })
  const pending = rerankCandidates(candidates, {
    runId: 'run-7',
    workspaceId: WS,
    question: 'cancel',
    signal: parent.signal,
    fetchImpl,
  })
  parent.abort()
  const decision = await pending
  assert.equal(decision.status, 'cancelled')
  assert.equal(decision.reason, 'cancelled')
  assert.deepEqual(decision.orderedChunkIds, ['c1', 'c2', 'c3'])
})

test('truncation is recorded when excerpts exceed the byte budget', async () => {
  const candidates = makeCandidates(2)
  candidates[0].text = 'long '.repeat(600)
  const { fetchImpl } = scoreFetch({ c1: 3, c2: 2 })
  const decision = await rerankCandidates(candidates, {
    runId: 'run-8',
    workspaceId: WS,
    question: 'truncation',
    fetchImpl,
  })
  assert.equal(decision.truncatedCount, 1)
})
