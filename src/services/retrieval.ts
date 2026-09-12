/**
 * Retrieval (spec §13): lexical (Postgres FTS) and dense (pgvector)
 * candidates over the same authorized build snapshot, fused with
 * reciprocal-rank fusion. Scope is resolved before any retrieval.
 */

import { and, eq, sql } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { limits } from '../config.js'
import { embedQuery } from '../providers/embeddings.js'

export type SearchScope =
  | { type: 'all_current' }
  | { type: 'selected_documents'; documentIds: string[] }

export interface EligibleDoc {
  documentId: string
  title: string
  buildId: string
  versionId: string
  revisionNumber: number
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
  }
  /** Which selected document ids were missing/unavailable in scope. */
  missingDocumentIds: string[]
}

export async function retrieve(
  workspaceId: string,
  scope: SearchScope,
  question: string
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
  const selectedIds = new Set(fusedOrder.slice(0, limits.maxEvidenceChunks).map(([id]) => id))

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

  const candidates = fusedOrder.slice(0, 20).map(([chunkId, score]) => {
    const chunk = chunkById.get(chunkId)
    const doc = chunk ? docByBuild.get(chunk.build_id) : undefined
    return {
      chunkId,
      documentId: chunk?.document_id ?? '',
      documentName: doc?.title ?? 'Unknown',
      denseRank: denseRankById.get(chunkId) ?? null,
      lexicalRank: lexicalRankById.get(chunkId) ?? null,
      fusionScore: Number(score.toFixed(6)),
      rerankRank: null as number | null,
      selected: selectedIds.has(chunkId),
    }
  })

  const selected: CandidateChunk[] = [...selectedIds]
    .map((chunkId) => chunkById.get(chunkId))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
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
        reranker: null,
      },
    },
  }
}
