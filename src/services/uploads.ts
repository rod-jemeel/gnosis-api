/**
 * Upload flow (spec §11.1): the server chooses private staging keys and
 * issues a short-lived, narrowly scoped upload authorization. The client
 * never picks an object path. Confirmation validates actual bytes.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { config, limits } from '../config.js'
import { badRequest, conflict, notFound } from '../errors.js'
import type { TenantContext } from '../identity.js'
import { requireEditor } from './workspaces.js'
import { getFile, putFile, versionKey } from './storage.js'
import { enqueue } from '../queues/index.js'

const UPLOAD_TTL_SECONDS = 15 * 60

function sign(payload: string): string {
  const secret = process.env.UPLOAD_SIGNING_SECRET ?? `${config.DATABASE_URL}:uploads`
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function uploadToken(uploadId: string, expiresAt: number): string {
  const payload = `${uploadId}.${expiresAt}`
  return `${payload}.${sign(payload)}`
}

function verifyUploadToken(token: string): string {
  const parts = token.split('.')
  if (parts.length !== 3) throw badRequest('UPLOAD_TOKEN_INVALID', 'Malformed upload token.')
  const [uploadId, expiresAt, signature] = parts as [string, string, string]
  const expected = sign(`${uploadId}.${expiresAt}`)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw badRequest('UPLOAD_TOKEN_INVALID', 'Upload token signature is invalid.')
  }
  if (Number(expiresAt) < Date.now()) {
    throw badRequest('UPLOAD_TOKEN_EXPIRED', 'Upload authorization has expired.')
  }
  return uploadId
}

export async function createUpload(
  tenant: TenantContext,
  request: { fileName: string; sizeBytes: number; contentType: string }
) {
  requireEditor(tenant)
  if (request.contentType !== 'application/pdf') {
    throw badRequest('UNSUPPORTED_MEDIA_TYPE', 'Only PDF uploads are supported.')
  }
  if (request.sizeBytes > limits.maxUploadBytes) {
    throw badRequest(
      'UPLOAD_TOO_LARGE',
      `File exceeds the ${Math.round(limits.maxUploadBytes / 1024 / 1024)} MiB upload limit.`
    )
  }
  const [count] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.documents)
    .where(
      and(eq(schema.documents.workspaceId, tenant.workspaceId), eq(schema.documents.lifecycle, 'active'))
    )
  if (Number(count!.n) >= limits.maxDocumentsPerWorkspace) {
    throw conflict('DOCUMENT_QUOTA_EXCEEDED', 'Workspace document quota reached.')
  }

  const id = randomUUID()
  const stagingKey = `staging/${tenant.workspaceId}/${id}/${request.fileName.replace(/[^\w.-]+/g, '_')}`
  await db.insert(schema.uploadSessions).values({
    id,
    workspaceId: tenant.workspaceId,
    userId: tenant.userId,
    stagingKey,
    fileName: request.fileName,
    declaredBytes: request.sizeBytes,
    expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000),
  })

  const expiresAt = Date.now() + UPLOAD_TTL_SECONDS * 1000
  return {
    id,
    uploadUrl: `${config.API_URL}/v2/uploads/${id}/blob?token=${uploadToken(id, expiresAt)}`,
    method: 'PUT' as const,
    expiresAt: new Date(expiresAt).toISOString(),
    maxBytes: limits.maxUploadBytes,
  }
}

export async function acceptBlob(token: string, bytes: Buffer) {
  const uploadId = verifyUploadToken(token)
  const [session] = await db
    .select()
    .from(schema.uploadSessions)
    .where(eq(schema.uploadSessions.id, uploadId))
    .limit(1)
  if (!session) throw notFound('Upload session not found.')
  if (session.state !== 'created') throw conflict('UPLOAD_ALREADY_USED', 'Upload session already confirmed.')
  if (bytes.byteLength > limits.maxUploadBytes) {
    throw badRequest('UPLOAD_TOO_LARGE', 'Uploaded bytes exceed the limit.')
  }
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw badRequest('NOT_A_PDF', 'The uploaded bytes are not a PDF.')
  }
  await putFile(session.stagingKey, bytes)
}

export async function confirmUpload(
  tenant: TenantContext,
  uploadId: string,
  idempotencyKey: string
) {
  requireEditor(tenant)
  const [session] = await db
    .select()
    .from(schema.uploadSessions)
    .where(
      and(eq(schema.uploadSessions.id, uploadId), eq(schema.uploadSessions.workspaceId, tenant.workspaceId))
    )
    .limit(1)
  if (!session) throw notFound('Upload session not found.')

  // Idempotent confirmation: repeat with the same session returns the
  // original result without multiplying jobs (spec DOC-05).
  if (session.state === 'confirmed' && session.result) {
    return session.result as {
      documentId: string
      versionId: string
      buildId: string
      revisionNumber: number
    }
  }

  // Validate the actual staged object (not the declared size).
  const staged = await getFile(session.stagingKey).catch(() => null)
  if (!staged) {
    throw badRequest('UPLOAD_MISSING', 'No bytes were uploaded for this session.')
  }
  const contentHash = createHashOf(staged.bytes)

  const title =
    session.fileName.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim() || 'Untitled document'

  const accepted = await db.transaction<
    { documentId: string; versionId: string; buildId: string; revisionNumber: number }
  >(async (tx) => {
    const [document] = await tx
      .insert(schema.documents)
      .values({ workspaceId: tenant.workspaceId, title })
      .returning({ id: schema.documents.id })
    const revisionNumber = 1
    const storageKey = versionKey(tenant.workspaceId, document!.id, revisionNumber)
    const [version] = await tx
      .insert(schema.documentVersions)
      .values({
        workspaceId: tenant.workspaceId,
        documentId: document!.id,
        revisionNumber,
        storageKey,
        contentHash,
        sizeBytes: staged.bytes.byteLength,
        creatorEmail: null,
      })
      .returning({ id: schema.documentVersions.id })
    const [build] = await tx
      .insert(schema.indexBuilds)
      .values({
        workspaceId: tenant.workspaceId,
        documentId: document!.id,
        versionId: version!.id,
        revisionNumber,
        configHash: 'chunk:target=400:overlap=60',
        stageHistory: [{ stage: 'queued', detail: null, at: new Date().toISOString() }],
      })
      .returning({ id: schema.indexBuilds.id })
    await tx.insert(schema.jobs).values({
      workspaceId: tenant.workspaceId,
      kind: 'ingest',
      refId: build!.id,
    })
    const result = {
      documentId: document!.id,
      versionId: version!.id,
      buildId: build!.id,
      revisionNumber,
    }
    await tx
      .update(schema.uploadSessions)
      .set({ state: 'confirmed', result })
      .where(eq(schema.uploadSessions.id, uploadId))
    return result
  })

  // Copy verified bytes to the immutable version key (spec §11.1
  // time-of-check/time-of-use protection).
  await putFile(versionKey(tenant.workspaceId, accepted.documentId, 1), staged.bytes)
  await enqueue('ingestion', accepted.buildId)
  return accepted
}

function createHashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
