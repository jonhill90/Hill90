-- Migration 028: Chat Lane Phase 1 — threads, participants, messages
--
-- Direct threads (1 human + 1 agent) with durable message persistence.
-- Named sequence chat_messages_seq advances on both INSERT (default) and
-- UPDATE (explicit nextval) so SSE cursor captures creates AND state
-- transitions.

CREATE TABLE chat_threads (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        VARCHAR(16) NOT NULL DEFAULT 'direct'
              CHECK (type IN ('direct', 'group')),
  title       VARCHAR(255) DEFAULT NULL,
  created_by  VARCHAR(255) NOT NULL,
  project_id  UUID DEFAULT NULL,
  task_id     UUID DEFAULT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_chat_threads_owner ON chat_threads(created_by);
CREATE INDEX idx_chat_threads_updated ON chat_threads(updated_at DESC);

-- Participants: composite PK includes participant_type to prevent
-- cross-namespace collision between Keycloak sub UUIDs and agent UUIDs
CREATE TABLE chat_participants (
  thread_id        UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  participant_id   VARCHAR(255) NOT NULL,
  participant_type VARCHAR(16) NOT NULL CHECK (participant_type IN ('human', 'agent')),
  role             VARCHAR(16) NOT NULL DEFAULT 'member'
                   CHECK (role IN ('owner', 'member')),
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at          TIMESTAMPTZ DEFAULT NULL,
  PRIMARY KEY (thread_id, participant_id, participant_type)
);

CREATE INDEX idx_chat_participants_lookup ON chat_participants(participant_id, participant_type);

-- Named sequence: shared by INSERT (default) and UPDATE (explicit nextval)
-- so SSE cursor captures both new messages and state transitions.
-- Strictly monotonic and unique. Not gap-free (PostgreSQL sequences skip
-- on rollback); correctness requires only monotonicity and uniqueness.
CREATE SEQUENCE chat_messages_seq;

-- Messages with author provenance and monotonic ordering
CREATE TABLE chat_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             BIGINT NOT NULL DEFAULT nextval('chat_messages_seq'),
  thread_id       UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  author_id       VARCHAR(255) NOT NULL,
  author_type     VARCHAR(16) NOT NULL CHECK (author_type IN ('human', 'agent')),
  role            VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL DEFAULT '',
  status          VARCHAR(16) NOT NULL DEFAULT 'complete'
                  CHECK (status IN ('pending', 'complete', 'error')),
  reply_to        UUID DEFAULT NULL REFERENCES chat_messages(id) ON DELETE SET NULL,
  model           VARCHAR(128) DEFAULT NULL,
  input_tokens    INTEGER DEFAULT NULL,
  output_tokens   INTEGER DEFAULT NULL,
  duration_ms     INTEGER DEFAULT NULL,
  error_message   TEXT DEFAULT NULL,
  idempotency_key VARCHAR(64) DEFAULT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER SEQUENCE chat_messages_seq OWNED BY chat_messages.seq;

CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_id, seq ASC);

-- Idempotency scoped to (thread_id, author_id, idempotency_key) to prevent
-- cross-author collisions in future group threads.
-- idempotency_key is human-only: server rejects non-null values when
-- author_type = 'agent'. Agent responses use message_id as natural key
-- via the callback contract (no idempotency_key in callback body).
CREATE UNIQUE INDEX idx_chat_messages_idempotency
  ON chat_messages(thread_id, author_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
