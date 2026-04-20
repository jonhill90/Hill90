-- Agent persistent memory table (AI-255)
-- Stores short memories with vector embeddings for semantic recall

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS agent_memories (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id       TEXT NOT NULL,
    content        TEXT NOT NULL,
    content_hash   VARCHAR(64) NOT NULL,
    embedding      vector(1536),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (agent_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_agent_memories_agent ON agent_memories (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_memories_embedding
    ON agent_memories USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 10);
