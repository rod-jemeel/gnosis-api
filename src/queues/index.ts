/**
 * Durable job queues (BullMQ on Redis). Jobs carry only IDs; source
 * state is resolved from PostgreSQL at execution time (spec §12.1).
 * Logical state transitions are idempotent, so at-least-once delivery
 * is safe.
 */

import { Queue, Worker } from 'bullmq'
import { config } from '../config.js'
import { processBuild } from '../services/ingestion.js'
import { executeRun } from '../services/answers.js'
import { executePurge } from '../services/documents.js'

const connection = {
  url: config.REDIS_URL,
  maxRetriesPerRequest: null,
}

export const ingestionQueue = new Queue('ingestion', { connection })
export const answerQueue = new Queue('answers', { connection })
export const purgeQueue = new Queue('purge', { connection })

export async function enqueue(kind: 'ingestion' | 'answers' | 'purge', refId: string) {
  if (kind === 'ingestion') {
    await ingestionQueue.add('build', { buildId: refId }, { jobId: `ingest-${refId}`, attempts: 4, backoff: { type: 'exponential', delay: 1000 } })
  } else if (kind === 'answers') {
    await answerQueue.add('run', { runId: refId }, { jobId: `run-${refId}`, attempts: 2, backoff: { type: 'exponential', delay: 2000 } })
  } else {
    await purgeQueue.add('purge', { purgeTaskId: refId }, { jobId: `purge-${refId}`, attempts: 4, backoff: { type: 'exponential', delay: 5000 } })
  }
}

export async function removeQueueJob(kind: 'ingestion' | 'answers' | 'purge', jobId: string) {
  const queue = kind === 'ingestion' ? ingestionQueue : kind === 'answers' ? answerQueue : purgeQueue
  await queue.remove(jobId)
}

/**
 * Reconcile durable work committed to PostgreSQL whose queue message
 * never arrived (crash between commit and enqueue, APP-06). Runs and
 * builds stuck in a nonterminal state older than the grace period are
 * re-driven; state-level idempotency makes redelivery harmless.
 */
async function reconcileOrphans() {
  try {
    const { db, schema } = await import('../db/client.js')
    const { and, eq, lt, sql } = await import('drizzle-orm')
    const cutoff = new Date(Date.now() - 60_000)

    const stalledRuns = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.status, 'queued'), lt(schema.runs.createdAt, cutoff)))
      .limit(50)
    for (const run of stalledRuns) {
      await removeQueueJob('answers', `run-${run.id}`)
      await enqueue('answers', run.id)
    }

    const stalledBuilds = await db
      .select({ id: schema.indexBuilds.id })
      .from(schema.indexBuilds)
      .where(and(eq(schema.indexBuilds.state, 'queued'), lt(schema.indexBuilds.createdAt, cutoff)))
      .limit(50)
    for (const build of stalledBuilds) {
      await removeQueueJob('ingestion', `ingest-${build.id}`)
      await enqueue('ingestion', build.id)
    }

    if (stalledRuns.length > 0 || stalledBuilds.length > 0) {
      console.log(
        `[queues] reconciled ${stalledRuns.length} run(s), ${stalledBuilds.length} build(s)`
      )
    }
  } catch (err) {
    console.error('[queues] reconciliation failed (will retry on next boot):', err instanceof Error ? err.message : err)
  }
}

export function startWorkers() {
  const ingestionWorker = new Worker(
    'ingestion',
    async (job) => processBuild(job.data.buildId as string),
    { connection, concurrency: 2 }
  )
  const answerWorker = new Worker(
    'answers',
    async (job) => executeRun(job.data.runId as string),
    { connection, concurrency: 4 }
  )
  const purgeWorker = new Worker(
    'purge',
    async (job) => executePurge(job.data.purgeTaskId as string),
    { connection, concurrency: 1 }
  )

  for (const worker of [ingestionWorker, answerWorker, purgeWorker]) {
    worker.on('failed', (job, err) => {
      console.error(`[queue:${worker.name}] job ${job?.id} failed:`, err.message)
    })
  }

  // Give the workers a moment to come up, then re-drive orphans once.
  const reconcileTimer = setTimeout(() => void reconcileOrphans(), 5_000)

  return async () => {
    clearTimeout(reconcileTimer)
    await Promise.all([
      ingestionWorker.close(),
      answerWorker.close(),
      purgeWorker.close(),
    ])
    await Promise.all([ingestionQueue.close(), answerQueue.close(), purgeQueue.close()])
  }
}
