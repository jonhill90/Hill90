"""AKM service configuration via Pydantic settings."""

from pydantic import model_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    port: int = 8002
    database_url: str = "postgresql://postgres:postgres@postgres:5432/hill90_akm"
    public_key_path: str = "/etc/akm/public.pem"
    private_key_path: str = "/etc/akm/private.pem"
    data_dir: str = "/data/knowledge"
    context_token_budget: int = 2000
    internal_service_token: str = ""
    reconciler_interval_seconds: int = 300  # 5 minutes
    otel_service_name: str = "knowledge"

    model_config = {"env_prefix": "AKM_"}

    @model_validator(mode="after")
    def _validate_internal_token(self) -> "Settings":
        if not self.internal_service_token:
            raise ValueError("AKM_INTERNAL_SERVICE_TOKEN must be set (non-empty)")
        return self
