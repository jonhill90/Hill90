from typing import Callable
from fastapi import HTTPException, Request


def make_verify_token(
    issuer: str,
    get_signing_key: Callable[[dict], str],
):
    """Factory that returns a FastAPI dependency for JWT validation.

    Args:
        issuer: Expected token issuer (iss claim).
        get_signing_key: Callable accepting the decoded token header dict
            and returning the PEM-encoded public key.
    """
    from jose import jwt as jose_jwt, JWTError

    async def verify_token(request: Request) -> dict:
        auth_header = request.headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

        token = auth_header[7:]

        try:
            header = jose_jwt.get_unverified_header(token)
            key = get_signing_key(header)
            payload = jose_jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                issuer=issuer,
                options={"verify_aud": False, "require_exp": True},
            )
        except JWTError:
            raise HTTPException(status_code=401, detail="Invalid or expired token")

        return payload

    return verify_token
