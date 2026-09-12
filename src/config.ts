/**
 * Configuration contract (spec §21.2): fail fast on missing mandatory
 * configuration rather than silently defaulting to unrelated services.
 */

import { z } from 'zod'
import './env.js'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  API_URL: z.string().url().default('http://localhost:3000'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3210,http://localhost:3211'),
  AUTH_MODE: z.enum(['local', 'supabase']).default('local'),
  SUPABASE_JWT_SECRET: z.string().optional(),
  SUPABASE_JWKS_URL: z.string().url().optional(),
  SUPABASE_ISSUER: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_GENERATOR_MODEL: z.string().default('gpt-4o-mini'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta/openai'),
  GEMINI_GENERATOR_MODEL: z.string().default('gemini-2.5-flash'),
  // Self-hosted embeddings (ONNX in-process) are the default; no key,
  // no egress, deterministic after first model download.
  EMBEDDING_PROVIDER: z.enum(['local', 'openai']).default('local'),
  EMBEDDING_MODEL: z.string().default('Xenova/bge-small-en-v1.5'),
  EMBEDDING_DIMS: z.coerce.number().int().positive().default(384),
})

export type GenerationProvider = 'gemini' | 'openai' | 'none'

export function generationProvider(): GenerationProvider {
  if (config.GEMINI_API_KEY) return 'gemini'
  if (config.OPENAI_API_KEY) return 'openai'
  return 'none'
}

export type AppConfig = z.infer<typeof schema>

function loadConfig(): AppConfig {
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new Error(`Invalid configuration: ${issues}`)
  }
  const config = parsed.data
  if (config.AUTH_MODE === 'supabase') {
    const hasSecret = Boolean(config.SUPABASE_JWT_SECRET)
    const hasJwks = Boolean(config.SUPABASE_JWKS_URL)
    if (hasSecret === hasJwks) {
      throw new Error(
        'AUTH_MODE=supabase requires exactly one of SUPABASE_JWT_SECRET (HS256) or SUPABASE_JWKS_URL (asymmetric).'
      )
    }
  }
  if (config.AUTH_MODE === 'local' && !config.API_URL.startsWith('http://localhost')) {
    throw new Error('AUTH_MODE=local is only permitted on localhost.')
  }
  return config
}

export const config = loadConfig()

/* Policy limits (spec §7 starting values). */
export const limits = {
  maxUploadBytes: 25 * 1024 * 1024,
  maxPages: 200,
  maxDocumentsPerWorkspace: 100,
  maxSelectedDocuments: 50,
  maxSourceBytesPerWorkspace: 1024 * 1024 * 1024,
  maxChunksPerWorkspace: 20_000,
  denseTopK: 30,
  lexicalTopK: 30,
  rrfConstant: 60,
  maxEvidenceChunks: 8,
  contextTokenBudget: 6000,
  questionMaxBytes: 8 * 1024,
} as const
