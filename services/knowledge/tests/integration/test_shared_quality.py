"""Integration tests for search quality scoring and usage analytics."""

from datetime import datetime, timedelta, timezone

import pytest

pytestmark = pytest.mark.integration

INTERNAL_TOKEN = "test-internal-token"
HEADERS = {"Authorization": f"Bearer {INTERNAL_TOKEN}"}


async def _create_collection(app_client, name, owner, visibility="shared"):
    resp = await app_client.post(
        "/internal/admin/shared/collections",
        headers=HEADERS,
        json={"name": name, "created_by": owner, "visibility": visibility},
    )
    assert resp.status_code == 200, f"collection create failed: {resp.text}"
    return resp.json()["id"]


async def _ingest_source(app_client, collection_id, title, content, owner):
    resp = await app_client.post(
        "/internal/admin/shared/sources",
        headers=HEADERS,
        json={
            "collection_id": collection_id,
            "title": title,
            "source_type": "text",
            "raw_content": content,
            "created_by": owner,
        },
    )
    assert resp.status_code == 200, f"ingest failed: {resp.text}"
    return resp.json()


async def _admin_search(app_client, q, requester_id, collection_id=None):
    params = {"q": q, "requester_id": requester_id}
    if collection_id:
        params["collection_id"] = collection_id
    resp = await app_client.get(
        "/internal/admin/shared/search",
        headers=HEADERS,
        params=params,
    )
    assert resp.status_code == 200, f"search failed: {resp.text}"
    return resp.json()


class TestSearchQualityScoring:
    async def test_search_result_quality_score(self, app_client):
        """Search results include quality_score (0–1) and quality_label."""
        cid = await _create_collection(app_client, "Quality Score Col", "user-qs")
        await _ingest_source(
            app_client, cid, "Quality Doc",
            "Machine learning model training and evaluation with neural networks.",
            "user-qs",
        )

        data = await _admin_search(app_client, "machine learning", "user-qs")
        assert data["count"] >= 1

        result = data["results"][0]
        assert "quality_score" in result
        assert "quality_label" in result
        assert 0.0 <= result["quality_score"] <= 1.0
        assert result["quality_label"] in ("high", "medium", "low")

    async def test_search_quality_summary(self, app_client):
        """Search response includes quality_summary with expected fields."""
        cid = await _create_collection(app_client, "Quality Summary Col", "user-qsum")
        await _ingest_source(
            app_client, cid, "QSum Doc",
            "Deep learning frameworks like PyTorch and TensorFlow enable rapid prototyping.",
            "user-qsum",
        )

        data = await _admin_search(app_client, "deep learning", "user-qsum")
        assert "quality_summary" in data

        qs = data["quality_summary"]
        assert "avg_score" in qs
        assert "min_score" in qs
        assert "max_score" in qs
        assert "distribution" in qs
        assert set(qs["distribution"].keys()) == {"high", "medium", "low"}

    async def test_search_zero_results_quality_summary(self, app_client):
        """Zero results returns zeroed quality_summary."""
        data = await _admin_search(app_client, "xyznonexistent99999", "user-zeroqs")
        assert data["count"] == 0
        assert data["quality_summary"]["avg_score"] == 0.0
        assert data["quality_summary"]["min_score"] == 0.0
        assert data["quality_summary"]["max_score"] == 0.0
        assert data["quality_summary"]["distribution"] == {"high": 0, "medium": 0, "low": 0}

    async def test_top_result_has_max_quality_score(self, app_client):
        """The first result (highest ts_rank) should have quality_score 1.0."""
        cid = await _create_collection(app_client, "Top Score Col", "user-ts")
        await _ingest_source(
            app_client, cid, "Top Doc",
            "Kubernetes cluster management and pod orchestration.",
            "user-ts",
        )
        await _ingest_source(
            app_client, cid, "Other Doc",
            "General programming concepts and algorithms.",
            "user-ts",
        )

        data = await _admin_search(app_client, "Kubernetes", "user-ts")
        assert data["count"] >= 1
        assert data["results"][0]["quality_score"] == 1.0


class TestRetrievalCollectionId:
    async def test_retrieval_records_collection_id(self, app_client, db_pool):
        """Retrieval audit records collection_id when searching with filter."""
        cid = await _create_collection(app_client, "Ret ColId Col", "user-rcid")
        await _ingest_source(
            app_client, cid, "Ret ColId Doc",
            "Ansible playbook automation and configuration management.",
            "user-rcid",
        )

        await _admin_search(app_client, "Ansible", "user-rcid", collection_id=cid)

        row = await db_pool.fetchrow(
            """SELECT collection_id FROM shared_retrievals
               WHERE requester_id = 'user-rcid'
               ORDER BY created_at DESC LIMIT 1"""
        )
        assert row is not None
        assert str(row["collection_id"]) == cid

    async def test_retrieval_infers_collection_id(self, app_client, db_pool):
        """Retrieval audit infers collection_id from first result when no filter given."""
        cid = await _create_collection(app_client, "Ret Infer Col", "user-rinf")
        await _ingest_source(
            app_client, cid, "Ret Infer Doc",
            "Terraform provider configuration and state management.",
            "user-rinf",
        )

        await _admin_search(app_client, "Terraform", "user-rinf")

        row = await db_pool.fetchrow(
            """SELECT collection_id FROM shared_retrievals
               WHERE requester_id = 'user-rinf'
               ORDER BY created_at DESC LIMIT 1"""
        )
        assert row is not None
        assert str(row["collection_id"]) == cid


class TestUsageAnalytics:
    async def test_stats_top_collections(self, app_client):
        """Stats response includes usage.top_collections array."""
        cid = await _create_collection(app_client, "Usage Top Col", "user-utc")
        await _ingest_source(
            app_client, cid, "Usage Top Doc",
            "CI/CD pipeline design with GitHub Actions and Jenkins.",
            "user-utc",
        )
        await _admin_search(app_client, "CI/CD", "user-utc", collection_id=cid)

        resp = await app_client.get("/internal/admin/shared/stats", headers=HEADERS)
        data = resp.json()

        assert "usage" in data
        assert "top_collections" in data["usage"]
        assert isinstance(data["usage"]["top_collections"], list)

        # The collection we searched should appear
        names = [c["name"] for c in data["usage"]["top_collections"]]
        assert "Usage Top Col" in names

        # Each entry has expected fields
        for entry in data["usage"]["top_collections"]:
            assert "id" in entry
            assert "name" in entry
            assert "retrieval_count" in entry

    async def test_stats_top_sources(self, app_client):
        """Stats response includes usage.top_sources array."""
        cid = await _create_collection(app_client, "Usage Src Col", "user-usc")
        await _ingest_source(
            app_client, cid, "Usage Src Doc",
            "Grafana alerting rules and notification channels.",
            "user-usc",
        )
        await _admin_search(app_client, "Grafana alerting", "user-usc")

        resp = await app_client.get("/internal/admin/shared/stats", headers=HEADERS)
        data = resp.json()

        assert "top_sources" in data["usage"]
        assert isinstance(data["usage"]["top_sources"], list)

        # Each entry has expected fields
        for entry in data["usage"]["top_sources"]:
            assert "id" in entry
            assert "title" in entry
            assert "collection_name" in entry
            assert "retrieval_count" in entry

    async def test_stats_usage_since_filter(self, app_client):
        """Usage section respects the since parameter."""
        cid = await _create_collection(app_client, "Usage Since Col", "user-usf")
        await _ingest_source(
            app_client, cid, "Usage Since Doc",
            "Prometheus monitoring with custom metrics and exporters.",
            "user-usf",
        )
        await _admin_search(app_client, "Prometheus monitoring", "user-usf", collection_id=cid)

        # Future timestamp — should return empty usage
        future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        resp = await app_client.get(
            "/internal/admin/shared/stats",
            headers=HEADERS,
            params={"since": future},
        )
        data = resp.json()

        assert data["usage"]["top_collections"] == []
        assert data["usage"]["top_sources"] == []

    async def test_stats_usage_no_pii_leak(self, app_client):
        """Usage section must not contain requester_id or query text."""
        cid = await _create_collection(app_client, "Usage PII Col", "user-upii")
        await _ingest_source(
            app_client, cid, "Usage PII Doc",
            "Secrets management with HashiCorp Vault.",
            "user-upii",
        )
        await _admin_search(app_client, "secrets", "user-upii", collection_id=cid)

        resp = await app_client.get("/internal/admin/shared/stats", headers=HEADERS)
        data = resp.json()

        usage_str = str(data["usage"])
        assert "requester_id" not in usage_str
        assert "query" not in usage_str
