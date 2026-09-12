/**
 * Generation provider selection: Gemini (OpenAI-compatible endpoint) or
 * OpenAI — or explicitly none, in which case the answer pipeline falls
 * back to the spec-endorsed evidence-only mode (§14.3).
 */

import { config, generationProvider } from '../config.js'
import {
  callCompatible,
  openaiEndpoint,
  ProviderConfigError,
  type EndpointConfig,
} from './openai.js'

export class GenerationUnavailable extends Error {
  constructor() {
    super('No generation provider is configured.')
  }
}

export interface GenerationResult {
  content: string
  promptTokens: number
  completionTokens: number
  model: string
}

function endpoint(): EndpointConfig {
  const provider = generationProvider()
  if (provider === 'gemini') {
    return { baseUrl: config.GEMINI_BASE_URL, apiKey: config.GEMINI_API_KEY! }
  }
  if (provider === 'openai') {
    return openaiEndpoint()
  }
  throw new GenerationUnavailable()
}

export async function generateJson(
  system: string,
  user: string
): Promise<GenerationResult> {
  const provider = generationProvider()
  const ep = endpoint()
  const model =
    provider === 'gemini' ? config.GEMINI_GENERATOR_MODEL : config.OPENAI_GENERATOR_MODEL
  const response = await callCompatible(ep, '/chat/completions', {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })
  const json = (await response.json()) as {
    choices: { message: { content: string } }[]
    usage?: { prompt_tokens: number; completion_tokens: number }
  }
  const choice = json.choices[0]
  if (!choice) throw new Error('Provider returned no completion choice.')
  return {
    content: choice.message.content,
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
    model,
  }
}

export { ProviderConfigError }
