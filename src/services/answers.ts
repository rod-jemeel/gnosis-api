/**
 * Answer-run pipeline (spec §13, §14, §16): durable two-step protocol.
 * The run is created by POST (idempotent), executed by a worker, and its
 * event stream is replayable by sequence cursor. Final publication is a
 * single transaction covering the assistant message, run state, usage,
 * and terminal events.
 */

import { and, desc, eq, sql } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { limits } from '../config.js'
import { generateJson, GenerationUnavailable } from '../providers/generation.js'
import { generationProvider } from '../config.js'
import { retrieve, uuidArrayLiteral, type CandidateChunk, type SearchScope } from './retrieval.js'

export const V2_SCHEMA_VERSION = '2.0'

type RunEventRow = { runId: string; sequence: number; type: string; payload: unknown; at: string }

export async function appendRunEvent(
  runId: string,
  workspaceId: string,
  type: string,
  payload?: unknown
): Promise<void> {
  const [next] = await db
    .select({ n: sql<number>`coalesce(max(${schema.runEvents.sequence}), 0) + 1` })
    .from(schema.runEvents)
    .where(eq(schema.runEvents.runId, runId))
  await db.insert(schema.runEvents).values({
    runId,
    workspaceId,
    sequence: Number(next!.n),
    type,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  })
}

export async function runEventsAfter(runId: string, after: number): Promise<RunEventRow[]> {
  const rows = await db
    .select()
    .from(schema.runEvents)
    .where(and(eq(schema.runEvents.runId, runId), sql`${schema.runEvents.sequence} > ${after}`))
    .orderBy(schema.runEvents.sequence)
  return rows.map((r) => ({
    runId: r.runId,
    sequence: Number(r.sequence),
    type: r.type,
    payload: r.payload,
    at: r.createdAt.toISOString(),
  }))
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.split(/\s+/).length * 1.3))
}

interface EvidenceOut {
  evidenceId: string
  documentId: string
  documentName: string
  versionId: string
  revisionNumber: number
  buildId: string
  chunkId: string
  quote: string
  physicalPage: number
  pageLabel: string | null
  adjacentContext: { before: string | null; after: string | null } | null
  locationPrecision: 'page'
}

function buildEvidence(selected: CandidateChunk[]): EvidenceOut[] {
  return selected.map((chunk, index) => ({
    evidenceId: `E${index + 1}`,
    documentId: chunk.documentId,
    documentName: chunk.documentTitle,
    versionId: chunk.versionId,
    revisionNumber: chunk.revisionNumber,
    buildId: chunk.buildId,
    chunkId: chunk.chunkId,
    quote: chunk.text,
    physicalPage: chunk.page,
    pageLabel: null,
    adjacentContext: null,
    locationPrecision: 'page' as const,
  }))
}

const SYSTEM_PROMPT = `You are Gnosis, an evidence-first question answering system.
Answer STRICTLY from the numbered evidence passages provided in the user message.
Rules:
- Every factual claim you make must be supported by one or more evidence passages; cite them by their numbers (e.g. "evidence": [1, 3]).
- If the passages do not contain the answer, or only cover part of the question, say so — never invent facts and never treat missing evidence as proof something is false.
- If passages conflict, set outcome to "conflicting_sources" and present each statement with its evidence numbers.
- Keep claims as single self-contained sentences.
Return ONLY a JSON object with this shape:
{
  "outcome": "answered" | "partial" | "conflicting_sources" | "insufficient_evidence" | "clarification_required",
  "claims": [{ "text": string, "evidence": number[] }],
  "limitations": string[]
}`

interface ModelAnswer {
  outcome: string
  claims: { text: string; evidence: number[] }[]
  limitations: string[]
}

function parseModelAnswer(content: string): ModelAnswer {
  const parsed = JSON.parse(content) as ModelAnswer
  return {
    outcome: parsed.outcome ?? 'insufficient_evidence',
    claims: Array.isArray(parsed.claims) ? parsed.claims : [],
    limitations: Array.isArray(parsed.limitations) ? parsed.limitations : [],
  }
}

/** Deterministic validation (spec §14.2): evidence-handle membership. */
function validateClaims(model: ModelAnswer, evidence: EvidenceOut[]) {
  const validEvidenceIds = new Set(evidence.map((e) => e.evidenceId))
  const claims = model.claims
    .map((claim) => {
      const ids = (claim.evidence ?? [])
        .map((n) => (Number.isInteger(n) && n >= 1 && n <= evidence.length ? `E${n}` : null))
        .filter((id): id is string => id !== null && validEvidenceIds.has(id))
      return { text: claim.text?.trim() ?? '', evidenceIds: [...new Set(ids)] }
    })
    .filter((claim) => claim.text.length > 0 && claim.evidenceIds.length > 0)
    .slice(0, 8)
  return claims
}

interface FinalResultOut {
  schemaVersion: string
  runId: string
  sessionId: string
  userMessageId: string | null
  assistantMessageId: string | null
  status: string
  outcome: string
  claims: unknown[]
  limitations: string[]
  conflicts: unknown[]
  evidence: unknown[]
  resolvedQuestion: string | null
  sourceSnapshot: unknown
  pipeline: unknown
  warnings: string[]
  checks: { claimsChecked: number; supported: number; failed: number; method: string }
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; status: string }
  judgmentUsage?: { inputTokens: number | null; outputTokens: number | null; status: string } | null
  timings: { queueMs: number; retrievalMs: number; generationMs: number; checkingMs: number; totalMs: number }
}

async function isCancelled(runId: string): Promise<boolean> {
  const [run] = await db
    .select({ status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))
    .limit(1)
  return run?.status === 'cancelling' || run?.status === 'cancelled'
}

export async function executeRun(runId: string): Promise<void> {
  const [run] = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))
    .limit(1)
  if (!run || run.status !== 'queued') return

  const startedAtMs = Date.now()
  const timings = { queueMs: 0, retrievalMs: 0, generationMs: 0, checkingMs: 0, totalMs: 0 }
  timings.queueMs = Math.max(0, Date.now() - run.createdAt.getTime())

  // Provider-stage cancellation: aborted when the run is cancelled so an
  // in-flight judgment or generation call stops promptly (spec §10.2).
  const stageAbort = new AbortController()

  const cancelNow = async () => {
    stageAbort.abort()
    await finalizeCancelled(runId, run.workspaceId)
  }

  try {
    // Re-resolve the actor at execution time; run creation once
    // succeeding is not proof permission still holds (spec §7.4).
    const [membership] = await db
      .select({ userId: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, run.workspaceId),
          eq(schema.workspaceMembers.userId, run.userId),
          eq(schema.workspaceMembers.status, 'active')
        )
      )
      .limit(1)
    if (!membership) {
      await finalizeCancelled(runId, run.workspaceId)
      return
    }

    await db
      .update(schema.runs)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(schema.runs.id, runId))
    await appendRunEvent(runId, run.workspaceId, 'run.started')

    // --- Retrieval over the captured snapshot ---
    const t0 = Date.now()
    const scope = run.scope as SearchScope
    const retrieval = await retrieve(run.workspaceId, scope, run.question, {
      runId,
      signal: stageAbort.signal,
    })
    timings.retrievalMs = Date.now() - t0
    await db.update(schema.runs).set({ details: retrieval.details }).where(eq(schema.runs.id, runId))
    await appendRunEvent(runId, run.workspaceId, 'retrieval.completed', {
      details: retrieval.details,
    })
    if (await isCancelled(runId)) return cancelNow()

    // Judgment provider usage is recorded separately from generation
    // usage and never overwrites it (spec §15.3, APP-09).
    const judgment = retrieval.details.judgment ?? null
    if (judgment && judgment.usage.status === 'known') {
      await db.insert(schema.usageEvents).values({
        workspaceId: run.workspaceId,
        runId,
        provider: 'typesafe',
        model: judgment.returnedModel ?? judgment.requestedModel,
        inputTokens: judgment.usage.inputTokens,
        outputTokens: judgment.usage.outputTokens,
      })
    }

    let evidence = buildEvidence(retrieval.selected)
    let outcome: ModelAnswer['outcome'] | 'insufficient_evidence' = 'insufficient_evidence'
    let claims: ReturnType<typeof validateClaims> = []
    let limitations: string[] = []
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    let usageStatus: 'known' | 'unavailable' = 'known'
    let generatorModel = 'none (no evidence retrieved)'
    const resultWarnings: string[] = []
    if (judgment && judgment.mode !== 'off' && judgment.status === 'fallback') {
      resultWarnings.push('Evidence ranking unavailable; standard search used.')
    }

    if (evidence.length === 0) {
      outcome = 'insufficient_evidence'
      limitations = [
        'Insufficient evidence in the selected documents to answer this question.',
        ...(scope.type === 'selected_documents'
          ? ['Try widening the search scope to all current documents.']
          : []),
      ]
    } else {
      // --- Context construction within the token budget ---
      let budget = limits.contextTokenBudget
      const included: EvidenceOut[] = []
      for (const item of evidence) {
        const cost = estimateTokens(item.quote)
        if (cost > budget && included.length > 0) break
        included.push(item)
        budget -= cost
      }
      const passages = included
        .map((e) => `[E${e.evidenceId.slice(1)}] (document: ${e.documentName}, revision ${e.revisionNumber}, page ${e.physicalPage})\n${e.quote}`)
        .join('\n\n')

      const provider = generationProvider()
      let model: ModelAnswer | null = null

      if (provider === 'none') {
        // Evidence-only mode (spec §14.3): with no generator
        // configured, the answer is constructed directly from the
        // authorized passages — claims are exact source sentences.
        const t1 = Date.now()
        const extractive = extractiveAnswer(run.question, included)
        timings.generationMs = Date.now() - t1
        generatorModel = 'extractive (no generator configured)'
        usageStatus = 'unavailable'
        outcome = extractive.outcome
        claims = extractive.claims
        limitations = extractive.limitations
        resultWarnings.push(
          'No generation provider is configured — this is an evidence-only extractive answer: every claim is an exact sentence from the cited passages, not generated text.'
        )
      } else {
        // --- Generation ---
        const t1 = Date.now()
        const generation = await generateJson(
          SYSTEM_PROMPT,
          `Question: ${run.question}\n\nEvidence passages:\n${passages}\n\nReturn the JSON answer now.`
        )
        timings.generationMs = Date.now() - t1
        usage = {
          promptTokens: generation.promptTokens,
          completionTokens: generation.completionTokens,
          totalTokens: generation.promptTokens + generation.completionTokens,
        }
        generatorModel = generation.model
        await db.insert(schema.usageEvents).values({
          workspaceId: run.workspaceId,
          runId,
          model: generatorModel,
          inputTokens: generation.promptTokens,
          outputTokens: generation.completionTokens,
        })
        model = parseModelAnswer(generation.content)
      }
      if (await isCancelled(runId)) return cancelNow()

      // --- Checking ---
      const t2 = Date.now()
      await appendRunEvent(runId, run.workspaceId, 'answer.checking')
      if (model) {
        claims = validateClaims(model, included)
        const allowed = [
          'answered',
          'partial',
          'conflicting_sources',
          'insufficient_evidence',
          'clarification_required',
        ]
        outcome = allowed.includes(model.outcome) ? model.outcome : 'insufficient_evidence'
        limitations = model.limitations.slice(0, 4)

        // Deterministic outcome corrections: a checked answer must have
        // supported claims; empty claims can never be "answered".
        if (outcome === 'answered' && claims.length === 0) {
          outcome = 'insufficient_evidence'
          limitations = [
            'The retrieved passages did not support any checkable claim for this question.',
          ]
        }
        // Claims not backed by supplied evidence are removed, never shown.
        const includedIds = new Set(included.map((e) => e.evidenceId))
        claims = claims
          .map((c) => ({
            ...c,
            evidenceIds: c.evidenceIds.filter((id) => includedIds.has(id)),
          }))
          .filter((c) => c.evidenceIds.length > 0)
        if (outcome !== 'insufficient_evidence' && claims.length === 0) {
          outcome = 'insufficient_evidence'
          limitations = ['Insufficient evidence in the selected documents to answer this question.']
        }
      }
      timings.checkingMs = Date.now() - t2
    }

    if (await isCancelled(runId)) return cancelNow()

    // Revalidate evidence against the CURRENT active builds and
    // lifecycle before publication (spec §11.3, RANK-16). Sources can
    // be deleted or replaced while generation was running.
    const revalidated = await revalidateEvidence(run.workspaceId, evidence)
    if (revalidated.removedChunkIds.length > 0) {
      if (scope.type === 'selected_documents') {
        await failSourceChanged(runId, run.workspaceId)
        return
      }
      resultWarnings.push('A source changed during this answer; affected evidence was removed.')
      const staleIds = new Set(revalidated.removedChunkIds)
      evidence = evidence.filter((e) => !staleIds.has(e.chunkId))
      const liveEvidenceIds = new Set(evidence.map((e) => e.evidenceId))
      claims = claims
        .map((c) => ({
          ...c,
          evidenceIds: c.evidenceIds.filter((id) => liveEvidenceIds.has(id)),
        }))
        .filter((c) => c.evidenceIds.length > 0)
      if (outcome === 'answered' && claims.length === 0) {
        outcome = 'insufficient_evidence'
        limitations = [
          'A source changed during this answer; the remaining documents do not answer it.',
        ]
      }
    }

    // --- Final publication: one transaction (spec §14.4) ---
    const result: FinalResultOut = {
      schemaVersion: V2_SCHEMA_VERSION,
      runId,
      sessionId: run.sessionId,
      userMessageId: null,
      assistantMessageId: null,
      status: 'completed',
      outcome,
      claims: claims.map((claim, i) => ({
        ordinal: i + 1,
        text: claim.text,
        evidenceIds: claim.evidenceIds,
        checkStatus: 'supported',
        checkNote: 'Citation checked against supplied evidence; semantic support not evaluated.',
      })),
      limitations,
      conflicts: [],
      evidence,
      resolvedQuestion: null,
      sourceSnapshot: {
        corpusGeneration: null,
        capturedAt: run.createdAt.toISOString(),
        scope,
        documents: retrieval.details.candidates
          .filter((c) => c.selected)
          .map((c) => ({
            id: c.documentId,
            name: c.documentName,
            revisionNumber: null,
            buildId: null,
          })),
      },
      pipeline: {
        embeddingModel:
          process.env.EMBEDDING_PROVIDER === 'openai'
            ? 'text-embedding-3-small (openai)'
            : `${process.env.EMBEDDING_MODEL ?? 'Xenova/bge-small-en-v1.5'} (local ONNX)`,
        generatorModel,
        reranker: null,
        retrieval: retrieval.details.candidates.some((c) => c.denseRank != null)
          ? 'dense+lexical-rrf'
          : 'lexical-rrf (degraded: dense unavailable)',
        mode: 'strict',
      },
      warnings: resultWarnings,
      checks: {
        claimsChecked: claims.length,
        supported: claims.length,
        failed: 0,
        method: 'citation_handle_membership',
      },
      usage: { ...usage, status: usageStatus },
      judgmentUsage: judgment?.usage ?? null,
      timings: { ...timings, totalMs: Date.now() - startedAtMs },
    }

    await db.transaction(async (tx) => {
      const [session] = await tx
        .select({ userId: schema.chatSessions.userId })
        .from(schema.chatSessions)
        .where(eq(schema.chatSessions.id, run.sessionId))
        .limit(1)
      void session
      const [userMessage] = await tx
        .select({ id: schema.messages.id, sequence: schema.messages.sequence })
        .from(schema.messages)
        .where(
          and(eq(schema.messages.sessionId, run.sessionId), eq(schema.messages.runId, runId), eq(schema.messages.role, 'user'))
        )
        .limit(1)
      const [assistant] = await tx
        .insert(schema.messages)
        .values({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          sequence: userMessage ? userMessage.sequence + 1 : 2,
          role: 'assistant',
          runId,
          content: { result },
        })
        .returning({ id: schema.messages.id })
      result.userMessageId = userMessage?.id ?? null
      result.assistantMessageId = assistant?.id ?? null

      // Fencing: only the worker holding a 'running' run may publish.
      // A cancellation committed first wins (APP-05); a stale worker
      // must not overwrite newer or terminal state (APP-04).
      const fenced = await tx
        .update(schema.runs)
        .set({
          status: 'completed',
          outcome,
          result,
          completedAt: new Date(),
        })
        .where(and(eq(schema.runs.id, runId), eq(schema.runs.status, 'running')))
        .returning({ id: schema.runs.id })
      if (fenced.length === 0) {
        throw new Error('stale_worker')
      }
      await tx.insert(schema.runEvents).values([
        {
          runId,
          workspaceId: run.workspaceId,
          sequence: sql`(select coalesce(max(sequence), 0) + 1 from run_events where run_id = ${runId})`,
          type: 'answer.final',
          payload: { result } as object,
        },
        {
          runId,
          workspaceId: run.workspaceId,
          sequence: sql`(select coalesce(max(sequence), 0) + 2 from run_events where run_id = ${runId})`,
          type: 'run.completed',
        },
      ])
      await tx
        .update(schema.chatSessions)
        .set({ updatedAt: new Date() })
        .where(eq(schema.chatSessions.id, run.sessionId))
      await tx
        .update(schema.jobs)
        .set({ state: 'complete', updatedAt: new Date() })
        .where(and(eq(schema.jobs.kind, 'answer'), eq(schema.jobs.refId, runId)))
    })
  } catch (err) {
    if (err instanceof Error && err.message === 'stale_worker') {
      console.warn(`[answers] run ${runId}: finalization lost the lease; stale publication skipped`)
      return
    }
    const message = err instanceof Error ? err.message : 'The run failed.'
    console.error(`[answers] run ${runId} failed:`, message)
    await db
      .update(schema.runs)
      .set({
        status: 'failed',
        errorCode: 'RUN_FAILED',
        errorMessage: 'The answer run failed. This is not a question outcome — try asking again.',
        errorRetryable: true,
        completedAt: new Date(),
      })
      .where(eq(schema.runs.id, runId))
    await appendRunEvent(runId, run.workspaceId, 'run.failed', {
      code: 'RUN_FAILED',
      message: 'The answer run failed.',
      retryable: true,
    })
  }
}

/**
 * Evidence-only answer construction (spec §14.3): claims are exact
 * source sentences whose terms overlap the question. Used when no
 * generation provider is configured.
 */
function extractiveAnswer(
  question: string,
  evidence: EvidenceOut[]
): {
  outcome: 'answered' | 'insufficient_evidence'
  claims: { text: string; evidenceIds: string[] }[]
  limitations: string[]
} {
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
  const claims: { text: string; evidenceIds: string[] }[] = []
  for (const item of evidence) {
    const sentences = item.quote.split(/(?<=[.!?:])\s+/)
    let best: { sentence: string; hits: number } | null = null
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase()
      const hits = terms.filter((t) => lower.includes(t) || (t.length >= 5 && lower.includes(t.slice(0, 5)))).length
      if (hits > 0 && (!best || hits > best.hits)) best = { sentence: sentence.trim(), hits }
    }
    if (best && !claims.some((c) => c.text === best!.sentence)) {
      claims.push({ text: best.sentence, evidenceIds: [item.evidenceId] })
    }
    if (claims.length >= 5) break
  }
  if (claims.length === 0) {
    return {
      outcome: 'insufficient_evidence',
      claims: [],
      limitations: ['Insufficient evidence in the selected documents to answer this question.'],
    }
  }
  return { outcome: 'answered', claims, limitations: [] }
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'been', 'have', 'has', 'had',
  'will', 'would', 'could', 'should', 'may', 'might', 'must', 'does', 'did',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'this', 'that', 'these', 'those', 'with', 'from', 'into', 'about', 'your',
  'you', 'are', 'not', 'can', 'its', 'their', 'there', 'been', 'being',
  'document', 'documents', 'tell', 'show', 'give', 'find', 'list',
])

async function finalizeCancelled(runId: string, workspaceId: string) {
  const fenced = await db
    .update(schema.runs)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(
      and(
        eq(schema.runs.id, runId),
        sql`${schema.runs.status} in ('queued','running','cancelling')`
      )
    )
    .returning({ id: schema.runs.id })
  if (fenced.length === 0) return
  await appendRunEvent(runId, workspaceId, 'run.cancelled')
}

/** Typed operational failure when strict selected scope can no longer
 *  be fulfilled because a source changed mid-run (spec §11.3). */
async function failSourceChanged(runId: string, workspaceId: string) {
  const fenced = await db
    .update(schema.runs)
    .set({
      status: 'failed',
      errorCode: 'SOURCE_CHANGED',
      errorMessage: 'A selected source changed during this answer. Start a new run with an updated scope.',
      errorRetryable: false,
      completedAt: new Date(),
    })
    .where(and(eq(schema.runs.id, runId), sql`${schema.runs.status} in ('running','cancelling')`))
    .returning({ id: schema.runs.id })
  if (fenced.length === 0) return
  await appendRunEvent(runId, workspaceId, 'run.failed', {
    code: 'SOURCE_CHANGED',
    message: 'A selected source changed during this answer.',
    retryable: false,
  })
}

/** Recheck that evidence chunks still belong to their documents'
 *  current active build and version, and that documents are active. */
async function revalidateEvidence(
  workspaceId: string,
  evidence: EvidenceOut[]
): Promise<{ removedChunkIds: string[] }> {
  if (evidence.length === 0) return { removedChunkIds: [] }
  const ids = evidence.map((e) => e.chunkId)
  const rows = await db
    .select({ id: schema.chunks.id })
    .from(schema.chunks)
    .innerJoin(schema.documents, eq(schema.documents.id, schema.chunks.documentId))
    .where(
      and(
        eq(schema.chunks.workspaceId, workspaceId),
        eq(schema.documents.lifecycle, 'active'),
        eq(schema.documents.activeBuildId, schema.chunks.buildId),
        eq(schema.documents.activeVersionId, schema.chunks.versionId),
        sql`${schema.chunks.id} = any(${uuidArrayLiteral(ids)}::uuid[])`
      )
    )
  const valid = new Set(rows.map((r) => r.id))
  return { removedChunkIds: ids.filter((id) => !valid.has(id)) }
}

export async function recentRuns(workspaceId: string, limit: number) {
  const rows = await db
    .select({
      runId: schema.runs.id,
      sessionId: schema.runs.sessionId,
      sessionTitle: schema.chatSessions.title,
      question: schema.runs.question,
      scope: schema.runs.scope,
      status: schema.runs.status,
      outcome: schema.runs.outcome,
      startedAt: schema.runs.startedAt,
      createdAt: schema.runs.createdAt,
      completedAt: schema.runs.completedAt,
      result: schema.runs.result,
      errorMessage: schema.runs.errorMessage,
    })
    .from(schema.runs)
    .leftJoin(schema.chatSessions, eq(schema.chatSessions.id, schema.runs.sessionId))
    .where(eq(schema.runs.workspaceId, workspaceId))
    .orderBy(desc(schema.runs.createdAt))
    .limit(limit)
  return rows.map((r) => {
    const result = r.result as { timings?: unknown; evidence?: unknown[] } | null
    return {
      runId: r.runId,
      sessionId: r.sessionId,
      sessionTitle: r.sessionTitle ?? 'Deleted session',
      question: r.question,
      scope: r.scope,
      status: r.status,
      outcome: r.outcome,
      startedAt: (r.startedAt ?? r.createdAt).toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
      timings: ((result as { timings?: object } | null)?.timings ?? null) as object | null,
      documentsCited: (result as { evidence?: unknown[] } | null)?.evidence?.length ?? 0,
      error: r.errorMessage,
    }
  })
}
