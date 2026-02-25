-- Knowledge entries table — core storage for all agent knowledge
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS knowledge_entries (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id      TEXT NOT NULL,
    path          TEXT NOT NULL,
    title         TEXT NOT NULL,
    entry_type    TEXT NOT NULL CHECK (entry_type IN ('plan', 'decision', 'journal', 'research', 'context', 'note')),
    body          TEXT NOT NULL DEFAULT '',
    content_hash  TEXT NOT NULL DEFAULT '',
    tags          TEXT[] DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    sync_status   TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'error')),
    sync_attempts INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- FTS index column
    search_vector TSVECTOR,

    UNIQUE (agent_id, path)
);

-- FTS index
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_fts
    ON knowledge_entries USING GIN (search_vector);

-- Agent lookup index
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_agent
    ON knowledge_entries (agent_id, status);

-- Sync status index for reconciler
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_sync
    ON knowledge_entries (sync_status) WHERE sync_status = 'pending';

-- Auto-update search_vector on insert/update
CREATE OR REPLACE FUNCTION update_search_vector() RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector := setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
                         setweight(to_tsvector('english', COALESCE(NEW.body, '')), 'B') ||
                         setweight(to_tsvector('english', array_to_string(COALESCE(NEW.tags, '{}'), ' ')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_search_vector ON knowledge_entries;
CREATE TRIGGER trg_update_search_vector
    BEFORE INSERT OR UPDATE ON knowledge_entries
    FOR EACH ROW EXECUTE FUNCTION update_search_vector();
