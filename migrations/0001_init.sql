-- Gnosis v2 core schema (spec §10, pragmatic first slice).
-- Postgres is authoritative: identity relationships, lifecycle, builds,
-- chunks, runs, evidence, and events. pgvector provides the derived
-- semantic index on the same database.

create extension if not exists vector;

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  corpus_generation bigint not null default 1,
  created_at timestamptz not null default now()
);

create table workspace_members (
  workspace_id uuid not null references workspaces(id),
  user_id text not null,
  email text,
  role text not null check (role in ('owner','editor','viewer')),
  status text not null default 'active',
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  title text not null,
  tags text[] not null default '{}',
  active_version_id uuid,
  active_build_id uuid,
  lifecycle text not null default 'active' check (lifecycle in ('active','deleted')),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index documents_workspace_idx on documents (workspace_id, lifecycle, updated_at desc);

create table document_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null references documents(id),
  revision_number int not null,
  storage_key text not null unique,
  content_hash text not null,
  size_bytes bigint not null,
  page_count int,
  source_label text,
  creator_email text,
  created_at timestamptz not null default now(),
  unique (document_id, revision_number)
);

create table index_builds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null references documents(id),
  version_id uuid not null references document_versions(id),
  revision_number int not null,
  state text not null default 'queued' check (state in
    ('queued','validating_source','parsing','chunking','embedding','indexing',
     'checking_readiness','ready','failed','cancelled','superseded')),
  stage_history jsonb not null default '[]',
  chunk_count int,
  embedding_model text,
  embedding_dims int,
  config_hash text not null,
  warnings jsonb not null default '[]',
  error text,
  retryable boolean not null default true,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index builds_document_idx on index_builds (document_id, created_at desc);

-- Canonical extracted text per page for one build's source version.
create table source_blocks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  version_id uuid not null references document_versions(id),
  build_id uuid not null references index_builds(id),
  page int not null,
  ordinal int not null,
  text text not null
);
create index blocks_version_idx on source_blocks (version_id, page, ordinal);

create table chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  version_id uuid not null,
  build_id uuid not null references index_builds(id),
  ordinal int not null,
  page int not null,
  text text not null,
  embedding vector(1536),
  tsv tsvector generated always as (to_tsvector('english', text)) stored,
  unique (build_id, ordinal)
);
create index chunks_hnsw_idx on chunks using hnsw (embedding vector_cosine_ops);
create index chunks_tsv_idx on chunks using gin (tsv);
-- Only chunks of active builds are eligible for retrieval.
create index chunks_scope_idx on chunks (workspace_id, build_id);

-- Scaffold storage adapter: bytes in Postgres. Swap for an S3-compatible
-- bucket (files-sdk) by replacing the storage service; keys stay stable.
create table stored_files (
  key text primary key,
  content_type text not null default 'application/pdf',
  bytes bytea not null,
  size_bytes bigint not null,
  created_at timestamptz not null default now()
);

create table upload_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  user_id text not null,
  staging_key text not null unique,
  file_name text not null,
  declared_bytes bigint not null,
  state text not null default 'created',
  result jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table chat_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  user_id text not null,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sessions_owner_idx on chat_sessions (workspace_id, user_id, updated_at desc);

create table messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  session_id uuid not null references chat_sessions(id),
  sequence int not null,
  role text not null check (role in ('user','assistant')),
  run_id uuid,
  content jsonb not null,
  created_at timestamptz not null default now(),
  unique (session_id, sequence)
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  session_id uuid not null references chat_sessions(id),
  user_id text not null,
  question text not null,
  scope jsonb not null,
  mode text not null default 'strict',
  idempotency_key text not null,
  status text not null default 'queued' check (status in
    ('queued','running','completed','failed','cancelled','interrupted')),
  outcome text check (outcome in
    ('answered','partial','conflicting_sources','insufficient_evidence','clarification_required')),
  result jsonb,
  details jsonb,
  error_code text,
  error_message text,
  error_retryable boolean,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (session_id, idempotency_key)
);
create index runs_recent_idx on runs (workspace_id, created_at desc);

create table run_events (
  run_id uuid not null references runs(id) on delete cascade,
  workspace_id uuid not null,
  sequence bigint not null,
  type text not null,
  payload jsonb,
  created_at timestamptz not null default now(),
  primary key (run_id, sequence)
);

create table purge_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  state text not null default 'pending' check (state in ('pending','complete','failed')),
  detail text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table usage_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  run_id uuid,
  provider text not null default 'openai',
  model text not null,
  input_tokens int,
  output_tokens int,
  created_at timestamptz not null default now()
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  kind text not null,
  ref_id uuid not null,
  state text not null default 'queued',
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, ref_id)
);
