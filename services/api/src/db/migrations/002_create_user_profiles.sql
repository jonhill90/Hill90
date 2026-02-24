CREATE TABLE user_profiles (
  keycloak_id VARCHAR(255) PRIMARY KEY,
  avatar_key  VARCHAR(512),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
