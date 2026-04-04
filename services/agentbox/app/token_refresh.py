"""Background token refresh for model-router JWT.

Runs in a daemon thread. Wakes up periodically and renews the token
before the 1h expiry. Updates the MODEL_ROUTER_TOKEN env var in-place
so that subsequent chat.py requests use the new token.

Design mirrors the AKM refresh pattern (single-use refresh secret),
but calls the API service's /internal/model-router/refresh-token
endpoint instead of the knowledge service.
"""

import logging
import os
import threading
import time

import requests

logger = logging.getLogger(__name__)

# Refresh 5 minutes before expiry (token TTL is 1h = 3600s)
REFRESH_MARGIN_S = 300
CHECK_INTERVAL_S = 60


def _decode_exp(token: str) -> int | None:
    """Extract exp claim from JWT without verification."""
    import base64
    import json
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        # Add padding
        payload_b64 = parts[1] + "=" * (4 - len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        return payload.get("exp")
    except Exception:
        return None


def _do_refresh(
    refresh_url: str,
    current_token: str,
    refresh_secret: str,
) -> dict | None:
    """Call the refresh endpoint. Returns new token data or None on failure."""
    try:
        resp = requests.post(
            refresh_url,
            json={"refresh_secret": refresh_secret},
            headers={
                "Authorization": f"Bearer {current_token}",
                "Content-Type": "application/json",
            },
            timeout=10,
        )
        if resp.status_code == 200:
            return resp.json()
        logger.warning(
            "Model-router token refresh failed: %d %s",
            resp.status_code,
            resp.text[:200],
        )
    except Exception as e:
        logger.warning("Model-router token refresh error: %s", e)
    return None


def start_model_router_refresh_loop() -> threading.Thread | None:
    """Start the background refresh thread if configured. Returns the thread or None."""
    refresh_url = os.environ.get("MODEL_ROUTER_REFRESH_URL")
    token = os.environ.get("MODEL_ROUTER_TOKEN")
    secret = os.environ.get("MODEL_ROUTER_REFRESH_SECRET")

    if not refresh_url or not token or not secret:
        logger.info("Model-router refresh not configured — skipping refresh loop")
        return None

    def _loop():
        nonlocal token, secret
        logger.info("Model-router token refresh loop started (margin=%ds)", REFRESH_MARGIN_S)

        while True:
            time.sleep(CHECK_INTERVAL_S)

            current_token = os.environ.get("MODEL_ROUTER_TOKEN", token)
            exp = _decode_exp(current_token)
            if exp is None:
                logger.warning("Cannot decode MODEL_ROUTER_TOKEN exp — skipping refresh cycle")
                continue

            remaining = exp - time.time()
            if remaining > REFRESH_MARGIN_S:
                continue  # Not yet time to refresh

            logger.info("Model-router token expires in %.0fs — refreshing", remaining)
            result = _do_refresh(refresh_url, current_token, secret)
            if result:
                new_token = result.get("token")
                new_secret = result.get("refresh_secret")
                if new_token and new_secret:
                    os.environ["MODEL_ROUTER_TOKEN"] = new_token
                    secret = new_secret
                    os.environ["MODEL_ROUTER_REFRESH_SECRET"] = new_secret
                    token = new_token
                    logger.info("Model-router token refreshed successfully (new exp in 1h)")
                else:
                    logger.warning("Model-router refresh response missing token or secret")
            else:
                logger.warning("Model-router token refresh failed — will retry in %ds", CHECK_INTERVAL_S)

    t = threading.Thread(target=_loop, daemon=True, name="model-router-refresh")
    t.start()
    return t
