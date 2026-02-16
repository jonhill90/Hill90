import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from jose import jwt as jose_jwt
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from app.middleware.auth import make_verify_token

# Generate throwaway RSA keypair for test signing
_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_private_pem = _private_key.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.PKCS8,
    serialization.NoEncryption(),
)
_public_key = _private_key.public_key()
_public_pem = _public_key.public_bytes(
    serialization.Encoding.PEM,
    serialization.PublicFormat.SubjectPublicKeyInfo,
).decode()

TEST_ISSUER = "https://auth.hill90.com/realms/hill90"

# Build verify_token with test key — no JWKS fetch
_verify_token = make_verify_token(
    issuer=TEST_ISSUER,
    get_signing_key=lambda: _public_pem,
)

# Minimal FastAPI app with auth dependency on a protected route
app = FastAPI()


@app.get("/protected")
def protected(user: dict = Depends(_verify_token)):
    return {"sub": user.get("sub")}


client = TestClient(app)


def _sign_token(claims: dict) -> str:
    return jose_jwt.encode(claims, _private_pem, algorithm="RS256")


def test_missing_auth_header_returns_401():
    response = client.get("/protected")
    assert response.status_code == 401


def test_invalid_token_returns_401():
    response = client.get("/protected", headers={"Authorization": "Bearer not.a.jwt"})
    assert response.status_code == 401


def test_wrong_issuer_returns_401():
    token = _sign_token({"sub": "user1", "iss": "https://wrong-issuer.com", "exp": 9999999999})
    response = client.get("/protected", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


def test_valid_token_returns_200():
    token = _sign_token({"sub": "user1", "iss": TEST_ISSUER, "exp": 9999999999})
    response = client.get("/protected", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    assert response.json()["sub"] == "user1"
