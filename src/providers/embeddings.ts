/**
 * Embedding provider. Default: self-hosted ONNX model in-process
 * (transformers.js) — no API key, no egress, deterministic after the
 * first model download (cached under .models/). OpenAI remains
 * available behind the same interface.
 */

import { config } from '../config.js'
import { embed as embedOpenAI } from './openai.js'

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<{ tolist: () => number[][] }>

let localPipeline: FeatureExtractionPipeline | null = null
let loading: Promise<FeatureExtractionPipeline> | null = null

/** bge retrieval convention: instruction prefix on queries only. */
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

async function getLocalPipeline(): Promise<FeatureExtractionPipeline> {
  if (localPipeline) return localPipeline
  if (!loading) {
    loading = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers')
      env.cacheDir = './.models'
      const extractor = await pipeline('feature-extraction', config.EMBEDDING_MODEL, {
        dtype: 'q8',
      })
      return extractor as unknown as FeatureExtractionPipeline
    })().catch((err) => {
      loading = null
      throw err
    })
  }
  localPipeline = await loading
  return localPipeline
}

/** Warm up the local model at boot so first use is not cold. */
export async function warmEmbedder(): Promise<void> {
  if (config.EMBEDDING_PROVIDER !== 'local') return
  const start = Date.now()
  await getLocalPipeline()
  await embed(['warmup'])
  console.log(
    `[embeddings] local model ${config.EMBEDDING_MODEL} ready in ${Date.now() - start}ms (dims: ${config.EMBEDDING_DIMS})`
  )
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  if (config.EMBEDDING_PROVIDER === 'openai') {
    if (!config.OPENAI_API_KEY) {
      throw new Error('EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY.')
    }
    // MRL truncation keeps the schema's fixed dimension honest.
    const vectors = await embedOpenAI(texts, config.EMBEDDING_DIMS)
    return vectors
  }
  const extractor = await getLocalPipeline()
  const output = await extractor(texts, { pooling: 'mean', normalize: true })
  return output.tolist()
}

export async function embedQuery(text: string): Promise<number[] | null> {
  const input =
    config.EMBEDDING_PROVIDER === 'local' && config.EMBEDDING_MODEL.includes('bge')
      ? `${QUERY_PREFIX}${text}`
      : text
  const [vector] = await embed([input])
  return vector ?? null
}
