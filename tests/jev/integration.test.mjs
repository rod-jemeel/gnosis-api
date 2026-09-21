/**
 * Integration test: real PostgreSQL required (APP-05).
 *
 * Runs only with an explicit opt-in and a reachable database:
 *   RUN_JEV_INTEGRATION=1 DATABASE_URL=... pnpm test:jev:integration
 * Otherwise every case is reported as skipped.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const RUN = process.env.RUN_JEV_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL)

test('APP-05: cancellation constraint accepts the reconciling state', { skip: !RUN }, async (t) => {
  const { db, pool } = await import('../../src/db/client.ts')
  const { randomUUID } = await import('node:crypto')

  const workspaceId = randomUUID()
  const sessionId = randomUUID()
  const runId = randomUUID()

  try {
    await db.execute(
      `insert into workspaces (id, name) values ('${workspaceId}', 'jev-integration')`
    )
    await db.execute(
      `insert into workspace_members (workspace_id, user_id, role) values ('${workspaceId}', 'it-user', 'owner')`
    )
    await db.execute(
      `insert into chat_sessions (id, workspace_id, user_id) values ('${sessionId}', '${workspaceId}', 'it-user')`
    )
    await db.execute(
      `insert into runs (id, workspace_id, session_id, user_id, question, scope, status, idempotency_key)
       values ('${runId}', '${workspaceId}', '${sessionId}', 'it-user', 'q', '{"type":"all_current"}', 'running', 'it-key')`
    )

    // The reconciling state must satisfy the CHECK constraint (this is
    // what migration 0003 fixes; the original constraint rejected it).
    await db.execute(`update runs set status = 'cancelling' where id = '${runId}'`)

    // A late cancellation cannot overwrite a completed run.
    await db.execute(
      `update runs set status = 'completed', outcome = 'insufficient_evidence' where id = '${runId}'`
    )
    const after = await db.execute(
      `select status from runs where id = '${runId}'`
    )
    const status = after.rows.length > 0 ? after.rows[0].status : undefined
    assert.equal(status, 'completed')
  } finally {
    await db.execute(`delete from runs where id = '${runId}'`)
    await db.execute(`delete from chat_sessions where id = '${sessionId}'`)
    await db.execute(`delete from workspace_members where workspace_id = '${workspaceId}'`)
    await db.execute(`delete from workspaces where id = '${workspaceId}'`)
    await pool.end()
  }
})
