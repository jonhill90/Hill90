-- Seed embedding models into model_catalog for Phase 3 (streaming + embeddings)
INSERT INTO model_catalog (name, provider, description) VALUES
    ('text-embedding-3-small', 'openai', 'OpenAI text-embedding-3-small — fast, cost-effective embeddings'),
    ('text-embedding-ada-002', 'openai', 'OpenAI text-embedding-ada-002 — legacy embedding model')
ON CONFLICT (name) DO NOTHING;
