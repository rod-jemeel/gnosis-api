-- Embeddings moved to a self-hosted local model (bge-small-en-v1.5,
-- 384 dimensions) via ONNX. Column type follows the active embedding
-- profile; no tenant data existed at 1536 dimensions (all builds failed
-- before embedding completed).

drop index if exists chunks_hnsw_idx;
alter table chunks drop column embedding;
alter table chunks add column embedding vector(384);
create index chunks_hnsw_idx on chunks using hnsw (embedding vector_cosine_ops);
