# Gnosis API

The Gnosis v2 backend: evidence-first document question answering over
PostgreSQL (authoritative store, lexical FTS, and pgvector semantic index),
BullMQ durable jobs, and OpenAI provider adapters. Implements the `/v2`
HTTP + event contract that the Gnosis web app speaks.

## Stack

| Concern | Choice |
| --- | --- |
| HTTP | [Hono](https://hono.dev) on `@hono/node-server` (incl. SSE event streams) |
| Jobs | BullMQ on Redis (ingestion, answer runs, purge) |
| Database | PostgreSQL + pgvector — authoritative store, English FTS, HNSW vector index |
| Vectors | pgvector (single-database atomic activation; Pinecone stays behind the same interface if evaluation justifies it later) |
| Storage | Bytes in Postgres under immutable version keys (scaffold adapter — swap for Supabase Storage / files-sdk without touching callers) |
| PDF parsing | unpdf (pdf.js) server-side |
| Embeddings | **Self-hosted by default**: bge-small-en-v1.5 (384d) via ONNX in-process (transformers.js) — no key, no egress, cached under `.models/`. OpenAI embeddings available behind the same interface (`EMBEDDING_PROVIDER=openai`) |
| Generation | Gemini (free tier, via its OpenAI-compatible endpoint) or OpenAI when a key is configured; **without any key the system runs in evidence-only mode** — answers are constructed directly from authorized passages (spec §14.3) |

## Quickstart

```bash
pnpm install
docker compose up -d      # postgres (pgvector) + redis
cp .env.example .env      # no key required: embeddings are local, answers run evidence-only
pnpm migrate
pnpm dev                  # API + workers on :3000
```

Then point the web app at it:

```bash
# in ../gnosis/.env.local
NEXT_PUBLIC_GNOSIS_API=http://localhost:3000
```

To enable generated answers, add `GEMINI_API_KEY=...` (or `OPENAI_API_KEY=...`) to `.env` and restart; retrieval is unchanged.

With `AUTH_MODE=local` (default) the API accepts a fixed dev identity and
only binds on localhost. Set `AUTH_MODE=supabase` with
`SUPABASE_JWT_SECRET` (HS256) or `SUPABASE_JWKS_URL` (asymmetric) to
require verified Supabase access tokens.

## Pipeline

**Ingestion** (`src/services/ingestion.ts`): staged, checkpointed builds —
`validating_source → parsing → chunking → embedding → indexing →
checking_readiness → ready`, then activation swaps the document's active
build in one transaction and bumps the workspace corpus generation. The
previous build stays searchable until the replacement is ready.

**Answer runs** (`src/services/answers.ts`): durable two-step protocol —
POST creates the run idempotently, the worker executes retrieval
(lexical + dense, RRF fusion) → context budgeting → generation (JSON
mode) → deterministic validation (evidence-handle membership; invalid or
unsupported claims are removed) → one-transaction finalization of the
assistant message, run state, usage, and terminal events. `GET
/runs/:id/events?after=N` replays the durable event stream (SSE).

**Deletion**: tombstone commits immediately (reads denied), a durable
purge task removes files, blocks, chunks, and vectors; failures stay
visible.

## Honest simplifications (vs. the full specification)

This scaffold implements the spec's vertical slice. Not yet present:
outbox dispatcher + lease fencing tokens (jobs checkpoint through
`index_builds`/`runs` state instead), semantic claim-support checking
(claims are validated deterministically; the generator is instructed to
only assert supported claims and outcome corrections are applied), reranking
(interface records `reranker: null`), and S3-compatible storage (bytes live
in Postgres under stable immutable keys).

## Scripts

```bash
pnpm dev        # API + workers with watch
pnpm build      # typecheck + emit to dist/
pnpm start      # production
pnpm migrate    # apply SQL migrations (explicit, never at boot)
pnpm typecheck
```
