"""Ed25519 JWT agent authentication middleware."""

from dataclasses import dataclass, field

import jwt
from jwt.exceptions import InvalidTokenError


class AuthError(Exception):
    """Raised when agent authentication fails."""


@dataclass
class AgentClaims:
    """Validated agent JWT claims."""

    sub: str
    iss: str
    aud: str
    exp: int
    iat: int
    jti: str
    scopes: list[str] = field(default_factory=list)


EXPECTED_ISSUER = "hill90-api"
EXPECTED_AUDIENCE = "hill90-akm"
CLOCK_SKEW_SECONDS = 30


def verify_agent_token(
    token: str,
    public_key_pem: bytes,
    *,
    revoked_jtis: set[str] | None = None,
) -> AgentClaims:
    """Verify an Ed25519-signed JWT and return validated claims.

    Raises AuthError on any validation failure.
    """
    try:
        payload = jwt.decode(
            token,
            public_key_pem,
            algorithms=["EdDSA"],
            issuer=EXPECTED_ISSUER,
            audience=EXPECTED_AUDIENCE,
            options={"require": ["sub", "iss", "aud", "exp", "iat", "jti"]},
            leeway=CLOCK_SKEW_SECONDS,
        )
    except jwt.ExpiredSignatureError:
        raise AuthError("token expired")
    except jwt.InvalidIssuerError:
        raise AuthError("invalid issuer")
    except jwt.InvalidAudienceError:
        raise AuthError("invalid audience")
    except InvalidTokenError as e:
        raise AuthError(f"invalid token: {e}") from e

    jti = payload.get("jti", "")
    if revoked_jtis and jti in revoked_jtis:
        raise AuthError("token revoked")

    return AgentClaims(
        sub=payload["sub"],
        iss=payload["iss"],
        aud=payload["aud"],
        exp=payload["exp"],
        iat=payload["iat"],
        jti=jti,
        scopes=payload.get("scopes", []),
    )
