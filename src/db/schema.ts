/**
 * Drizzle table definitions mirroring migrations/0001_init.sql.
 * Postgres is authoritative; the vector index is derived state.
 */

import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  corpusGeneration: bigint('corpus_generation', { mode: 'number' }).notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    email: text('email'),
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })]
)

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    title: text('title').notNull(),
    tags: text('tags').array().notNull().default([]),
    activeVersionId: uuid('active_version_id'),
    activeBuildId: uuid('active_build_id'),
    lifecycle: text('lifecycle').notNull().default('active'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('documents_workspace_idx').on(t.workspaceId, t.lifecycle, t.updatedAt)]
)

export const documentVersions = pgTable(
  'document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    documentId: uuid('document_id').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    contentHash: text('content_hash').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    pageCount: integer('page_count'),
    sourceLabel: text('source_label'),
    creatorEmail: text('creator_email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('document_versions_doc_rev').on(t.documentId, t.revisionNumber)]
)

export const indexBuilds = pgTable(
  'index_builds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    documentId: uuid('document_id').notNull(),
    versionId: uuid('version_id').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    state: text('state').notNull().default('queued'),
    stageHistory: jsonb('stage_history').notNull().default([]),
    chunkCount: integer('chunk_count'),
    embeddingModel: text('embedding_model'),
    embeddingDims: integer('embedding_dims'),
    configHash: text('config_hash').notNull(),
    warnings: jsonb('warnings').notNull().default([]),
    error: text('error'),
    retryable: boolean('retryable').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('builds_document_idx').on(t.documentId, t.createdAt)]
)

export const sourceBlocks = pgTable(
  'source_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    versionId: uuid('version_id').notNull(),
    buildId: uuid('build_id').notNull(),
    page: integer('page').notNull(),
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
  },
  (t) => [index('blocks_version_idx').on(t.versionId, t.page, t.ordinal)]
)

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    documentId: uuid('document_id').notNull(),
    versionId: uuid('version_id').notNull(),
    buildId: uuid('build_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    page: integer('page').notNull(),
    text: text('text').notNull(),
    // embedding: vector(1536) — typed as unknown; used via raw SQL.
    embedding: jsonb('embedding'),
    tsv: text('tsv'),
  },
  (t) => [unique('chunks_build_ordinal').on(t.buildId, t.ordinal)]
)

export const storedFiles = pgTable('stored_files', {
  key: text('key').primaryKey(),
  contentType: text('content_type').notNull().default('application/pdf'),
  bytes: text('bytes').notNull(), // bytea via raw SQL; typed loosely here
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const uploadSessions = pgTable('upload_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  userId: text('user_id').notNull(),
  stagingKey: text('staging_key').notNull().unique(),
  fileName: text('file_name').notNull(),
  declaredBytes: bigint('declared_bytes', { mode: 'number' }).notNull(),
  state: text('state').notNull().default('created'),
  result: jsonb('result'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    title: text('title').notNull().default('New chat'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_owner_idx').on(t.workspaceId, t.userId, t.updatedAt)]
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    sequence: integer('sequence').notNull(),
    role: text('role').notNull(),
    runId: uuid('run_id'),
    content: jsonb('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('messages_session_sequence').on(t.sessionId, t.sequence)]
)

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    userId: text('user_id').notNull(),
    question: text('question').notNull(),
    scope: jsonb('scope').notNull(),
    mode: text('mode').notNull().default('strict'),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('queued'),
    outcome: text('outcome'),
    result: jsonb('result'),
    details: jsonb('details'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    errorRetryable: boolean('error_retryable'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    unique('runs_session_idem').on(t.sessionId, t.idempotencyKey),
    index('runs_recent_idx').on(t.workspaceId, t.createdAt),
  ]
)

export const runEvents = pgTable(
  'run_events',
  {
    runId: uuid('run_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.sequence] })]
)

export const purgeTasks = pgTable('purge_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  documentId: uuid('document_id').notNull(),
  state: text('state').notNull().default('pending'),
  detail: text('detail'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
})

export const usageEvents = pgTable('usage_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  workspaceId: uuid('workspace_id').notNull(),
  runId: uuid('run_id'),
  provider: text('provider').notNull().default('openai'),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    kind: text('kind').notNull(),
    refId: uuid('ref_id').notNull(),
    state: text('state').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('jobs_kind_ref').on(t.kind, t.refId)]
)
