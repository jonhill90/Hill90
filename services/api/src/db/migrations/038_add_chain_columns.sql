-- Migration 038: Add agent-to-agent @mention chain columns
-- All nullable, no default expression — instant metadata-only ALTER on Postgres.

ALTER TABLE chat_messages ADD COLUMN chain_id UUID DEFAULT NULL;
ALTER TABLE chat_messages ADD COLUMN chain_hop INTEGER DEFAULT NULL;
ALTER TABLE chat_messages ADD COLUMN triggered_by UUID DEFAULT NULL REFERENCES chat_messages(id) ON DELETE SET NULL;

CREATE INDEX idx_chat_messages_chain ON chat_messages(chain_id) WHERE chain_id IS NOT NULL;
