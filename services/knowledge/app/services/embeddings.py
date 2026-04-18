"""Embedding generation via AI service (LiteLLM proxy).

Routes through the existing model infrastructure so embeddings are
tracked by the same policies and usage pipeline as inference calls.
"""

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

AI_SERVICE_URL = os.environ.get("AI_SERVICE_URL", "http://ai:8000")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "text-embedding-3-small")
AKM_INTERNAL_SERVICE_TOKEN = os.environ.get("AKM_INTERNAL_SERVICE_TOKEN", "")


async def generate_embeddings(texts: list[str]) -> list[list[float]] | None:
    """Generate embeddings for a list of texts via the AI service.

    Returns a list of embedding vectors (1536-dim for text-embedding-3-small),
    or None if the service is unavailable or not configured.
    """
    if not texts:
        return []

    if not AKM_INTERNAL_SERVICE_TOKEN:
        logger.warning("AKM_INTERNAL_SERVICE_TOKEN not set — skipping embeddings")
        return None

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{AI_SERVICE_URL}/v1/embeddings",
                json={
                    "model": EMBEDDING_MODEL,
                    "input": texts,
                },
                headers={
                    "Authorization": f"Bearer {AKM_INTERNAL_SERVICE_TOKEN}",
                    "Content-Type": "application/json",
                },
            )

            if resp.status_code != 200:
                logger.warning(
                    "Embedding request failed: %d %s",
                    resp.status_code,
                    resp.text[:200],
                )
                return None

            data = resp.json()
            embeddings = [item["embedding"] for item in data["data"]]
            logger.info(
                "Generated %d embeddings (model=%s, dim=%d)",
                len(embeddings),
                EMBEDDING_MODEL,
                len(embeddings[0]) if embeddings else 0,
            )
            return embeddings

    except Exception as exc:
        logger.warning("Embedding generation error: %s", exc)
        return None


async def generate_embedding(text: str) -> list[float] | None:
    """Generate a single embedding. Convenience wrapper."""
    result = await generate_embeddings([text])
    if result and len(result) > 0:
        return result[0]
    return None
