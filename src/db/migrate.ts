/**
 * Migration runner — explicit (`pnpm migrate`), never at every startup
 * (spec §21.1).
 */

import { readdir } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pool } from './client.js'

async function main() {
  const folder = join(process.cwd(), 'migrations')
  const files = (await readdir(folder)).filter((f) => f.endsWith('.sql')).sort()
  if (files.length === 0) {
    console.error('No migration files found in', folder)
    process.exit(1)
  }

  await pool.query(
    `create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`
  )

  const client = await pool.connect()
  try {
    for (const file of files) {
      const applied = await client.query<{ name: string }>(
        `select name from schema_migrations where name = $1`,
        [file]
      )
      if (applied.rowCount && applied.rowCount > 0) continue
      const sqlText = await readFile(join(folder, file), 'utf8')
      console.log(`applying ${file} …`)
      await client.query('begin')
      try {
        // Statements are split on `;` at line ends; the migration files
        // are authored accordingly (no embedded semicolons in bodies).
        for (const statement of sqlText
          .split(/;\s*(\n|$)/)
          .map((s) => s.trim())
          .filter(Boolean)) {
          await client.query(statement)
        }
        await client.query(`insert into schema_migrations (name) values ($1)`, [file])
        await client.query('commit')
      } catch (err) {
        await client.query('rollback')
        throw err
      }
    }
  } finally {
    client.release()
  }

  console.log('migrations up to date')
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
