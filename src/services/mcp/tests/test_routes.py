from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from jose import jwt as jose_jwt
from fastapi.testclient import TestClient

from app.main import app, verify_token
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

# Override the production verify_token with a test verifier
_test_verify_token = make_verify_token(
    issuer=TEST_ISSUER,
    get_signing_key=lambda _header: _public_pem,
)

app.dependency_overrides[verify_token] = _test_verify_token

client = TestClient(app)


def _sign_token(claims: dict) -> str:
    return jose_jwt.encode(claims, _private_pem, algorithm="RS256")


def test_health_returns_200():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "healthy", "service": "mcp"}


def test_me_returns_401_without_auth():
    response = client.get("/me")
    assert response.status_code == 401


def test_me_returns_claims_with_valid_token():
    token = _sign_token({"sub": "user1", "iss": TEST_ISSUER, "exp": 9999999999, "realm_roles": ["admin"]})
    response = client.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    data = response.json()
    assert data["sub"] == "user1"
    assert data["realm_roles"] == ["admin"]
