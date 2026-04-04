"""Unit tests for quality scoring and classification."""

import pytest

from app.services.quality import (
    classify_score,
    compute_quality_summary,
    enrich_results_with_quality,
)


class TestClassifyScore:
    def test_high_score(self):
        assert classify_score(0.5) == "high"
        assert classify_score(0.3) == "high"
        assert classify_score(1.0) == "high"

    def test_medium_score(self):
        assert classify_score(0.1) == "medium"
        assert classify_score(0.29) == "medium"

    def test_low_score(self):
        assert classify_score(0.0) == "low"
        assert classify_score(0.09) == "low"

    def test_boundary_values(self):
        assert classify_score(0.3) == "high"
        assert classify_score(0.1) == "medium"
        assert classify_score(0.099) == "low"


class TestEnrichResultsWithQuality:
    def test_empty_results(self):
        assert enrich_results_with_quality([]) == []

    def test_single_result_gets_max_score(self):
        results = [{"score": 0.5, "content": "test"}]
        enriched = enrich_results_with_quality(results)
        assert enriched[0]["quality_score"] == 1.0
        assert enriched[0]["quality_label"] == "high"

    def test_multiple_results_normalized(self):
        results = [
            {"score": 1.0, "content": "best"},
            {"score": 0.5, "content": "mid"},
            {"score": 0.05, "content": "low"},
        ]
        enriched = enrich_results_with_quality(results)
        assert enriched[0]["quality_score"] == 1.0
        assert enriched[1]["quality_score"] == 0.5
        assert enriched[2]["quality_score"] == 0.05
        assert enriched[0]["quality_label"] == "high"
        assert enriched[1]["quality_label"] == "high"
        assert enriched[2]["quality_label"] == "low"

    def test_zero_max_score(self):
        results = [{"score": 0, "content": "zero"}]
        enriched = enrich_results_with_quality(results)
        assert enriched[0]["quality_score"] == 0.0
        assert enriched[0]["quality_label"] == "low"


class TestComputeQualitySummary:
    def test_empty_results(self):
        summary = compute_quality_summary([])
        assert summary["avg_score"] == 0.0
        assert summary["min_score"] == 0.0
        assert summary["max_score"] == 0.0
        assert summary["distribution"] == {"high": 0, "medium": 0, "low": 0}

    def test_single_result(self):
        results = [{"quality_score": 0.8, "quality_label": "high"}]
        summary = compute_quality_summary(results)
        assert summary["avg_score"] == 0.8
        assert summary["min_score"] == 0.8
        assert summary["max_score"] == 0.8
        assert summary["distribution"]["high"] == 1

    def test_mixed_results(self):
        results = [
            {"quality_score": 1.0, "quality_label": "high"},
            {"quality_score": 0.2, "quality_label": "medium"},
            {"quality_score": 0.05, "quality_label": "low"},
        ]
        summary = compute_quality_summary(results)
        assert summary["min_score"] == 0.05
        assert summary["max_score"] == 1.0
        assert summary["distribution"]["high"] == 1
        assert summary["distribution"]["medium"] == 1
        assert summary["distribution"]["low"] == 1
