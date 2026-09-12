/**
 * Workspace application service: auto-provisioning of the personal
 * workspace, membership resolution (the tenant context), quotas.
 */

import { and, eq, sql } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { notFound } from '../errors.js'
import { limits } from '../config.js'
import type { Identity, TenantContext } from '../identity.js'

export async function ensureWorkspace(identity: Identity) {
  const existing = await db
    .select({ workspaceId: schema.workspaceMembers.workspaceId })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.userId, identity.userId),
        eq(schema.workspaceMembers.status, 'active')
      )
    )
    .limit(1)

  if (existing.length > 0) return existing[0]!.workspaceId

  // Workspace creation and owner-membership insertion are one
  // transaction (spec §4.1).
  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(schema.workspaces)
      .values({ name: identity.email ? `${identity.email.split('@')[0]}'s workspace` : 'Personal workspace' })
      .returning({ id: schema.workspaces.id })
    await tx.insert(schema.workspaceMembers).values({
      workspaceId: workspace!.id,
      userId: identity.userId,
      email: identity.email,
      role: 'owner',
    })
    return workspace!.id
  })
}

/** Resolve verified membership into a server-owned tenant context. */
export async function tenantContext(
  workspaceId: string,
  identity: Identity
): Promise<TenantContext> {
  const rows = await db
    .select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        eq(schema.workspaceMembers.userId, identity.userId),
        eq(schema.workspaceMembers.status, 'active')
      )
    )
    .limit(1)
  if (rows.length === 0) {
    // Consistent 404 without existence disclosure (spec §4.2).
    throw notFound('Workspace not found.')
  }
  return {
    workspaceId,
    userId: identity.userId,
    role: rows[0]!.role as TenantContext['role'],
  }
}

export function requireEditor(tenant: TenantContext) {
  if (tenant.role !== 'owner' && tenant.role !== 'editor') {
    throw notFound('Workspace not found.')
  }
}

export async function workspaceSummaries(userId: string) {
  const rows = await db
    .select({
      id: schema.workspaces.id,
      name: schema.workspaces.name,
      role: schema.workspaceMembers.role,
      createdAt: schema.workspaces.createdAt,
      documentCount: sql<number>`(
        select count(*) from ${schema.documents}
        where ${schema.documents.workspaceId} = ${schema.workspaces.id}
          and ${schema.documents.lifecycle} = 'active'
      )`,
    })
    .from(schema.workspaceMembers)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
    .where(
      and(
        eq(schema.workspaceMembers.userId, userId),
        eq(schema.workspaceMembers.status, 'active')
      )
    )
  return rows.map((r) => ({ ...r, documentCount: Number(r.documentCount) }))
}

export async function workspaceDetail(workspaceId: string) {
  const [workspace] = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1)
  if (!workspace) throw notFound('Workspace not found.')

  const [usage] = await db
    .select({
      documentCount: sql<number>`(
        select count(*) from ${schema.documents}
        where ${schema.documents.workspaceId} = ${workspaceId} and ${schema.documents.lifecycle} = 'active'
      )`,
      sourceBytes: sql<number>`(
        select coalesce(sum(${schema.documentVersions.sizeBytes}), 0) from ${schema.documentVersions}
        where ${schema.documentVersions.workspaceId} = ${workspaceId}
      )`,
      activeChunks: sql<number>`(
        select count(*) from ${schema.chunks}
        where ${schema.chunks.workspaceId} = ${workspaceId}
          and ${schema.chunks.buildId} in (
            select ${schema.documents.activeBuildId} from ${schema.documents}
            where ${schema.documents.workspaceId} = ${workspaceId}
              and ${schema.documents.lifecycle} = 'active'
              and ${schema.documents.activeBuildId} is not null
          )
      )`,
      runsThisMonth: sql<number>`(
        select count(*) from ${schema.runs}
        where ${schema.runs.workspaceId} = ${workspaceId}
          and ${schema.runs.createdAt} >= date_trunc('month', now())
      )`,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))

  const [member] = await db
    .select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
    .limit(1)

  return {
    id: workspace.id,
    name: workspace.name,
    role: (member?.role ?? 'viewer') as 'owner' | 'editor' | 'viewer',
    createdAt: workspace.createdAt.toISOString(),
    corpusGeneration: workspace.corpusGeneration,
    quota: {
      maxDocuments: limits.maxDocumentsPerWorkspace,
      maxUploadBytes: limits.maxUploadBytes,
      maxSourceBytes: limits.maxSourceBytesPerWorkspace,
      maxChunks: limits.maxChunksPerWorkspace,
      maxSelectedDocuments: limits.maxSelectedDocuments,
    },
    usage: {
      documentCount: Number(usage?.documentCount ?? 0),
      sourceBytes: Number(usage?.sourceBytes ?? 0),
      activeChunks: Number(usage?.activeChunks ?? 0),
      runsThisMonth: Number(usage?.runsThisMonth ?? 0),
    },
  }
}

export async function listMembers(workspaceId: string) {
  return db
    .select()
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
}
