-- Shared Knowledge Base tables — user-owned collections, sources, documents, chunks, and audit

-- Collections: user-owned groupings of knowledge sources
CREATE TABLE IF NOT EXISTS shared_collections (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(256) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    visibility  VARCHAR(16) NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
    created_by  VARCHAR(255) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (name, created_by)
);

CREATE INDEX IF NOT EXISTS idx_sc_owner ON shared_collections (created_by);
CREATE INDEX IF NOT EXISTS idx_sc_visibility ON shared_collections (visibility);

-- Sources: reference to an external or uploaded source of knowledge
CREATE TABLE IF NOT EXISTS shared_sources (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    collection_id   UUID NOT NULL REFERENCES shared_collections (id) ON DELETE CASCADE,
    title           VARCHAR(512) NOT NULL,
    source_type     VARCHAR(32) NOT NULL CHECK (source_type IN ('text', 'markdown', 'web_page')),
    source_url      VARCHAR(2048) DEFAULT NULL,
    content_hash    VARCHAR(64) NOT NULL DEFAULT '',
    raw_content     TEXT DEFAULT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'error', 'archived')),
    error_message   TEXT DEFAULT NULL,
    created_by      VARCHAR(255) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ss_collection ON shared_sources (collection_id);
CREATE INDEX IF NOT EXISTS idx_ss_content_hash ON shared_sources (content_hash);

-- Ingest jobs: tracks each processing attempt for a source
CREATE TABLE IF NOT EXISTS shared_ingest_jobs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id       UUID NOT NULL REFERENCES shared_sources (id) ON DELETE CASCADE,
    status          VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    started_at      TIMESTAMPTZ DEFAULT NULL,
    completed_at    TIMESTAMPTZ DEFAULT NULL,
    chunk_count     INTEGER NOT NULL DEFAULT 0,
    error_message   TEXT DEFAULT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sij_source ON shared_ingest_jobs (source_id);
CREATE INDEX IF NOT EXISTS idx_sij_status ON shared_ingest_jobs (status) WHERE status IN ('pending', 'running');

-- Documents: a processed version of a source
CREATE TABLE IF NOT EXISTS shared_documents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id       UUID NOT NULL REFERENCES shared_sources (id) ON DELETE CASCADE,
    ingest_job_id   UUID REFERENCES shared_ingest_jobs (id) ON DELETE SET NULL,
    title           VARCHAR(512) NOT NULL,
    content_hash    VARCHAR(64) NOT NULL,
    chunk_count     INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sd_source ON shared_documents (source_id);

-- Chunks: searchable text segments from a document
CREATE TABLE IF NOT EXISTS shared_chunks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id     UUID NOT NULL REFERENCES shared_documents (id) ON DELETE CASCADE,
    chunk_index     INTEGER NOT NULL DEFAULT 0,
    content         TEXT NOT NULL,
    token_estimate  INTEGER NOT NULL DEFAULT 0,
    search_vector   TSVECTOR,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schk_document ON shared_chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_schk_fts ON shared_chunks USING GIN (search_vector);

-- FTS trigger for chunks: weight document title (A) + chunk content (B)
CREATE OR REPLACE FUNCTION update_shared_chunk_search_vector() RETURNS TRIGGER AS $$
DECLARE
    doc_title TEXT;
BEGIN
    SELECT title INTO doc_title FROM shared_documents WHERE id = NEW.document_id;
    NEW.search_vector := setweight(to_tsvector('english', COALESCE(doc_title, '')), 'A') ||
                         setweight(to_tsvector('english', COALESCE(NEW.content, '')), 'B');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_shared_chunk_search_vector ON shared_chunks;
CREATE TRIGGER trg_update_shared_chunk_search_vector
    BEFORE INSERT OR UPDATE ON shared_chunks
    FOR EACH ROW EXECUTE FUNCTION update_shared_chunk_search_vector();

-- Retrievals: audit trail for every search/retrieval operation
CREATE TABLE IF NOT EXISTS shared_retrievals (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    query           TEXT NOT NULL,
    requester_type  VARCHAR(16) NOT NULL CHECK (requester_type IN ('user', 'agent')),
    requester_id    VARCHAR(255) NOT NULL,
    agent_owner     VARCHAR(255) DEFAULT NULL,
    result_count    INTEGER NOT NULL DEFAULT 0,
    chunk_ids       UUID[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sr_requester ON shared_retrievals (requester_type, requester_id);
CREATE INDEX IF NOT EXISTS idx_sr_created ON shared_retrievals (created_at);
