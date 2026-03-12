-- Migration 030: Chat Lane Phase 1B — target_agents column
--
-- Stores which agents a user message targets (null = all agents in thread).
-- Used for @-mention routing: when user targets specific agents, only those
-- agents receive dispatch. JSON array of agent UUIDs.

ALTER TABLE chat_messages ADD COLUMN target_agents JSONB DEFAULT NULL;
