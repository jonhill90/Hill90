"""
Hill90 MCP Gateway
Python/FastAPI with MCP SDK
"""

import os

import requests as http_requests
from cryptography.hazmat.primitives import serialization
from fastapi import Depends, FastAPI
from jose import jwk

from app.middleware.auth import make_verify_token

app = FastAPI(title="Hill90 MCP Gateway", version="0.1.0")

KEYCLOAK_ISSUER = os.environ.get("KEYCLOAK_ISSUER", "https://auth.hill90.com/realms/hill90")
KEYCLOAK_JWKS_URI = os.environ.get(
    "KEYCLOAK_JWKS_URI",
    f"{KEYCLOAK_ISSUER}/protocol/openid-connect/certs",
)

# Simple in-memory JWKS cache
_jwks_cache: dict | None = None


def _jwks_key_resolver(header: dict) -> str:
    """Synchronous JWKS key resolver using requests with caching."""
    global _jwks_cache
    kid = header.get("kid")

    # Try cached keys first
    if _jwks_cache is not None:
        for key in _jwks_cache.get("keys", []):
            if key.get("kid") == kid:
                key_obj = jwk.construct(key)
                return key_obj.public_key().public_bytes(
                    encoding=serialization.Encoding.PEM,
                    format=serialization.PublicFormat.SubjectPublicKeyInfo,
                ).decode()

    # Fetch fresh JWKS
    resp = http_requests.get(KEYCLOAK_JWKS_URI, timeout=10)
    resp.raise_for_status()
    _jwks_cache = resp.json()

    for key in _jwks_cache.get("keys", []):
        if key.get("kid") == kid:
            key_obj = jwk.construct(key)
            return key_obj.public_key().public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            ).decode()

    raise ValueError(f"Key with kid={kid!r} not found in JWKS")


verify_token = make_verify_token(
    issuer=KEYCLOAK_ISSUER,
    get_signing_key=_jwks_key_resolver,
)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "service": "mcp"}


@app.get("/me")
async def me(claims: dict = Depends(verify_token)):
    """Return decoded JWT claims for the authenticated user."""
    return claims
