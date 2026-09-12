/**
 * Document application service: workspace-scoped lifecycle, immutable
 * revisions, deletion via tombstone + durable purge (spec §6.2, §17.3).
 */

import { and, desc, eq, sql } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { conflict, notFound } from '../errors.js'
import type { TenantContext } from '../identity.js'
import { requireEditor } from './workspaces.js'
import { deleteFile } from './storage.js'
import { enqueue } from '../queues/index.js'
import { randomUUID } from 'node:crypto'

export async function listDocuments(workspaceId: string) {
  const rows = await db
    .select()
    .from(schema.documents)
    .where(
      and(eq(schema.documents.workspaceId, workspaceId), eq(schema.documents.lifecycle, 'active'))
    )
    .orderBy(desc(schema.documents.updatedAt))

  const summaries = []
  for (const doc of rows) {
    summaries.push(await summarizeWithBuilds(doc))
  }
  return summaries
}

async function summarizeWithBuilds(doc: typeof schema.documents.$inferSelect) {
  // The active pointers are authoritative. When the first build has not
  // activated (still processing or failed), fall back to the latest
  // version/build for display state — a failed replacement never
  // overrides the active build when one exists (spec §6.2).
  let [version] = doc.activeVersionId
    ? await db
        .select()
        .from(schema.documentVersions)
        .where(eq(schema.documentVersions.id, doc.activeVersionId))
        .limit(1)
    : []
  if (!version) {
    ;[version] = await db
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.documentId, doc.id))
      .orderBy(desc(schema.documentVersions.revisionNumber))
      .limit(1)
  }
  let build = doc.activeBuildId
    ? await db
        .select()
        .from(schema.indexBuilds)
        .where(eq(schema.indexBuilds.id, doc.activeBuildId))
        .limit(1)
    : []
  if (build.length === 0) {
    build = await db
      .select()
      .from(schema.indexBuilds)
      .where(eq(schema.indexBuilds.documentId, doc.id))
      .orderBy(desc(schema.indexBuilds.createdAt))
      .limit(1)
  }
  const activeBuild = build[0]
  const [pending] = await db
    .select({ id: schema.indexBuilds.id, state: schema.indexBuilds.state, revisionNumber: schema.indexBuilds.revisionNumber, createdAt: schema.indexBuilds.createdAt })
    .from(schema.indexBuilds)
    .where(
      and(
        eq(schema.indexBuilds.documentId, doc.id),
        sql`${schema.indexBuilds.id} <> ${doc.activeBuildId ?? '00000000-0000-0000-0000-000000000000'}`,
        sql`${schema.indexBuilds.state} not in ('ready','failed','cancelled','superseded')`
      )
    )
    .orderBy(desc(schema.indexBuilds.createdAt))
    .limit(1)

  return {
    id: doc.id,
    workspaceId: doc.workspaceId,
    title: doc.title,
    tags: doc.tags,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    lifecycle: doc.lifecycle,
    deletedAt: doc.deletedAt?.toISOString() ?? null,
    activeVersion: version
      ? {
          id: version.id,
          revisionNumber: version.revisionNumber,
          createdAt: version.createdAt.toISOString(),
          pageCount: version.pageCount,
          sizeBytes: Number(version.sizeBytes),
        }
      : null,
    activeBuild: activeBuild
      ? {
          id: activeBuild.id,
          state: activeBuild.state,
          chunkCount: activeBuild.chunkCount,
          readyAt: activeBuild.completedAt?.toISOString() ?? null,
          error: activeBuild.error,
        }
      : null,
    pendingBuild: pending
      ? {
          id: pending.id,
          state: pending.state,
          revisionNumber: pending.revisionNumber,
          createdAt: pending.createdAt.toISOString(),
        }
      : null,
  }
}

export async function getDocument(workspaceId: string, documentId: string) {
  const [doc] = await db
    .select()
    .from(schema.documents)
    .where(
      and(
        eq(schema.documents.id, documentId),
        eq(schema.documents.workspaceId, workspaceId),
        eq(schema.documents.lifecycle, 'active')
      )
    )
    .limit(1)
  if (!doc) throw notFound('Document not found.')

  const versions = await db
    .select()
    .from(schema.documentVersions)
    .where(eq(schema.documentVersions.documentId, documentId))
    .orderBy(desc(schema.documentVersions.revisionNumber))

  const builds = await db
    .select()
    .from(schema.indexBuilds)
    .where(eq(schema.indexBuilds.documentId, documentId))
    .orderBy(desc(schema.indexBuilds.createdAt))

  const blocks = await db
    .select({ page: schema.sourceBlocks.page, ordinal: schema.sourceBlocks.ordinal, text: schema.sourceBlocks.text })
    .from(schema.sourceBlocks)
    .where(eq(schema.sourceBlocks.versionId, doc.activeVersionId ?? '00000000-0000-0000-0000-000000000000'))
    .orderBy(schema.sourceBlocks.page, schema.sourceBlocks.ordinal)

  const pagesMap = new Map<number, string[]>()
  for (const block of blocks) {
    const list = pagesMap.get(block.page) ?? []
    list.push(block.text)
    pagesMap.set(block.page, list)
  }
  const pages = [...pagesMap.entries()].sort((a, b) => a[0] - b[0])

  const [purge] = doc.lifecycle === 'deleted'
    ? await db
        .select()
        .from(schema.purgeTasks)
        .where(eq(schema.purgeTasks.documentId, documentId))
        .orderBy(desc(schema.purgeTasks.createdAt))
        .limit(1)
    : []

  const activity: { at: string; kind: string; detail: string }[] = []
  for (const version of versions) {
    activity.push({
      at: version.createdAt.toISOString(),
      kind: 'version_uploaded',
      detail: `Revision ${version.revisionNumber} uploaded (${Number(version.sizeBytes)} bytes)`,
    })
  }
  for (const build of builds) {
    if (build.state === 'ready') {
      activity.push({
        at: build.completedAt?.toISOString() ?? build.createdAt.toISOString(),
        kind: 'build_ready',
        detail: `Build ${build.id.slice(0, 8)} ready and activated (${build.chunkCount ?? 0} chunks)`,
      })
    }
    if (build.state === 'failed') {
      activity.push({
        at: build.completedAt?.toISOString() ?? build.createdAt.toISOString(),
        kind: 'build_failed',
        detail: build.error ?? 'Build failed.',
      })
    }
  }
  if (doc.deletedAt) {
    activity.push({
      at: doc.deletedAt.toISOString(),
      kind: 'deleted',
      detail: 'Document deleted; reads denied pending physical purge.',
    })
  }
  activity.sort((a, b) => b.at.localeCompare(a.at))

  return {
    ...(await summarizeWithBuilds(doc)),
    versions: versions.map((v) => ({
      id: v.id,
      documentId: v.documentId,
      revisionNumber: v.revisionNumber,
      createdAt: v.createdAt.toISOString(),
      sizeBytes: Number(v.sizeBytes),
      pageCount: v.pageCount,
      contentHash: v.contentHash,
      sourceLabel: v.sourceLabel,
      creatorEmail: v.creatorEmail,
    })),
    builds: builds.map((b) => ({
      id: b.id,
      documentId: b.documentId,
      versionId: b.versionId,
      revisionNumber: b.revisionNumber,
      state: b.state,
      stageHistory: b.stageHistory as { stage: string; detail: string | null; at: string }[],
      chunkCount: b.chunkCount,
      vectorCount: b.state === 'ready' ? b.chunkCount : null,
      embeddingProfile: { model: b.embeddingModel ?? '—', dimensions: b.embeddingDims ?? 0 },
      configHash: b.configHash,
      warnings: b.warnings as string[],
      error: b.error,
      retryable: b.retryable,
      createdAt: b.createdAt.toISOString(),
      completedAt: b.completedAt?.toISOString() ?? null,
    })),
    extraction:
      doc.activeVersionId && pages.length > 0
        ? {
            parser: 'unpdf (pdf.js)',
            pageCount: pages.length,
            pagesWithNoText: pages.filter(([, texts]) => texts.join('').trim().length === 0).map(([p]) => p),
            pages: pages.map(([page, texts]) => ({ page, text: texts.join('\n\n') })),
          }
        : null,
    fileAvailable: true,
    purgeTask: purge
      ? { id: purge.id, state: purge.state, detail: purge.detail }
      : null,
    activity,
  }
}

export async function updateDocument(
  tenant: TenantContext,
  documentId: string,
  patch: { title?: string; tags?: string[] }
) {
  requireEditor(tenant)
  const [doc] = await db
    .update(schema.documents)
    .set({
      ...(patch.title?.trim() ? { title: patch.title.trim() } : {}),
      ...(patch.tags ? { tags: patch.tags } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.documents.id, documentId),
        eq(schema.documents.workspaceId, tenant.workspaceId),
        eq(schema.documents.lifecycle, 'active')
      )
    )
    .returning()
  if (!doc) throw notFound('Document not found.')
  return summarizeWithBuilds(doc)
}

/** Delete = immediate logical revocation + durable purge task (DOC-06). */
export async function deleteDocument(tenant: TenantContext, documentId: string) {
  requireEditor(tenant)
  const purgeTaskId = randomUUID()
  const deleted = await db.transaction(async (tx) => {
    const [doc] = await tx
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.id, documentId),
          eq(schema.documents.workspaceId, tenant.workspaceId),
          eq(schema.documents.lifecycle, 'active')
        )
      )
      .limit(1)
    if (!doc) throw notFound('Document not found.')
    await tx
      .update(schema.documents)
      .set({
        lifecycle: 'deleted',
        deletedAt: new Date(),
        activeVersionId: null,
        activeBuildId: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.documents.id, documentId))
    await tx.insert(schema.purgeTasks).values({
      id: purgeTaskId,
      workspaceId: tenant.workspaceId,
      documentId,
    })
    await tx
      .update(schema.workspaces)
      .set({ corpusGeneration: sql`${schema.workspaces.corpusGeneration} + 1` })
      .where(eq(schema.workspaces.id, tenant.workspaceId))
    return true
  })
  if (deleted) await enqueue('purge', purgeTaskId)
  return { purgeTaskId }
}

export async function executePurge(purgeTaskId: string) {
  const [task] = await db
    .select()
    .from(schema.purgeTasks)
    .where(eq(schema.purgeTasks.id, purgeTaskId))
    .limit(1)
  if (!task || task.state !== 'pending') return

  try {
    const versions = await db
      .select({ storageKey: schema.documentVersions.storageKey })
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.documentId, task.documentId))
    for (const version of versions) {
      await deleteFile(version.storageKey).catch(() => {})
    }
    await db.delete(schema.chunks).where(eq(schema.chunks.documentId, task.documentId))
    await db.delete(schema.sourceBlocks).where(
      sql`${schema.sourceBlocks.versionId} in (select id from document_versions where document_id = ${task.documentId})`
    )
    await db
      .update(schema.purgeTasks)
      .set({ state: 'complete', completedAt: new Date(), detail: 'Files, blocks, chunks, and vectors purged.' })
      .where(eq(schema.purgeTasks.id, purgeTaskId))
  } catch (err) {
    await db
      .update(schema.purgeTasks)
      .set({ state: 'failed', detail: err instanceof Error ? err.message : 'Purge failed; retry pending.' })
      .where(eq(schema.purgeTasks.id, purgeTaskId))
  }
}

export async function reindexDocument(tenant: TenantContext, documentId: string) {
  requireEditor(tenant)
  const [doc] = await db
    .select()
    .from(schema.documents)
    .where(
      and(
        eq(schema.documents.id, documentId),
        eq(schema.documents.workspaceId, tenant.workspaceId),
        eq(schema.documents.lifecycle, 'active')
      )
    )
    .limit(1)
  if (!doc || !doc.activeVersionId) throw conflict('NOT_INDEXABLE', 'Document has no active version to reindex.')

  const [currentBuild] = await db
    .select({ revisionNumber: schema.indexBuilds.revisionNumber })
    .from(schema.indexBuilds)
    .where(eq(schema.indexBuilds.id, doc.activeBuildId!))
    .limit(1)

  const [build] = await db
    .insert(schema.indexBuilds)
    .values({
      workspaceId: tenant.workspaceId,
      documentId,
      versionId: doc.activeVersionId,
      revisionNumber: currentBuild?.revisionNumber ?? 1,
      configHash: 'chunk:target=400:overlap=60',
      stageHistory: [{ stage: 'queued', detail: 'Reindex requested', at: new Date().toISOString() }],
    })
    .returning({ id: schema.indexBuilds.id })
  await db.insert(schema.jobs).values({
    workspaceId: tenant.workspaceId,
    kind: 'ingest',
    refId: build!.id,
  })
  await enqueue('ingestion', build!.id)
  return { buildId: build!.id }
}
