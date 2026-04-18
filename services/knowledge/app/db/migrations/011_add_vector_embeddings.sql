-- Add pgvector extension and embedding column for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE shared_chunks
    ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- IVFFlat index for approximate nearest neighbor search
-- lists = sqrt(num_rows) is a good starting point; 10 works for <1000 rows
CREATE INDEX IF NOT EXISTS idx_schk_embedding
    ON shared_chunks USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 10);
