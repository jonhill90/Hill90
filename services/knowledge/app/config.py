"""AKM service configuration via Pydantic settings."""

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
