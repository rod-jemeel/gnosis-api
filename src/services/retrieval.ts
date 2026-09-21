/**
 * Retrieval (spec §13): lexical (Postgres FTS) and dense (pgvector)
 * candidates over the same authorized build snapshot, fused with
 * reciprocal-rank fusion. Scope is resolved before any retrieval.
 */

import { and, eq, sql } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { limits } from '../config.js'
import { embedQuery } from '../providers/embeddings.js'
import { rerankCandidates } from './jev/rerank.js'
import { jevConfigState } from './jev/policy.js'

export type SearchScope =
  | { type: 'all_current' }
  | { type: 'selected_documents'; documentIds: string[] }

export interface EligibleDoc {
  documentId: string
  title: string
  buildId: string
  versionId: string
  revisionNumber: number
  contentHash: string
}

export function uuidArrayLiteral(ids: string[]): string {
  return `{${ids.join(',')}}`
}

/**
 * Lexical candidate generation uses OR semantics: a chunk matching any
 * distinctive term is a candidate, and ts_rank orders by how much of
 * the question each chunk covers. (AND semantics would require one
 * chunk to contain every word of a long question.)
 */
function orTsQuery(question: string): string {
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
    .slice(0, 24)
  return terms.join(' | ')
}

export async function eligibleBuilds(workspaceId: string, scope: SearchScope): Promise<EligibleDoc[]> {
  const conditions = [
    eq(schema.documents.workspaceId, workspaceId),
    eq(schema.documents.lifecycle, 'active'),
    sql`${schema.documents.activeBuildId} is not null`,
  ]
  if (scope.type === 'selected_documents') {
    conditions.push(sql`${schema.documents.id} = any(${uuidArrayLiteral(scope.documentIds)}::uuid[])`)
  }
  const rows = await db
    .select({
      documentId: schema.documents.id,
      title: schema.documents.title,
      buildId: schema.documents.activeBuildId,
      versionId: schema.documents.activeVersionId,
      revisionNumber: schema.documentVersions.revisionNumber,
      contentHash: schema.documentVersions.contentHash,
    })
    .from(schema.documents)
    .innerJoin(
      schema.documentVersions,
      eq(schema.documentVersions.id, schema.documents.activeVersionId)
    )
    .where(and(...conditions))
  return rows.map((r) => ({
    documentId: r.documentId,
    title: r.title,
    buildId: r.buildId!,
    versionId: r.versionId!,
    revisionNumber: r.revisionNumber,
    contentHash: r.contentHash,
  }))
}

export interface CandidateChunk {
  chunkId: string
  documentId: string
  documentTitle: string
  versionId: string
  buildId: string
  revisionNumber: number
  page: number
  text: string
}

/** Safe projection of one judgment stage; no source text, no secrets. */
export interface JudgmentDiagnostics {
  stage: 'rerank'
  mode: 'off' | 'shadow' | 'on'
  status: 'disabled' | 'skipped' | 'shadow' | 'applied' | 'fallback' | 'cancelled'
  reason: string | null
  requestedModel: string
  returnedModel: string | null
  rubricVersion: string
  candidateCount: number
  truncatedCount: number
  timingsMs: number
  usage: { inputTokens: number | null; outputTokens: number | null; status: 'known' | 'unavailable' }
}

export interface RetrievalResult {
  selected: CandidateChunk[]
  details: {
    normalizedQuery: string
    candidates: {
      chunkId: string
      documentId: string
      documentName: string
      denseRank: number | null
      lexicalRank: number | null
      fusionScore: number
      rerankRank: number | null
      selected: boolean
    }[]
    timings: { lexicalMs: number; denseMs: number; fusionMs: number; rerankMs: number }
    config: {
      denseTopK: number
      lexicalTopK: number
      rrfConstant: number
      reranker: string | null
    }
    /** Additive, versioned projection; absent when no stage ran. */
    judgment?: JudgmentDiagnostics
  }
  /** Which selected document ids were missing/unavailable in scope. */
  missingDocumentIds: string[]
}

/** Caller-supplied execution context for optional judgment stages. */
export interface RetrievalHooks {
  runId?: string
  /** Parent run cancellation — authoritative over stage deadlines. */
  signal?: AbortSignal
}

export async function retrieve(
  workspaceId: string,
  scope: SearchScope,
  question: string,
  hooks: RetrievalHooks = {}
): Promise<RetrievalResult> {
  const eligible = await eligibleBuilds(workspaceId, scope)
  const eligibleIds = new Set(eligible.map((d) => d.documentId))
  const missingDocumentIds =
    scope.type === 'selected_documents'
      ? scope.documentIds.filter((id) => !eligibleIds.has(id))
      : []
  const buildIds = eligible.map((d) => d.buildId!)
  const docByBuild = new Map(eligible.map((d) => [d.buildId!, d]))
  const normalizedQuery = question.trim().replace(/\s+/g, ' ')

  const timings = { lexicalMs: 0, denseMs: 0, fusionMs: 0, rerankMs: 0 }
  if (buildIds.length === 0) {
    return {
      selected: [],
      missingDocumentIds,
      details: {
        normalizedQuery,
        candidates: [],
        timings,
        config: {
          denseTopK: limits.denseTopK,
          lexicalTopK: limits.lexicalTopK,
          rrfConstant: limits.rrfConstant,
          reranker: null,
        },
      },
    }
  }

  // Lexical: English FTS with ranking (OR-term candidates).
  const t0 = Date.now()
  const tsQuery = orTsQuery(normalizedQuery)
  const lexical = tsQuery
    ? await db.execute<{ id: string; rank: number }>(sql`
        select id, ts_rank(tsv, to_tsquery('english', ${tsQuery})) as rank
        from chunks
        where workspace_id = ${workspaceId} and build_id = any(${uuidArrayLiteral(buildIds)}::uuid[])
          and tsv @@ to_tsquery('english', ${tsQuery})
        order by rank desc, ordinal asc
        limit ${limits.lexicalTopK}
      `)
    : { rows: [] as { id: string; rank: number }[] }
  timings.lexicalMs = Date.now() - t0

  // Dense: pgvector cosine over the same build snapshot.
  let dense: { id: string }[] = []
  const denseIds = new Set<string>()
  const t1 = Date.now()
  try {
    const queryEmbedding = await embedQuery(normalizedQuery.slice(0, 8000))
    if (queryEmbedding) {
      const vectorLiteral = `[${queryEmbedding.join(',')}]`
      dense = (
        await db.execute<{ id: string }>(sql`
          select id from chunks
          where workspace_id = ${workspaceId} and build_id = any(${uuidArrayLiteral(buildIds)}::uuid[]) and embedding is not null
          order by embedding <=> ${vectorLiteral}::vector
          limit ${limits.denseTopK}
        `)
      ).rows
      for (const row of dense) denseIds.add(row.id)
    }
  } catch (err) {
    // Dense retrieval is a complement; lexical-only is a degraded but
    // valid pipeline and is recorded as such.
    console.warn('[retrieval] dense path unavailable:', err instanceof Error ? err.message : err)
  }
  timings.denseMs = Date.now() - t1

  // Reciprocal-rank fusion.
  const t2 = Date.now()
  const fusion = new Map<string, number>()
  lexical.rows.forEach((row, index) => {
    fusion.set(row.id, (fusion.get(row.id) ?? 0) + 1 / (limits.rrfConstant + index + 1))
  })
  dense.forEach((row, index) => {
    fusion.set(row.id, (fusion.get(row.id) ?? 0) + 1 / (limits.rrfConstant + index + 1))
  })
  const fusedOrder = [...fusion.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  timings.fusionMs = Date.now() - t2

  const lexicalRankById = new Map(lexical.rows.map((row, index) => [row.id, index + 1]))
  const denseRankById = new Map(dense.map((row, index) => [row.id, index + 1]))

  // Hydrate candidates from PostgreSQL after authorization (second
  // scoped check; spec §13.4).
  const candidateIds = fusedOrder.slice(0, 20).map(([id]) => id)
  const hydrated = candidateIds.length
    ? (
        await db.execute<{
          id: string
          document_id: string
          build_id: string
          page: number
          text: string
        }>(sql`
          select id, document_id, build_id, page, text from chunks
          where workspace_id = ${workspaceId} and id = any(${uuidArrayLiteral(candidateIds)}::uuid[])
        `)
      ).rows
    : []
  const chunkById = new Map(hydrated.map((row) => [row.id, row]))

  // Fused candidate entries in fusion order, restricted to hydrated rows.
  const fusedEntries = fusedOrder
    .slice(0, 20)
    .filter(([id]) => chunkById.has(id))
    .map(([id, score]) => ({ chunkId: id, fusionScore: Number(score.toFixed(6)) }))

  // Optional Jev reranking (R1): policy-gated, at most one bounded
  // request. Without hooks (or with mode=off) nothing runs and the
  // baseline ordering is preserved exactly (fallback parity, RANK-15).
  let judgment: JudgmentDiagnostics | undefined
  let orderedEntries = fusedEntries
  if (hooks.runId) {
    const jevInput = fusedEntries.map((entry, index) => {
      const chunk = chunkById.get(entry.chunkId)!
      const doc = docByBuild.get(chunk.build_id)!
      return {
        chunkId: chunk.id,
        documentId: chunk.document_id,
        versionId: doc.versionId,
        buildId: chunk.build_id,
        contentHash: doc.contentHash,
        text: chunk.text,
        baselineRank: index + 1,
      }
    })
    const decision = await rerankCandidates(jevInput, {
      runId: hooks.runId,
      workspaceId,
      question: normalizedQuery,
      signal: hooks.signal,
    })
    timings.rerankMs = decision.timingsMs
    judgment = {
      stage: 'rerank',
      mode: jevConfigState.config.mode,
      status: decision.status,
      reason: decision.reason,
      requestedModel: decision.requestedModel,
      returnedModel: decision.returnedModel,
      rubricVersion: decision.rubricVersion,
      candidateCount: decision.candidateCount,
      truncatedCount: decision.truncatedCount,
      timingsMs: decision.timingsMs,
      usage: decision.usage,
    }
    if (decision.status === 'applied') {
      // Jev reordered only the supplied candidates (INV-03): order the
      // known entries by the applied ranking, keeping any entry the
      // decision omitted at the tail in fusion order.
      const position = new Map(decision.orderedChunkIds.map((id, i) => [id, i]))
      orderedEntries = [...fusedEntries].sort((a, b) => {
        const pa = position.get(a.chunkId) ?? Number.MAX_SAFE_INTEGER
        const pb = position.get(b.chunkId) ?? Number.MAX_SAFE_INTEGER
        return pa - pb
      })
    }
  }

  const rerankRankById = new Map<string, number>()
  if (judgment && judgment.status === 'applied') {
    orderedEntries.forEach((entry, index) => rerankRankById.set(entry.chunkId, index + 1))
  }
  const selectedIds = new Set(
    orderedEntries.slice(0, limits.maxEvidenceChunks).map((e) => e.chunkId)
  )

  const candidates = orderedEntries.map((entry) => {
    const chunk = chunkById.get(entry.chunkId)!
    const doc = docByBuild.get(chunk.build_id)!
    return {
      chunkId: entry.chunkId,
      documentId: chunk.document_id,
      documentName: doc.title,
      denseRank: denseRankById.get(entry.chunkId) ?? null,
      lexicalRank: lexicalRankById.get(entry.chunkId) ?? null,
      fusionScore: entry.fusionScore,
      rerankRank: rerankRankById.get(entry.chunkId) ?? null,
      selected: selectedIds.has(entry.chunkId),
    }
  })

  const selected: CandidateChunk[] = orderedEntries
    .slice(0, limits.maxEvidenceChunks)
    .map((entry) => chunkById.get(entry.chunkId)!)
    .filter((chunk): chunk is NonNullable<typeof chunk> => Boolean(chunk))
    .map((chunk) => {
      const doc = docByBuild.get(chunk.build_id)!
      return {
        chunkId: chunk.id,
        documentId: chunk.document_id,
        documentTitle: doc.title,
        versionId: doc.versionId,
        buildId: chunk.build_id,
        revisionNumber: doc.revisionNumber,
        page: chunk.page,
        text: chunk.text,
      }
    })

  return {
    selected,
    missingDocumentIds,
    details: {
      normalizedQuery,
      candidates,
      timings,
      config: {
        denseTopK: limits.denseTopK,
        lexicalTopK: limits.lexicalTopK,
        rrfConstant: limits.rrfConstant,
        reranker:
          judgment && judgment.status === 'applied'
            ? `jev ${judgment.rubricVersion} (typesafe)`
            : null,
      },
      ...(judgment ? { judgment } : {}),
    },
  }
}
