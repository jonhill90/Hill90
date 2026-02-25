-- Knowledge links table — for future [[wikilink]] cross-referencing
CREATE TABLE IF NOT EXISTS knowledge_links (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id     UUID NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
    target_path   TEXT NOT NULL,
    link_text     TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_links_source
    ON knowledge_links (source_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_links_target
    ON knowledge_links (target_path);
