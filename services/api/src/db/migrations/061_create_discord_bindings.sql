-- Discord channel-to-agent binding and user linking (AI-256)

CREATE TABLE IF NOT EXISTS discord_channel_bindings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  VARCHAR(64) NOT NULL UNIQUE,
    guild_id    VARCHAR(64) NOT NULL,
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    thread_id   UUID REFERENCES chat_threads(id) ON DELETE SET NULL,
    created_by  VARCHAR(255) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS discord_user_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    discord_user_id VARCHAR(64) NOT NULL UNIQUE,
    hill90_user_id  VARCHAR(255) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discord_bindings_channel ON discord_channel_bindings(channel_id);
CREATE INDEX IF NOT EXISTS idx_discord_user_links_discord ON discord_user_links(discord_user_id);
