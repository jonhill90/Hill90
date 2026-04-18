"""Embedding generation via AI service model router.

Routes through the AI service /internal/embeddings endpoint so embeddings
use the same LiteLLM proxy and configuration as inference calls.
Falls back to direct LiteLLM if AI service is unavailable.
"""

import logging
import os

import httpx

logger = logging.getLogger(__name__)

AI_SERVICE_URL = os.environ.get("AI_SERVICE_URL", "http://ai:8000")
MODEL_ROUTER_INTERNAL_SERVICE_TOKEN = os.environ.get("MODEL_ROUTER_INTERNAL_SERVICE_TOKEN", "")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "text-embedding-3-small")

# Fallback: direct LiteLLM (used if AI service token not configured)
LITELLM_URL = os.environ.get("LITELLM_URL", "http://litellm:4000")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")


async def generate_embeddings(texts: list[str]) -> list[list[float]] | None:
    """Generate embeddings for a list of texts via the AI service.

    Returns a list of embedding vectors (1536-dim for text-embedding-3-small),
    or None if the service is unavailable or not configured.
    """
    if not texts:
        return []

    # Prefer AI service model router
    if MODEL_ROUTER_INTERNAL_SERVICE_TOKEN:
        result = await _via_model_router(texts)
        if result is not None:
            return result
        logger.warning("AI service embedding failed, trying LiteLLM fallback")

    # Fallback: direct LiteLLM
    if LITELLM_MASTER_KEY:
        return await _via_litellm(texts)

    logger.warning("No embedding credentials configured — skipping")
    return None


async def _via_model_router(texts: list[str]) -> list[list[float]] | None:
    """Route embeddings through AI service /internal/embeddings."""
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{AI_SERVICE_URL}/internal/embeddings",
                json={"model": EMBEDDING_MODEL, "input": texts},
                headers={
                    "Authorization": f"Bearer {MODEL_ROUTER_INTERNAL_SERVICE_TOKEN}",
                    "Content-Type": "application/json",
                },
            )
            if resp.status_code != 200:
                logger.warning("AI service embedding failed: %d %s", resp.status_code, resp.text[:200])
                return None
            data = resp.json()
            embeddings = [item["embedding"] for item in data["data"]]
            logger.info("Generated %d embeddings via model-router (model=%s, dim=%d)",
                        len(embeddings), EMBEDDING_MODEL, len(embeddings[0]) if embeddings else 0)
            return embeddings
    except Exception as exc:
        logger.warning("AI service embedding error: %s", exc)
        return None


async def _via_litellm(texts: list[str]) -> list[list[float]] | None:
    """Direct LiteLLM fallback for embeddings."""
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{LITELLM_URL}/v1/embeddings",
                json={"model": EMBEDDING_MODEL, "input": texts},
                headers={
                    "Authorization": f"Bearer {LITELLM_MASTER_KEY}",
                    "Content-Type": "application/json",
                },
            )
            if resp.status_code != 200:
                logger.warning("LiteLLM embedding failed: %d %s", resp.status_code, resp.text[:200])
                return None
            data = resp.json()
            embeddings = [item["embedding"] for item in data["data"]]
            logger.info("Generated %d embeddings via LiteLLM (model=%s, dim=%d)",
                        len(embeddings), EMBEDDING_MODEL, len(embeddings[0]) if embeddings else 0)
            return embeddings
    except Exception as exc:
        logger.warning("LiteLLM embedding error: %s", exc)
        return None


async def generate_embedding(text: str) -> list[float] | None:
    """Generate a single embedding. Convenience wrapper."""
    result = await generate_embeddings([text])
    if result and len(result) > 0:
        return result[0]
    return None
