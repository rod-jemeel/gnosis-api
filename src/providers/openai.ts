/**
 * OpenAI-compatible client (OpenAI or any compatible endpoint, such as
 * Gemini's /v1beta/openai compatibility layer).
 */

import { config } from '../config.js'

export class ProviderConfigError extends Error {}

/** Terminal provider failures (bad key, exhausted billing): no blind retries. */
export class ProviderTerminalError extends Error {}

export interface EndpointConfig {
  baseUrl: string
  apiKey: string
}

export function openaiEndpoint(): EndpointConfig {
  if (!config.OPENAI_API_KEY) {
    throw new ProviderConfigError('OPENAI_API_KEY is not configured.')
  }
  return { baseUrl: config.OPENAI_BASE_URL, apiKey: config.OPENAI_API_KEY }
}

export async function callCompatible(
  endpoint: EndpointConfig,
  path: string,
  body: unknown
): Promise<Response> {
  const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${endpoint.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    const bodyJson = (await response.json().catch(() => null)) as
      | { error?: { code?: string; type?: string } }
      | null
    const code = bodyJson?.error?.code ?? bodyJson?.error?.type ?? ''
    // Safe message only; full provider detail stays in server logs.
    console.error(`[provider] ${path} ${response.status} ${code}`)
    if (
      code === 'insufficient_quota' ||
      code === 'credit_balance_exhausted' ||
      code === 'invalid_api_key' ||
      code === 'API_KEY_INVALID'
    ) {
      throw new ProviderTerminalError(
        code === 'invalid_api_key' || code === 'API_KEY_INVALID'
          ? 'The configured model provider key is invalid.'
          : 'The model provider account has no credits remaining.'
      )
    }
    throw new Error(`Provider ${path} failed with status ${response.status}.`)
  }
  return response
}

export async function embed(texts: string[], dimensions?: number): Promise<number[][]> {
  const endpoint = openaiEndpoint()
  const response = await callCompatible(endpoint, '/embeddings', {
    model: 'text-embedding-3-small',
    input: texts,
    ...(dimensions ? { dimensions } : {}),
  })
  const json = (await response.json()) as {
    data: { embedding: number[]; index: number }[]
  }
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}
