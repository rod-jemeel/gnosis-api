/**
 * TypeSafe transport client (spec §10).
 *
 * Exactly one bounded HTTP request per invocation: one total deadline
 * covering connection through body consumption, parent-cancellation
 * abort, request/response byte caps, redirect rejection, and no
 * retries — the interactive path falls back instead. The operation is
 * raced against the deadline so an abort-ignoring transport cannot
 * hold the application past its budget (§10.2).
 */

import type {
  TransportOptions,
  TransportResult,
  TypesafeRequest,
} from './types.js'
import { TYPESAFE_ENDPOINT } from './types.js'

function mapStatusToReason(status: number): TransportResult & { ok: false } {
  // Internal-only sanitized status; no body content is logged (NET-12).
  console.warn('[typesafe] transport non-ok status:', status)
  if (status === 401 || status === 403) {
    return { ok: false, reason: 'authentication_failed', httpStatus: status }
  }
  if (status === 429) {
    return { ok: false, reason: 'rate_limited', httpStatus: status }
  }
  return { ok: false, reason: 'provider_unavailable', httpStatus: status }
}

export async function callTypesafe(
  request: TypesafeRequest,
  apiKey: string,
  opts: TransportOptions
): Promise<TransportResult> {
  const doFetch = opts.fetchImpl ?? fetch

  // Full serialized request size is checked before any bytes are sent.
  const body = JSON.stringify(request)
  if (Buffer.byteLength(body, 'utf8') > opts.maxRequestBytes) {
    return { ok: false, reason: 'request_too_large', httpStatus: null }
  }

  if (opts.signal?.aborted) {
    return { ok: false, reason: 'cancelled', httpStatus: null }
  }

  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onParentAbort, { once: true })

  const execute = async (): Promise<TransportResult> => {
    const response = await doFetch(TYPESAFE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
      signal: controller.signal,
      // Redirects are rejected: the endpoint is fixed and allowlisted.
      redirect: 'manual',
    })

    if (response.status >= 300 && response.status < 400) {
      return { ok: false, reason: 'provider_unavailable', httpStatus: response.status }
    }
    if (!response.ok) {
      return mapStatusToReason(response.status)
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) {
      return { ok: false, reason: 'invalid_response', httpStatus: response.status }
    }

    // Bound the consumed stream, including decoded bytes after any
    // decompression — Content-Length alone is not a cap.
    const reader = response.body?.getReader()
    if (!reader) {
      return { ok: false, reason: 'invalid_response', httpStatus: response.status }
    }
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > opts.maxResponseBytes) {
        await reader.cancel().catch(() => {})
        return { ok: false, reason: 'response_too_large', httpStatus: response.status }
      }
      chunks.push(value)
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      return {
        ok: true,
        httpStatus: response.status,
        body: parsed,
        returnedModel: null,
        usage: { inputTokens: null, outputTokens: null, status: 'unavailable' },
      }
    } catch {
      return { ok: false, reason: 'invalid_response', httpStatus: response.status }
    }
  }

  let deadlineId: ReturnType<typeof setTimeout> | null = null
  try {
    const execution = execute()
    const deadline = new Promise<TransportResult>((resolve) => {
      deadlineId = setTimeout(() => {
        controller.abort() // well-behaved transports stop here
        resolve({ ok: false, reason: 'timeout', httpStatus: null })
      }, opts.deadlineMs)
    })
    // Parent cancellation wins immediately; deadline races transport.
    const cancellation = new Promise<TransportResult>((resolve) => {
      opts.signal?.addEventListener(
        'abort',
        () => resolve({ ok: false, reason: 'cancelled', httpStatus: null }),
        { once: true }
      )
    })

    const result = await Promise.race([execution, deadline, cancellation])
    // An abandoned execution must never surface as an unhandled rejection.
    execution.catch(() => {})
    return result
  } catch {
    // Transport exception outside the race (e.g. synchronous throw).
    return { ok: false, reason: 'provider_unavailable', httpStatus: null }
  } finally {
    if (deadlineId) clearTimeout(deadlineId)
    if (opts.signal) opts.signal.removeEventListener('abort', onParentAbort)
  }
}
