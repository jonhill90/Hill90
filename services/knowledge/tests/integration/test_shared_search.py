"""Integration tests for shared knowledge FTS search."""

import pytest

pytestmark = pytest.mark.integration

INTERNAL_TOKEN = "test-internal-token"
HEADERS = {"Authorization": f"Bearer {INTERNAL_TOKEN}"}


async def _setup_collection_with_sources(app_client, name, owner, visibility="private"):
    """Helper to create a collection and ingest sources."""
    resp = await app_client.post(
        "/internal/admin/shared/collections",
        headers=HEADERS,
        json={"name": name, "created_by": owner, "visibility": visibility},
    )
    cid = resp.json()["id"]
    return cid


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
    assert resp.status_code == 200
    return resp.json()


class TestFtsSearchRanked:
    async def test_fts_search_ranked(self, app_client):
        cid = await _setup_collection_with_sources(app_client, "Search Ranked Col", "user-search", "shared")

        await _ingest_source(
            app_client, cid, "FastAPI Guide",
            "A comprehensive guide to FastAPI web framework and API design.",
            "user-search",
        )
        await _ingest_source(
            app_client, cid, "Python Basics",
            "Introduction to Python programming language fundamentals.",
            "user-search",
        )

        resp = await app_client.get(
            "/internal/admin/shared/search",
            headers=HEADERS,
            params={"q": "FastAPI", "requester_id": "user-search"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] >= 1
        assert data["search_type"] == "fts"
        # FastAPI results should be present
        contents = [r["content"] for r in data["results"]]
        assert any("FastAPI" in c for c in contents)


class TestFtsSearchVisibilityScoped:
    async def test_fts_search_visibility_scoped(self, app_client):
        # Private collection owned by user-priv
        priv_cid = await _setup_collection_with_sources(
            app_client, "Private Search Col", "user-priv", "private"
        )
        await _ingest_source(
            app_client, priv_cid, "Secret Doc",
            "This document contains classified information about unicorns.",
            "user-priv",
        )

        # Search as a different user should NOT find it
        resp = await app_client.get(
            "/internal/admin/shared/search",
            headers=HEADERS,
            params={"q": "unicorns", "owner": "user-other", "requester_id": "user-other"},
        )
        assert resp.status_code == 200
        assert resp.json()["count"] == 0

        # Search as owner should find it
        resp2 = await app_client.get(
            "/internal/admin/shared/search",
            headers=HEADERS,
            params={"q": "unicorns", "owner": "user-priv", "requester_id": "user-priv"},
        )
        assert resp2.status_code == 200
        assert resp2.json()["count"] >= 1


class TestSearchReturnsProvenance:
    async def test_search_returns_provenance(self, app_client):
        cid = await _setup_collection_with_sources(
            app_client, "Provenance Col", "user-prov", "shared"
        )
        await _ingest_source(
            app_client, cid, "Provenance Source",
            "Specific content about quantum computing for provenance test.",
            "user-prov",
        )

        resp = await app_client.get(
            "/internal/admin/shared/search",
            headers=HEADERS,
            params={"q": "quantum computing", "requester_id": "user-prov"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] >= 1

        result = data["results"][0]
        # Verify provenance fields
        assert "chunk_id" in result
        assert "source_id" in result
        assert "source_title" in result
        assert "document_id" in result
        assert "document_title" in result
        assert "collection_id" in result
        assert "collection_name" in result
        assert "chunk_index" in result
        assert "score" in result
        assert "headline" in result
