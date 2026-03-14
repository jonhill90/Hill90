-- Container profiles: runtime image + resource defaults for agents.
-- Phase 1A: table + seed + FK on agents.

CREATE TABLE container_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(64) NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  docker_image VARCHAR(255) NOT NULL,
  default_cpus VARCHAR(10) NOT NULL DEFAULT '1.0',
  default_mem_limit VARCHAR(10) NOT NULL DEFAULT '1g',
  default_pids_limit INT NOT NULL DEFAULT 200,
  is_platform BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO container_profiles (name, description, docker_image, is_platform)
VALUES ('standard', 'Standard agentbox runtime with Python, bash, git, and common CLI tools',
        'hill90/agentbox:latest', true);

ALTER TABLE agents ADD COLUMN container_profile_id UUID
  REFERENCES container_profiles(id) ON DELETE SET NULL;

UPDATE agents SET container_profile_id =
  (SELECT id FROM container_profiles WHERE name = 'standard');
