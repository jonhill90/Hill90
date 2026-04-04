"""Search result quality scoring and classification."""

from __future__ import annotations

from typing import Any

# Thresholds for quality classification based on normalized scores (0–1).
HIGH_THRESHOLD = 0.3
MEDIUM_THRESHOLD = 0.1


def classify_score(score: float) -> str:
    """Classify a normalized quality score into high/medium/low."""
    if score >= HIGH_THRESHOLD:
        return "high"
    if score >= MEDIUM_THRESHOLD:
        return "medium"
    return "low"


def enrich_results_with_quality(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Add quality_score (0–1) and quality_label to each result.

    Normalizes ts_rank scores relative to the max score in the result set.
    """
    if not results:
        return results

    max_score = max(float(r.get("score", 0)) for r in results)

    for r in results:
        raw = float(r.get("score", 0))
        normalized = raw / max_score if max_score > 0 else 0.0
        r["quality_score"] = round(normalized, 4)
        r["quality_label"] = classify_score(normalized)

    return results


def compute_quality_summary(results: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute aggregate quality summary from enriched results."""
    if not results:
        return {
            "avg_score": 0.0,
            "min_score": 0.0,
            "max_score": 0.0,
            "distribution": {"high": 0, "medium": 0, "low": 0},
        }

    scores = [float(r.get("quality_score", 0)) for r in results]
    labels = [r.get("quality_label", "low") for r in results]

    return {
        "avg_score": round(sum(scores) / len(scores), 4),
        "min_score": round(min(scores), 4),
        "max_score": round(max(scores), 4),
        "distribution": {
            "high": labels.count("high"),
            "medium": labels.count("medium"),
            "low": labels.count("low"),
        },
    }
