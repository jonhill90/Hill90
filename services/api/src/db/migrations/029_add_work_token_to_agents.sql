-- Migration 029: Add work_token column to agents table.
-- Stores the WORK_TOKEN injected into the agentbox container at start.
-- Cleared on stop. Enables API to verify agent readiness for work dispatch.
ALTER TABLE agents ADD COLUMN work_token VARCHAR(64) DEFAULT NULL;
