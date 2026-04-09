-- Add archived flag to chat threads
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_chat_threads_archived ON chat_threads (archived);
