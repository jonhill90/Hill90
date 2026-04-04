-- Add batch_complete flag for group thread dispatch completion tracking.
-- When the last agent in a dispatch batch completes (or errors), the callback
-- handler sets batch_complete = true on that message so SSE clients can detect
-- "all agents responded" without client-side counting.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS batch_complete BOOLEAN DEFAULT NULL;
