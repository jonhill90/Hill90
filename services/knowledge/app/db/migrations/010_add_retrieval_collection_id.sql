-- Add collection_id to shared_retrievals for usage analytics
ALTER TABLE shared_retrievals
    ADD COLUMN IF NOT EXISTS collection_id UUID REFERENCES shared_collections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_shared_retrievals_collection_id
    ON shared_retrievals (collection_id)
    WHERE collection_id IS NOT NULL;
