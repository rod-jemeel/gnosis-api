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

  return async () => {
    await Promise.all([
      ingestionWorker.close(),
      answerWorker.close(),
      purgeWorker.close(),
    ])
    await Promise.all([ingestionQueue.close(), answerQueue.close(), purgeQueue.close()])
  }
}
