-- Migration 035: Deprecate icon_emoji — clear existing values
-- Column retained for read compatibility; planned removal in follow-up.

UPDATE user_models SET icon_emoji = NULL WHERE icon_emoji IS NOT NULL;
