-- Add pinning support to chat messages
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_chat_messages_pinned ON chat_messages(thread_id) WHERE is_pinned = TRUE;
