"""Shared test fixtures for the AKM test suite."""

import os
import time
import uuid
from collections.abc import AsyncGenerator
from pathlib import Path

import asyncpg
import jwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)
from httpx import ASGITransport, AsyncClient

from app.config import Settings


@pytest.fixture(scope="session")
def ed25519_keypair() -> tuple[bytes, bytes]:
    """Session-scoped Ed25519 key pair."""
    private_key = Ed25519PrivateKey.generate()
    private_pem = private_key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    public_pem = private_key.public_key().public_bytes(
        Encoding.PEM, PublicFormat.SubjectPublicKeyInfo
    )
    return private_pem, public_pem


@pytest.fixture()
def agent_token(ed25519_keypair: tuple[bytes, bytes]) -> str:
    """Generate a valid agent JWT for test-agent with owner claim."""
    private_pem, _ = ed25519_keypair
    now = int(time.time())
    payload = {
        "sub": "test-agent",
        "iss": "hill90-api",
        "aud": "hill90-akm",
        "exp": now + 3600,
        "iat": now,
        "jti": str(uuid.uuid4()),
        "scopes": ["akm:read", "akm:write"],
        "owner": "test-user-sub",
    }
    return jwt.encode(payload, private_pem, algorithm="EdDSA")


@pytest.fixture()
def shared_write_token(ed25519_keypair: tuple[bytes, bytes]) -> str:
    """Generate a valid agent JWT with shared-write scope."""
    private_pem, _ = ed25519_keypair
    now = int(time.time())
    payload = {
        "sub": "test-agent",
        "iss": "hill90-api",
        "aud": "hill90-akm",
        "exp": now + 3600,
        "iat": now,
        "jti": str(uuid.uuid4()),
        "scopes": ["akm:read", "akm:write", "akm:shared-write"],
    }
    return jwt.encode(payload, private_pem, algorithm="EdDSA")


@pytest.fixture()
def other_agent_token(ed25519_keypair: tuple[bytes, bytes]) -> str:
    """Generate a valid agent JWT for other-agent (different sub and owner)."""
    private_pem, _ = ed25519_keypair
    now = int(time.time())
    payload = {
        "sub": "other-agent",
        "iss": "hill90-api",
        "aud": "hill90-akm",
        "exp": now + 3600,
        "iat": now,
        "jti": str(uuid.uuid4()),
        "scopes": ["akm:read", "akm:write"],
        "owner": "other-user-sub",
    }
    return jwt.encode(payload, private_pem, algorithm="EdDSA")


@pytest.fixture()
def test_settings(tmp_path: Path, ed25519_keypair: tuple[bytes, bytes]) -> Settings:
    """Create Settings pointing at tmp_path for data and a test DB URL."""
    _, public_pem = ed25519_keypair
    public_key_path = tmp_path / "public.pem"
    public_key_path.write_bytes(public_pem)

    private_pem, _ = ed25519_keypair
    private_key_path = tmp_path / "private.pem"
    private_key_path.write_bytes(private_pem)

    return Settings(
        port=8002,
        database_url=os.environ.get(
            "AKM_TEST_DATABASE_URL",
            "postgresql://postgres:postgres@localhost:5432/hill90_akm_test",
        ),
        public_key_path=str(public_key_path),
        private_key_path=str(private_key_path),
        data_dir=str(tmp_path / "knowledge"),
        context_token_budget=2000,
        internal_service_token="test-internal-token",
    )


@pytest_asyncio.fixture()
async def db_pool(test_settings: Settings) -> AsyncGenerator[asyncpg.Pool, None]:
    """Create a test database pool, run migrations, and clean up after."""
    pool = await asyncpg.create_pool(test_settings.database_url, min_size=1, max_size=5)
    assert pool is not None

    # Run migrations
    from app.db.migrate import run_migrations

    await run_migrations(pool)

    yield pool

    # Clean up tables after tests
    async with pool.acquire() as conn:
        # Shared knowledge tables (cascade handles chunks/documents via FK)
        await conn.execute("DELETE FROM shared_retrievals")
        await conn.execute("DELETE FROM shared_chunks")
        await conn.execute("DELETE FROM shared_documents")
        await conn.execute("DELETE FROM shared_ingest_jobs")
        await conn.execute("DELETE FROM shared_sources")
        await conn.execute("DELETE FROM shared_collections")
        # AKM tables
        await conn.execute("DELETE FROM quarantine_entries")
        await conn.execute("DELETE FROM agent_tokens")
        await conn.execute("DELETE FROM revoked_tokens")
        await conn.execute("DELETE FROM knowledge_links")
        await conn.execute("DELETE FROM knowledge_entries")

    await pool.close()


@pytest_asyncio.fixture()
async def app_client(
    test_settings: Settings,
    db_pool: asyncpg.Pool,
    ed25519_keypair: tuple[bytes, bytes],
) -> AsyncGenerator[AsyncClient, None]:
    """Create an HTTPX async test client bound to the FastAPI app."""
    from app.main import create_app

    app = create_app(settings=test_settings, pool=db_pool)
    transport = ASGITransport(app=app)  # type: ignore[arg-type]
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
