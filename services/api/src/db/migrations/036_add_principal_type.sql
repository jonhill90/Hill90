-- P2: Add principal_type column to agents table for workload principal model (AI-115).
-- All agents are type 'agent'. Column formalizes the principal type in the identity model.
ALTER TABLE agents ADD COLUMN principal_type VARCHAR(16) NOT NULL DEFAULT 'agent';
