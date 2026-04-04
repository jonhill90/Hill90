-- Migration 039: Add metadata JSONB to container_profiles and seed specialized profiles

ALTER TABLE container_profiles ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}';

-- Seed browser profile (idempotent — skip if name already exists)
INSERT INTO container_profiles (name, description, docker_image, default_cpus, default_mem_limit, default_pids_limit, is_platform, metadata)
VALUES (
  'browser',
  'Agentbox with Playwright and Chromium for web browsing, scraping, and testing',
  'hill90/agentbox-browser:latest',
  '2.0', '2g', 300, true,
  '{"extra_env": ["PLAYWRIGHT_BROWSERS_PATH=/data/browsers"], "shm_size": "256m"}'
) ON CONFLICT (name) DO NOTHING;

-- Seed monitor profile (idempotent — skip if name already exists)
INSERT INTO container_profiles (name, description, docker_image, default_cpus, default_mem_limit, default_pids_limit, is_platform, metadata)
VALUES (
  'monitor',
  'Lightweight monitoring agent with minimal resource footprint',
  'hill90/agentbox-monitor:latest',
  '0.5', '256m', 100, true,
  '{}'
) ON CONFLICT (name) DO NOTHING;
