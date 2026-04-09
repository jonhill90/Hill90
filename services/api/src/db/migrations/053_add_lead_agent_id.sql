-- Migration 053: Add lead_agent_id to chat_threads for collaborative group chat.
--
-- In a collaborative group thread, the lead agent is the primary responder.
-- Other agents serve as collaborators the lead can query for input.
-- NULL means classic broadcast dispatch (all agents respond independently).

ALTER TABLE chat_threads ADD COLUMN lead_agent_id UUID DEFAULT NULL
  REFERENCES agents(id) ON DELETE SET NULL;

CREATE INDEX idx_chat_threads_lead ON chat_threads(lead_agent_id) WHERE lead_agent_id IS NOT NULL;
