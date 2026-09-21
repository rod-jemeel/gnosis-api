/**
 * TypeSafe transport and schema tests (spec §20.2 NET-01..NET-13,
 * §20.3 RANK-05..RANK-08). All transport behavior is exercised with an
 * injected fetch — no network access, no key required.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callTypesafe } from '../../src/providers/typesafe/client.ts'
import { validateScoreBatch } from '../../src/providers/typesafe/schemas.ts'

const REQUEST = {
  model: 'jev-latest',
  state: { query: 'q', passages: [{ text: 'a' }, { text: 'b' }] },
  questions: {
    passage_0: { type: 'score', instructions: 'i0', criteria: ['c', 'c', 'c', 'c'] },
    passage_1: { type: 'score', instructions: 'i1', criteria: ['c', 'c', 'c', 'c'] },
  },
}

function validAnswer(score) {
  // Point-mass split between floor and ceil levels so that
  // probabilities sum to 1 and Σ(level × p) === score exactly.
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
  return { score, confidence: 0.9, probabilities }
}

function validResponse(scores) {
  const answers = {}
  for (const [key, score] of Object.entries(scores)) {
    answers[key] = validAnswer(score)
  }
  return { model: 'jev-latest-2026-01', answers, usage: { inputTokens: 12, outputTokens: 3 } }
}

function okFetch(body, opts = {}) {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { fetchImpl, calls: () => calls }
}

const TRANSPORT_OPTS = { deadlineMs: 500, maxRequestBytes: 48000, maxResponseBytes: 65536 }

test('NET-01: exactly one fetch per invocation', async () => {
  const { fetchImpl, calls } = okFetch(validResponse({ passage_0: 3, passage_1: 2 }))
  await callTypesafe(REQUEST, 'k', { ...TRANSPORT_OPTS, fetchImpl })
  assert.equal(calls(), 1)
})

test('NET-07: oversized serialized request is rejected before any bytes are sent', async () => {
  const { fetchImpl, calls } = okFetch(validResponse({ passage_0: 1, passage_1: 1 }))
  const result = await callTypesafe(REQUEST, 'k', {
    ...TRANSPORT_OPTS,
    maxRequestBytes: 50,
    fetchImpl,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'request_too_large')
  assert.equal(calls(), 0)
})

test('NET-02: redirect responses are rejected', async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } })
  const result = await callTypesafe(REQUEST, 'k', { ...TRANSPORT_OPTS, fetchImpl })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'provider_unavailable')
})

test('NET-06: oversized streamed response bodies are capped', async () => {
  const big = 'x'.repeat(70000)
  const fetchImpl = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big))
          controller.close()
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  const result = await callTypesafe(REQUEST, 'k', {
    ...TRANSPORT_OPTS,
    maxResponseBytes: 65536,
    fetchImpl,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'response_too_large')
})

test('NET-08: 401/429/500 map to safe typed reasons', async () => {
  for (const [status, expected] of [
    [401, 'authentication_failed'],
    [429, 'rate_limited'],
    [500, 'provider_unavailable'],
  ]) {
    const fetchImpl = async () => new Response('nope', { status })
    const result = await callTypesafe(REQUEST, 'k', { ...TRANSPORT_OPTS, fetchImpl })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, expected)
  }
})

test('NET-03/05: an abort-ignoring transport cannot hold the caller past the deadline', async () => {
  let aborts = 0
  const stubborn = (_url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborts++
        // Deliberately ignores the abort (keeps the promise pending).
      })
    })
  const started = Date.now()
  const result = await callTypesafe(REQUEST, 'k', {
    deadlineMs: 80,
    maxRequestBytes: 48000,
    maxResponseBytes: 65536,
    fetchImpl: stubborn,
  })
  const elapsed = Date.now() - started
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'timeout')
  assert.ok(elapsed < 1000, `returned in ${elapsed}ms`)
  assert.ok(aborts >= 1, 'deadline attempted to abort the transport')
})

test('NET-04: parent cancellation aborts and reports cancelled', async () => {
  const parent = new AbortController()
  const fetchImpl = (_url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () =>
        reject(new DOMException('AbortError', 'AbortError'))
      )
    })
  const parentAborted = new Promise((resolve) => {
    parent.signal.addEventListener('abort', () => resolve(true))
  })
  const pending = callTypesafe(REQUEST, 'k', {
    deadlineMs: 5000,
    maxRequestBytes: 48000,
    maxResponseBytes: 65536,
    signal: parent.signal,
    fetchImpl,
  })
  parent.abort()
  await parentAborted
  const result = await pending
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'cancelled')
})

test('NET-13: UTF-8 excerpts end on complete code points', async () => {
  const { excerptUtf8Prefix } = await import('../../src/services/jev/rerank.ts')
  // 'é' is 2 bytes; '😀' is 4. A 1600-byte budget with multibyte content
  // must never produce a replacement-character cut.
  const text = 'bad '.repeat(399) + '😀' + ' tail'
  const { excerpt, truncated } = excerptUtf8Prefix(text, 1600)
  assert.equal(truncated, true)
  assert.ok(!excerpt.includes('\uFFFD'), 'no replacement characters')
  assert.ok(excerpt.length < text.length)
  const unchanged = excerptUtf8Prefix('short', 1600)
  assert.deepEqual(unchanged, { excerpt: 'short', truncated: false })
})

test('RANK-05/06/07: score batches validate fully or not at all', () => {
  const good = validateScoreBatch(REQUEST, ['passage_0', 'passage_1'], validResponse({ passage_0: 3, passage_1: 2 }), {
    requestedModel: 'jev-latest',
    modelAliasAllowed: true,
  })
  assert.equal(good.ok, true)
  assert.equal(good.usage.status, 'known')
  assert.equal(good.usage.inputTokens, 12)

  // Fractional scores consistent with their distributions validate.
  const fractional = structuredClone(validResponse({ passage_0: 1, passage_1: 1 }))
  fractional.answers.passage_0 = {
    score: 2.5,
    confidence: 0.7,
    probabilities: { '0': 0, '1': 0, '2': 0.5, '3': 0.5 },
  }
  const okFractional = validateScoreBatch(REQUEST, ['passage_0', 'passage_1'], fractional, {
    requestedModel: 'jev-latest',
    modelAliasAllowed: true,
  })
  assert.equal(okFractional.ok, true)

  // Missing key rejects the whole batch.
  const missing = validResponse({ passage_0: 3 })
  assert.equal(
    validateScoreBatch(REQUEST, ['passage_0', 'passage_1'], missing, {
      requestedModel: 'jev-latest',
      modelAliasAllowed: true,
    }).ok,
    false
  )

  // Extra key rejects the whole batch.
  const extra = validResponse({ passage_0: 3, passage_1: 2, passage_9: 1 })
  assert.equal(
    validateScoreBatch(REQUEST, ['passage_0', 'passage_1'], extra, {
      requestedModel: 'jev-latest',
      modelAliasAllowed: true,
    }).ok,
    false
  )

  // Wrong primitive shape (missing confidence/probabilities) rejects.
  const wrongPrimitive = validResponse({ passage_0: 3, passage_1: 2 })
  wrongPrimitive.answers.passage_1 = { score: 2 }
  assert.equal(
    validateScoreBatch(REQUEST, ['passage_0', 'passage_1'], wrongPrimitive, {
      requestedModel: 'jev-latest',
      modelAliasAllowed: true,
    }).ok,
    false
  )

  // Probabilities not summing to 1 reject.
  const badSum = validResponse({ passage_0: 3, passage_1: 2 })
  badSum.answers.passage_0.probabilities = { '0': 0.5, '1': 0.5, '2': 0.5, '3': 0.5 }
  assert.equal(
    validateScoreBatch(REQUEST, ['passage_0', 'passage_1'], badSum, {
      requestedModel: 'jev-latest',
      modelAliasAllowed: true,
    }).ok,
    false
  )

  // Score inconsistent with its distribution rejects.
  const inconsistent = validResponse({ passage_0: 3, passage_1: 2 })
  inconsistent.answers.passage_0 = {
    score: 3,
    confidence: 0.9,
    probabilities: { '0': 0.9, '1': 0.03, '2': 0.03, '3': 0.04 },
  }
  assert.equal(
    validateScoreBatch(REQUEST, ['passage_0', 'passage_1'], inconsistent, {
      requestedModel: 'jev-latest',
      modelAliasAllowed: true,
    }).ok,
    false
  )

  // Out-of-range confidence rejects.
  const badConfidence = validResponse({ passage_0: 3, passage_1: 2 })
  badConfidence.answers.passage_0.confidence = 1.5
  assert.equal(
    validateScoreBatch(REQUEST, ['passage_0', 'passage_1'], badConfidence, {
      requestedModel: 'jev-latest',
      modelAliasAllowed: true,
    }).ok,
    false
  )
})

test('RANK-08: pinned model mismatch causes rejection; dev alias accepts', () => {
  const response = validResponse({ passage_0: 3, passage_1: 2 })
  response.model = 'jev-latest-2026-01'

  const alias = validateScoreBatch(REQUEST, ['passage_0', 'passage_1'], response, {
    requestedModel: 'jev-latest',
    modelAliasAllowed: true,
  })
  assert.equal(alias.ok, true)
  assert.equal(alias.returnedModel, 'jev-latest-2026-01')

  const pinned = validateScoreBatch(REQUEST, ['passage_0', 'passage_1'], response, {
    requestedModel: 'jev-prod-2026-06-01',
    modelAliasAllowed: false,
  })
  assert.equal(pinned.ok, false)
  if (!pinned.ok) assert.equal(pinned.reason, 'model_mismatch')
})

test('Usage is unavailable, never zero, when the provider reports none', () => {
  const noUsage = validResponse({ passage_0: 3, passage_1: 2 })
  delete noUsage.usage
  const result = validateScoreBatch(REQUEST, ['passage_0', 'passage_1'], noUsage, {
    requestedModel: 'jev-latest',
    modelAliasAllowed: true,
  })
  assert.equal(result.ok, true)
  assert.equal(result.usage.status, 'unavailable')
  assert.equal(result.usage.inputTokens, null)
})
