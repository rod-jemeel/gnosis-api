/**
 * Storage service. Scaffold adapter: bytes live in Postgres (bytea) under
 * immutable keys. The key layout matches an S3-style bucket, so swapping
 * in files-sdk / Supabase Storage later only changes this file.
 */

import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notFound } from '../errors.js'

export function versionKey(workspaceId: string, documentId: string, revision: number): string {
  return `ws/${workspaceId}/doc/${documentId}/rev/${revision}/source.pdf`
}

export async function putFile(key: string, bytes: Buffer, contentType = 'application/pdf') {
  await db.execute(sql`
    insert into stored_files (key, content_type, bytes, size_bytes)
    values (${key}, ${contentType}, ${bytes}, ${bytes.byteLength})
    on conflict (key) do update set bytes = excluded.bytes, size_bytes = excluded.size_bytes
  `)
}

export async function getFile(key: string): Promise<{ bytes: Buffer; contentType: string }> {
  const result = await db.execute<{ bytes: Buffer; content_type: string }>(sql`
    select bytes, content_type from stored_files where key = ${key}
  `)
  const row = result.rows[0]
  if (!row) throw notFound('File not found.')
  return { bytes: Buffer.from(row.bytes), contentType: row.content_type }
}

export async function deleteFile(key: string): Promise<void> {
  await db.execute(sql`delete from stored_files where key = ${key}`)
}
