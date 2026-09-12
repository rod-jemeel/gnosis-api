/**
 * Private chat sessions (spec §4.1): sessions belong to their creator;
 * workspace ownership grants no access to another member's sessions.
 */

import { and, desc, eq, sql } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { notFound } from '../errors.js'
import type { TenantContext } from '../identity.js'

function owned(tenant: TenantContext, sessionId: string) {
  return and(
    eq(schema.chatSessions.id, sessionId),
    eq(schema.chatSessions.workspaceId, tenant.workspaceId),
    eq(schema.chatSessions.userId, tenant.userId)
  )
}

export async function listSessions(tenant: TenantContext) {
  const rows = await db
    .select({
      id: schema.chatSessions.id,
      title: schema.chatSessions.title,
      createdAt: schema.chatSessions.createdAt,
      updatedAt: schema.chatSessions.updatedAt,
      messageCount: sql<number>`(select count(*) from ${schema.messages} where ${schema.messages.sessionId} = ${schema.chatSessions.id})`,
    })
    .from(schema.chatSessions)
    .where(
      and(
        eq(schema.chatSessions.workspaceId, tenant.workspaceId),
        eq(schema.chatSessions.userId, tenant.userId)
      )
    )
    .orderBy(desc(schema.chatSessions.updatedAt))
    .limit(50)
  return rows.map((r) => ({ ...r, messageCount: Number(r.messageCount) }))
}

export async function createSession(tenant: TenantContext, title: string) {
  const [session] = await db
    .insert(schema.chatSessions)
    .values({
      workspaceId: tenant.workspaceId,
      userId: tenant.userId,
      title: title?.trim() || 'New chat',
    })
    .returning()
  return session!
}

export async function requireOwnedSession(tenant: TenantContext, sessionId: string) {
  const [session] = await db
    .select()
    .from(schema.chatSessions)
    .where(owned(tenant, sessionId))
    .limit(1)
  if (!session) throw notFound('Session not found.')
  return session
}

export async function renameSession(tenant: TenantContext, sessionId: string, title: string) {
  await requireOwnedSession(tenant, sessionId)
  await db
    .update(schema.chatSessions)
    .set({ title: title?.trim() || 'New chat', updatedAt: new Date() })
    .where(owned(tenant, sessionId))
}

export async function deleteSession(tenant: TenantContext, sessionId: string) {
  await requireOwnedSession(tenant, sessionId)
  await db.transaction(async (tx) => {
    await tx.delete(schema.runEvents).where(
      sql`${schema.runEvents.runId} in (select id from runs where session_id = ${sessionId})`
    )
    await tx.delete(schema.runs).where(eq(schema.runs.sessionId, sessionId))
    await tx.delete(schema.messages).where(eq(schema.messages.sessionId, sessionId))
    await tx.delete(schema.chatSessions).where(owned(tenant, sessionId))
  })
}

/** Session history as turns (user message + final assistant answer). */
export async function sessionTurns(tenant: TenantContext, sessionId: string) {
  await requireOwnedSession(tenant, sessionId)
  const messages = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.sessionId, sessionId))
    .orderBy(schema.messages.sequence)

  const turns: {
    sequence: number
    runId: string | null
    user: { id: string; text: string; at: string; scope: unknown }
    assistant: {
      id: string
      runId: string | null
      at: string
      status: string
      result: unknown
      error: string | null
    } | null
  }[] = []

  for (const message of messages) {
    const content = message.content as {
      text?: string
      scope?: unknown
      result?: unknown
    }
    if (message.role === 'user') {
      turns.push({
        sequence: message.sequence,
        runId: message.runId,
        user: {
          id: message.id,
          text: content.text ?? '',
          at: message.createdAt.toISOString(),
          scope: content.scope ?? { type: 'all_current' },
        },
        assistant: null,
      })
    } else {
      const turn = turns[turns.length - 1]
      if (turn) {
        turn.assistant = {
          id: message.id,
          runId: message.runId,
          at: message.createdAt.toISOString(),
          status: 'completed',
          result: content.result ?? null,
          error: null,
        }
      }
    }
  }

  // A run may still be in flight or have failed without an assistant
  // message — surface its actual state from the runs table.
  const runs = await db.select().from(schema.runs).where(eq(schema.runs.sessionId, sessionId))
  const runById = new Map(runs.map((r) => [r.id, r]))
  for (const turn of turns) {
    if (turn.assistant || !turn.runId) continue
    const run = runById.get(turn.runId)
    if (!run || run.status === 'completed') continue
    turn.assistant = {
      id: `run-${run.id}`,
      runId: run.id,
      at: (run.startedAt ?? run.createdAt).toISOString(),
      status: run.status,
      result: run.result ?? null,
      error: run.errorMessage,
    }
  }

  return turns.map(({ sequence, user, assistant }) => ({ sequence, user, assistant }))
}
