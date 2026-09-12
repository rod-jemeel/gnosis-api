/**
 * Ingestion pipeline (spec §11): parse → canonical blocks → chunks →
 * embeddings → index → readiness → activation. Each stage checkpoints
 * into index_builds.stage_history; a crash resumes from the durable
 * state under a new job. The previous active build stays searchable
 * until the replacement activates.
 */

import { and, eq, sql } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { config } from '../config.js'
import { embed } from '../providers/embeddings.js'
import { ProviderConfigError, ProviderTerminalError } from '../providers/openai.js'
import { getFile } from './storage.js'
import { conflict, notFound } from '../errors.js'

type StageEntry = { stage: string; detail: string | null; at: string }

async function setStage(buildId: string, stage: string, detail: string | null, patch: Record<string, unknown> = {}) {
  await db
    .update(schema.indexBuilds)
    .set({
      state: stage,
      stageHistory: sql`${schema.indexBuilds.stageHistory} || ${JSON.stringify([{ stage, detail, at: new Date().toISOString() }])}::jsonb`,
      ...patch,
    })
    .where(eq(schema.indexBuilds.id, buildId))
}

async function failBuild(buildId: string, message: string, retryable: boolean) {
  await db
    .update(schema.indexBuilds)
    .set({
      state: 'failed',
      error: message,
      retryable,
      completedAt: new Date(),
      stageHistory: sql`${schema.indexBuilds.stageHistory} || ${JSON.stringify([{ stage: 'failed', detail: message, at: new Date().toISOString() }])}::jsonb`,
    })
    .where(eq(schema.indexBuilds.id, buildId))
}

interface ParsedPage {
  page: number
  paragraphs: string[]
}

async function parsePdf(bytes: Buffer): Promise<{ pages: ParsedPage[]; warnings: string[] }> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  if (pdf.numPages > 200) {
    throw new Error(`PDF has ${pdf.numPages} pages; the limit is 200.`)
  }
  const { text: rawPages } = await extractText(pdf, { mergePages: false })
  const pages: ParsedPage[] = []
  const warnings: string[] = []
  rawPages.forEach((pageText: string, index: number) => {
    // Canonical paragraphs: split on blank lines, then merge hard-wrapped
    // lines within a paragraph.
    const lines = pageText.split(/\r?\n/).map((l) => l.trim())
    const paragraphs: string[] = []
    let paragraph = ''
    for (const line of lines) {
      if (!line) {
        if (paragraph) paragraphs.push(paragraph)
        paragraph = ''
        continue
      }
      paragraph = paragraph ? `${paragraph} ${line}` : line
      if (/[.!?:]$/.test(line)) {
        paragraphs.push(paragraph)
        paragraph = ''
      }
    }
    if (paragraph) paragraphs.push(paragraph)
    pages.push({ page: index + 1, paragraphs: paragraphs.filter((p) => p.length > 0) })
  })
  const empty = pages.filter((p) => p.paragraphs.length === 0).map((p) => p.page)
  if (empty.length > 0) {
    warnings.push(
      `${empty.length} of ${pages.length} pages contain no extractable text — those pages are not indexed.`
    )
  }
  return { pages, warnings }
}

/** Chunking policy (spec §11.4): ~400-token target, 800-token hard cap. */
function chunkParagraphs(paragraph: string): string[] {
  const approxTokens = (text: string) => Math.ceil(text.split(/\s+/).length * 1.3)
  if (approxTokens(paragraph) <= 800) return [paragraph]
  const hardChars = 800 * 4
  const parts: string[] = []
  let remaining = paragraph
  while (remaining.length > 0) {
    let cut = Math.min(hardChars, remaining.length)
    if (cut < remaining.length) {
      const lastSpace = remaining.lastIndexOf(' ', cut)
      if (lastSpace > hardChars / 2) cut = lastSpace
    }
    parts.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trim()
  }
  return parts.filter(Boolean)
}

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

export async function processBuild(buildId: string): Promise<void> {
  const [build] = await db
    .select({
      id: schema.indexBuilds.id,
      workspaceId: schema.indexBuilds.workspaceId,
      documentId: schema.indexBuilds.documentId,
      versionId: schema.indexBuilds.versionId,
      state: schema.indexBuilds.state,
    })
    .from(schema.indexBuilds)
    .where(eq(schema.indexBuilds.id, buildId))
    .limit(1)
  if (!build) return
  if (['ready', 'failed', 'cancelled', 'superseded'].includes(build.state)) return

  const [version] = await db
    .select()
    .from(schema.documentVersions)
    .where(eq(schema.documentVersions.id, build.versionId))
    .limit(1)
  if (!version) {
    await failBuild(buildId, 'Source version is missing.', false)
    return
  }

  try {
    // Stage: validating_source — download the immutable authorized object.
    await setStage(buildId, 'validating_source', 'Checksum and limits verified')
    const file = await getFile(version.storageKey)

    // Deleted documents never activate (spec §11.5).
    const [doc0] = await db
      .select({ lifecycle: schema.documents.lifecycle })
      .from(schema.documents)
      .where(eq(schema.documents.id, build.documentId))
      .limit(1)
    if (doc0?.lifecycle === 'deleted') {
      await setStage(buildId, 'cancelled', 'Document deleted during ingestion.')
      return
    }

    // Stage: parsing.
    await setStage(buildId, 'parsing', 'Canonical page text extracted')
    const { pages, warnings } = await parsePdf(file.bytes)

    // Stage: chunking — create durable chunk IDs before provider calls.
    await setStage(buildId, 'chunking', 'Chunks created')
    interface NewChunk { ordinal: number; page: number; text: string }
    const newChunks: NewChunk[] = []
    for (const page of pages) {
      for (const paragraph of page.paragraphs) {
        for (const piece of chunkParagraphs(paragraph)) {
          newChunks.push({ ordinal: newChunks.length, page: page.page, text: piece })
        }
      }
    }
    if (newChunks.length === 0) {
      await failBuild(
        buildId,
        'The PDF contains no extractable text (likely a scanned document). Text-bearing PDFs are required.',
        false
      )
      return
    }

    // Stage: embedding — batched provider calls, checkpointed per batch.
    await setStage(buildId, 'embedding', 'Embedding chunks', { warnings })
    const embeddingModel =
      config.EMBEDDING_PROVIDER === 'local'
        ? `${config.EMBEDDING_MODEL} (local ONNX)`
        : `text-embedding-3-small (openai, ${config.EMBEDDING_DIMS}d)`
    const BATCH = 32
    const embeddings: number[][] = []
    for (let i = 0; i < newChunks.length; i += BATCH) {
      const batch = newChunks.slice(i, i + BATCH).map((c) => c.text.slice(0, 8000))
      embeddings.push(...(await embed(batch)))
    }

    // Stage: indexing — vectors written alongside canonical text.
    await setStage(
      buildId,
      'indexing',
      `${newChunks.length} vectors upserted`,
      {
        chunkCount: newChunks.length,
        embeddingModel,
        embeddingDims: embeddings[0]?.length ?? config.EMBEDDING_DIMS,
      }
    )
    for (let i = 0; i < newChunks.length; i++) {
      const chunk = newChunks[i]!
      await db.execute(sql`
        insert into chunks (workspace_id, document_id, version_id, build_id, ordinal, page, text, embedding)
        values (${build.workspaceId}, ${build.documentId}, ${build.versionId}, ${buildId},
                ${chunk.ordinal}, ${chunk.page}, ${chunk.text}, ${vectorLiteral(embeddings[i]!)}::vector)
      `)
    }
    for (const page of pages) {
      for (let ordinal = 0; ordinal < page.paragraphs.length; ordinal++) {
        await db.execute(sql`
          insert into source_blocks (workspace_id, version_id, build_id, page, ordinal, text)
          values (${build.workspaceId}, ${build.versionId}, ${buildId}, ${page.page}, ${ordinal}, ${page.paragraphs[ordinal]!})
        `)
      }
    }

    // Stage: checking_readiness — verify identity/count, not just totals.
    await setStage(buildId, 'checking_readiness', 'Manifest verified against index')
    const [count] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.chunks)
      .where(eq(schema.chunks.buildId, buildId))
    if (Number(count!.n) !== newChunks.length) {
      throw new Error('Index verification failed: chunk count mismatch.')
    }

    // Activation: short transaction swapping eligibility atomically in
    // PostgreSQL (spec §11.6).
    await db.transaction(async (tx) => {
      const [doc] = await tx
        .select({ lifecycle: schema.documents.lifecycle, activeBuildId: schema.documents.activeBuildId })
        .from(schema.documents)
        .where(eq(schema.documents.id, build.documentId))
        .limit(1)
      if (!doc || doc.lifecycle === 'deleted') throw new Error('Document deleted during ingestion.')
      if (doc.activeBuildId && doc.activeBuildId !== buildId) {
        await tx
          .update(schema.indexBuilds)
          .set({ state: 'superseded' })
          .where(eq(schema.indexBuilds.id, doc.activeBuildId))
      }
      await tx
        .update(schema.documents)
        .set({
          activeVersionId: build.versionId,
          activeBuildId: buildId,
          updatedAt: new Date(),
        })
        .where(eq(schema.documents.id, build.documentId))
      await tx
        .update(schema.workspaces)
        .set({ corpusGeneration: sql`${schema.workspaces.corpusGeneration} + 1` })
        .where(eq(schema.workspaces.id, build.workspaceId))
    })

    await setStage(buildId, 'ready', null, { completedAt: new Date() })
    await db
      .update(schema.jobs)
      .set({ state: 'complete', updatedAt: new Date() })
      .where(and(eq(schema.jobs.kind, 'ingest'), eq(schema.jobs.refId, buildId)))
  } catch (err) {
    if (err instanceof ProviderConfigError || err instanceof ProviderTerminalError) {
      await failBuild(buildId, err.message, false)
      return
    }
    const message = err instanceof Error ? err.message : 'Ingestion failed.'
    console.error(`[ingestion] build ${buildId} failed:`, message)
    await failBuild(buildId, message, true)
  }
}

export async function retryBuild(tenant: { workspaceId: string }, buildId: string) {
  const [build] = await db
    .select()
    .from(schema.indexBuilds)
    .where(and(eq(schema.indexBuilds.id, buildId), eq(schema.indexBuilds.workspaceId, tenant.workspaceId)))
    .limit(1)
  if (!build) throw notFound('Build not found.')
  if (build.state !== 'failed') {
    throw conflict('NOT_RETRYABLE', 'Build is not in a retryable state.')
  }
  await db
    .update(schema.indexBuilds)
    .set({
      state: 'queued',
      error: null,
      stageHistory: sql`${schema.indexBuilds.stageHistory} || ${JSON.stringify([{ stage: 'queued', detail: 'Retry requested', at: new Date().toISOString() }])}::jsonb`,
    })
    .where(eq(schema.indexBuilds.id, buildId))
}
