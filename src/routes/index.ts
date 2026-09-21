/**
 * /v2 HTTP routes (spec §15.2). All protected routes verify identity and
 * resolve workspace membership server-side; a workspace path is scope,
 * never authentication.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { config, limits } from '../config.js'
import { badRequest, errorHandler, notFound, unauthorized } from '../errors.js'
import { identify, type TenantContext } from '../identity.js'
import {
  ensureWorkspace,
  listMembers,
  requireEditor,
  tenantContext,
  workspaceDetail,
  workspaceSummaries,
} from '../services/workspaces.js'
import { acceptBlob, confirmUpload, createUpload } from '../services/uploads.js'
import {
  deleteDocument,
  getDocument,
  listDocuments,
  reindexDocument,
  updateDocument,
} from '../services/documents.js'
import { retryBuild } from '../services/ingestion.js'
import {
  createSession,
  deleteSession,
  listSessions,
  renameSession,
  requireOwnedSession,
  sessionTurns,
} from '../services/sessions.js'
import {
  appendRunEvent,
  recentRuns,
  runEventsAfter,
  V2_SCHEMA_VERSION,
} from '../services/answers.js'
import { eligibleBuilds, type SearchScope } from '../services/retrieval.js'
import { enqueue, removeQueueJob } from '../queues/index.js'
import { getFile } from '../services/storage.js'

type Vars = { Variables: { identity: { userId: string; email: string | null }; tenant: TenantContext; requestId: string } }

export const app = new Hono<Vars>()

/* Explicit CORS origins (spec §17.1). */
const allowedOrigins = config.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
app.use('*', cors({
  origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
  allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}))

/* Request id + identity on every request. */
app.use('*', async (c, next) => {
  c.set('requestId', randomUUID())
  await next()
})
app.onError((err, c) => errorHandler(err, c))

const v2 = new Hono<Vars>()
v2.use('*', identify)

/* ------------------------------------------------------------------ */
/* Workspaces                                                          */
/* ------------------------------------------------------------------ */

v2.get('/workspaces', async (c) => {
  const identity = c.get('identity')
  await ensureWorkspace(identity)
  return c.json(await workspaceSummaries(identity.userId))
})

v2.post('/workspaces', async (c) => {
  const identity = c.get('identity')
  const workspaceId = await ensureWorkspace(identity)
  const summaries = await workspaceSummaries(identity.userId)
  return c.json(summaries.find((s) => s.id === workspaceId) ?? summaries[0]!)
})

/** Resolve tenant context for all workspace-scoped routes. */
v2.use('/workspaces/:workspaceId/*', async (c, next) => {
  const tenant = await tenantContext(c.req.param('workspaceId'), c.get('identity'))
  c.set('tenant', tenant)
  await next()
})

v2.get('/workspaces/:workspaceId', async (c) => c.json(await workspaceDetail(c.get('tenant').workspaceId)))

v2.get('/workspaces/:workspaceId/members', async (c) => {
  const members = await listMembers(c.get('tenant').workspaceId)
  return c.json({ items: members, nextCursor: null })
})

/* ------------------------------------------------------------------ */
/* Uploads                                                             */
/* ------------------------------------------------------------------ */

v2.post('/workspaces/:workspaceId/uploads', async (c) => {
  const body = await c.req.json<{ fileName?: string; sizeBytes?: number; contentType?: string }>()
  if (!body.fileName || typeof body.sizeBytes !== 'number' || !body.contentType) {
    throw badRequest('INVALID_REQUEST', 'fileName, sizeBytes, and contentType are required.')
  }
  const session = await createUpload(c.get('tenant'), {
    fileName: body.fileName,
    sizeBytes: body.sizeBytes,
    contentType: body.contentType,
  })
  return c.json(session, 201)
})

/* Byte transfer endpoint targeted by the signed uploadUrl. The client
 * sends only the token (no bearer token in URLs). */
const blob = new Hono<Vars>()
blob.put('/v2/uploads/:uploadId/blob', async (c) => {
  const token = c.req.query('token')
  if (!token) throw unauthorized('Upload token missing.')
  const bytes = Buffer.from(await c.req.arrayBuffer())
  await acceptBlob(token, bytes)
  return c.body(null, 204)
})
app.route('/', blob)

v2.post('/workspaces/:workspaceId/uploads/:uploadId/confirm', async (c) => {
  const body = await c.req.json<{ idempotencyKey?: string }>().catch(() => ({}) as { idempotencyKey?: string })
  const accepted = await confirmUpload(
    c.get('tenant'),
    c.req.param('uploadId'),
    body.idempotencyKey ?? randomUUID()
  )
  return c.json(accepted, 202)
})

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

v2.get('/workspaces/:workspaceId/documents', async (c) =>
  c.json({ items: await listDocuments(c.get('tenant').workspaceId), nextCursor: null })
)

v2.get('/workspaces/:workspaceId/documents/:documentId', async (c) =>
  c.json(await getDocument(c.get('tenant').workspaceId, c.req.param('documentId')))
)

v2.patch('/workspaces/:workspaceId/documents/:documentId', async (c) => {
  const body = await c.req.json<{ title?: string; tags?: string[] }>()
  return c.json(await updateDocument(c.get('tenant'), c.req.param('documentId'), body))
})

v2.delete('/workspaces/:workspaceId/documents/:documentId', async (c) => {
  const result = await deleteDocument(c.get('tenant'), c.req.param('documentId'))
  return c.json(result, 202)
})

v2.post('/workspaces/:workspaceId/documents/:documentId/reindex', async (c) => {
  const result = await reindexDocument(c.get('tenant'), c.req.param('documentId'))
  return c.json(result, 202)
})

v2.post('/workspaces/:workspaceId/builds/:buildId/retry', async (c) => {
  requireEditor(c.get('tenant'))
  const buildId = c.req.param('buildId')
  await retryBuild(c.get('tenant'), buildId)
  // Remove any prior BullMQ job so the re-add is not deduplicated away
  // (state-level idempotency lives in the database).
  await removeQueueJob('ingestion', `ingest-${buildId}`)
  await enqueue('ingestion', buildId)
  return c.json({}, 202)
})

v2.get(
  '/workspaces/:workspaceId/documents/:documentId/versions/:versionId/file',
  async (c) => {
    const tenant = c.get('tenant')
    const [version] = await db
      .select({ storageKey: schema.documentVersions.storageKey })
      .from(schema.documentVersions)
      .where(
        and(
          eq(schema.documentVersions.id, c.req.param('versionId')),
          eq(schema.documentVersions.workspaceId, tenant.workspaceId)
        )
      )
      .limit(1)
    if (!version) throw notFound('File not found.')
    // Authorized private proxy: access is checked per request.
    const file = await getFile(version.storageKey)
    return c.body(new Uint8Array(file.bytes), 200, {
      'Content-Type': file.contentType,
      'Content-Disposition': 'inline',
    })
  }
)

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

v2.get('/workspaces/:workspaceId/sessions', async (c) =>
  c.json({ items: await listSessions(c.get('tenant')), nextCursor: null })
)

v2.post('/workspaces/:workspaceId/sessions', async (c) => {
  const body = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string })
  const session = await createSession(c.get('tenant'), body.title ?? 'New chat')
  return c.json(
    {
      id: session.id,
      workspaceId: session.workspaceId,
      title: session.title,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      messageCount: 0,
    },
    201
  )
})

v2.patch('/workspaces/:workspaceId/sessions/:sessionId', async (c) => {
  const body = await c.req.json<{ title?: string }>()
  await renameSession(c.get('tenant'), c.req.param('sessionId'), body.title ?? '')
  return c.json({})
})

v2.delete('/workspaces/:workspaceId/sessions/:sessionId', async (c) => {
  await deleteSession(c.get('tenant'), c.req.param('sessionId'))
  return c.json({})
})

v2.get('/workspaces/:workspaceId/sessions/:sessionId/messages', async (c) =>
  c.json(await sessionTurns(c.get('tenant'), c.req.param('sessionId')))
)

/* ------------------------------------------------------------------ */
/* Runs: two-step durable protocol                                     */
/* ------------------------------------------------------------------ */

v2.post('/workspaces/:workspaceId/sessions/:sessionId/runs', async (c) => {
  const tenant = c.get('tenant')
  const session = await requireOwnedSession(tenant, c.req.param('sessionId'))
  const body = await c.req.json<{
    question?: string
    scope?: SearchScope
    mode?: string
    clientMessageId?: string
  }>()
  const question = body.question?.trim()
  if (!question) throw badRequest('INVALID_REQUEST', 'A question is required.')
  if (question.length > limits.questionMaxBytes) {
    throw badRequest('QUESTION_TOO_LARGE', 'The question exceeds the size limit.')
  }

  // Explicit scope semantics (RET-01): an empty list never means "all".
  const scope: SearchScope =
    body.scope?.type === 'selected_documents'
      ? (() => {
          if (body.scope!.documentIds.length === 0) {
            throw badRequest(
              'INVALID_SCOPE',
              'An empty document selection is not a valid scope; choose "All current documents".'
            )
          }
          if (body.scope!.documentIds.length > limits.maxSelectedDocuments) {
            throw badRequest('INVALID_SCOPE', `At most ${limits.maxSelectedDocuments} documents can be selected.`)
          }
          return body.scope!
        })()
      : { type: 'all_current' }

  // Unavailable selected sources refuse the question before any model
  // call (RET-01).
  const eligibleIds = new Set(
    (await eligibleBuilds(tenant.workspaceId, scope)).map((d) => d.documentId)
  )
  if (scope.type === 'selected_documents' && scope.documentIds.some((id) => !eligibleIds.has(id))) {
    throw badRequest(
      'SCOPE_UNAVAILABLE',
      'One or more selected documents are unavailable. Update the search scope and try again.'
    )
  }

  const idempotencyKey = c.req.header('idempotency-key') || body.clientMessageId || randomUUID()

  // Idempotent creation: same key returns the same run (§15.1).
  const [existing] = await db
    .select({ id: schema.runs.id, status: schema.runs.status })
    .from(schema.runs)
    .where(
      and(eq(schema.runs.sessionId, session.id), eq(schema.runs.idempotencyKey, idempotencyKey))
    )
    .limit(1)
  if (existing) {
    return c.json({
      schemaVersion: V2_SCHEMA_VERSION,
      runId: existing.id,
      status: existing.status,
      eventsPath: `/v2/workspaces/${tenant.workspaceId}/runs/${existing.id}/events`,
    })
  }

  const runId = randomUUID()
  await db.transaction(async (tx) => {
    const [next] = await tx
      .select({ n: sql<number>`coalesce(max(${schema.messages.sequence}), 0) + 1` })
      .from(schema.messages)
      .where(eq(schema.messages.sessionId, session.id))
    const sequence = Number(next!.n)
    await tx.insert(schema.messages).values({
      workspaceId: tenant.workspaceId,
      sessionId: session.id,
      sequence,
      role: 'user',
      runId,
      content: { text: question, scope },
    })
    await tx.insert(schema.runs).values({
      id: runId,
      workspaceId: tenant.workspaceId,
      sessionId: session.id,
      userId: tenant.userId,
      question,
      scope,
      mode: 'strict',
      idempotencyKey,
    })
    await tx.insert(schema.jobs).values({
      workspaceId: tenant.workspaceId,
      kind: 'answer',
      refId: runId,
    })
    if (sequence === 1) {
      await tx
        .update(schema.chatSessions)
        .set({
          title: question.length > 48 ? `${question.slice(0, 48).trimEnd()}…` : question,
        })
        .where(eq(schema.chatSessions.id, session.id))
    }
  })
  await appendRunEvent(runId, tenant.workspaceId, 'run.queued', { clientMessageId: idempotencyKey })
  await enqueue('answers', runId)

  return c.json(
    {
      schemaVersion: V2_SCHEMA_VERSION,
      runId,
      status: 'queued',
      eventsPath: `/v2/workspaces/${tenant.workspaceId}/runs/${runId}/events`,
    },
    202
  )
})

v2.get('/workspaces/:workspaceId/runs/:runId', async (c) => {
  const tenant = c.get('tenant')
  const [run] = await db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.id, c.req.param('runId')), eq(schema.runs.workspaceId, tenant.workspaceId)))
    .limit(1)
  if (!run) throw notFound('Run not found.')
  return c.json({
    status: run.status,
    result: run.result,
    error:
      run.errorCode != null
        ? { code: run.errorCode, message: run.errorMessage, retryable: run.errorRetryable }
        : null,
  })
})

/** Idempotent cancellation (spec §16.3). */
v2.post('/workspaces/:workspaceId/runs/:runId/cancel', async (c) => {
  const tenant = c.get('tenant')
  const [run] = await db
    .select({ id: schema.runs.id, status: schema.runs.status })
    .from(schema.runs)
    .where(and(eq(schema.runs.id, c.req.param('runId')), eq(schema.runs.workspaceId, tenant.workspaceId)))
    .limit(1)
  if (!run) throw notFound('Run not found.')
  if (run.status === 'completed' || run.status === 'cancelling') {
    return c.json({}) // completion committed first / cancellation already pending
  }
  if (run.status === 'queued') {
    await db
      .update(schema.runs)
      .set({ status: 'cancelled', completedAt: new Date() })
      .where(eq(schema.runs.id, run.id))
    await appendRunEvent(run.id, tenant.workspaceId, 'run.cancelled')
  } else if (run.status === 'running') {
    await db.update(schema.runs).set({ status: 'cancelling' }).where(eq(schema.runs.id, run.id))
  }
  return c.json({})
})

/** SSE: durable event replay by sequence cursor (spec §16.1/16.2). */
v2.get('/workspaces/:workspaceId/runs/:runId/events', async (c) => {
  const tenant = c.get('tenant')
  const [run] = await db
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(and(eq(schema.runs.id, c.req.param('runId')), eq(schema.runs.workspaceId, tenant.workspaceId)))
    .limit(1)
  if (!run) throw notFound('Run not found.')

  let after = Number(c.req.query('after') ?? 0) || 0
  const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'])

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let closed = false
      const send = (payload: string) => {
        if (!closed) controller.enqueue(encoder.encode(payload))
      }
      const close = () => {
        if (!closed) {
          closed = true
          controller.close()
        }
      }
      c.req.raw.signal.addEventListener('abort', close)

      const started = Date.now()
      for (;;) {
        const events = await runEventsAfter(run.id, after)
        for (const event of events) {
          after = event.sequence
          send(`data: ${JSON.stringify({ ...event, schemaVersion: V2_SCHEMA_VERSION })}\n\n`)
          if (TERMINAL.has(event.type)) {
            close()
            return
          }
        }
        // Keep-alive comments every ~15s (spec §16.2).
        if (Date.now() - started > 15_000) {
          send(': keep-alive\n\n')
        }
        if (closed) return
        await new Promise((r) => setTimeout(r, 250))
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

v2.get('/workspaces/:workspaceId/runs/:runId/diagnostics', async (c) => {
  const tenant = c.get('tenant')
  const [run] = await db
    .select({ details: schema.runs.details })
    .from(schema.runs)
    .where(and(eq(schema.runs.id, c.req.param('runId')), eq(schema.runs.workspaceId, tenant.workspaceId)))
    .limit(1)
  if (!run) throw notFound('Run not found.')
  return c.json(run.details)
})

v2.get('/workspaces/:workspaceId/runs', async (c) =>
  c.json(await recentRuns(c.get('tenant').workspaceId, 25))
)

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

app.get('/health/live', (c) => c.json({ ok: true }))

app.route('/v2', v2)

export function exportApp() {
  return app
}
void config
