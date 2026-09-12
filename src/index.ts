/**
 * Gnosis API entrypoint: Hono server + BullMQ workers in one process
 * (scaffold deployment unit; splitting roles is a config change).
 */

import { serve } from '@hono/node-server'
import { config } from './config.js'
import { app } from './routes/index.js'
import { startWorkers } from './queues/index.js'
import { warmEmbedder } from './providers/embeddings.js'
import { pool } from './db/client.js'

async function main() {
  await warmEmbedder().catch((err) => {
    console.error('[embeddings] warmup failed:', err instanceof Error ? err.message : err)
  })
  const stopWorkers = await startWorkers()

  const server = serve(
    { fetch: app.fetch, port: config.PORT },
    (info) => {
      console.log(`[gnosis-api] listening on http://localhost:${info.port}`)
      console.log(`[gnosis-api] auth mode: ${config.AUTH_MODE}`)
    }
  )

  const shutdown = async () => {
    console.log('[gnosis-api] shutting down…')
    server.close()
    await stopWorkers()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[gnosis-api] fatal:', err)
  process.exit(1)
})
