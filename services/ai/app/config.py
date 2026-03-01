"""AI service configuration via Pydantic settings."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """AI service settings — loaded from environment variables."""

    # LiteLLM proxy
    litellm_url: str = "http://litellm:4000"
    litellm_master_key: str = ""

    # Database (shared hill90_api DB for policy/usage tables)
    database_url: str = ""

    # Ed25519 public key for JWT verification
    public_key_path: str = "/etc/akm/public.pem"

    # Internal service token for /internal/* endpoints
    model_router_internal_service_token: str = ""

    # AES-256-GCM key for decrypting user provider API keys (BYOK)
    provider_key_encryption_key: str = ""

    # API service URL for delegation token signing (service-to-service)
    api_service_url: str = "http://api:3000"

    # Service metadata
    environment: str = "production"
    port: int = 8000

    model_config = {"env_prefix": "", "case_sensitive": False}


@lru_cache
def get_settings() -> Settings:
    return Settings()


def load_public_key(path: str | None = None) -> bytes:
    """Load Ed25519 public key PEM from disk."""
    key_path = Path(path or get_settings().public_key_path)
    if not key_path.exists():
        raise FileNotFoundError(f"Public key not found: {key_path}")
    return key_path.read_bytes()
