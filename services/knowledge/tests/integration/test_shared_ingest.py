"""Integration tests for shared knowledge ingestion."""

from unittest.mock import AsyncMock, patch

import pytest

pytestmark = pytest.mark.integration

INTERNAL_TOKEN = "test-internal-token"
HEADERS = {"Authorization": f"Bearer {INTERNAL_TOKEN}"}


async def _create_collection(app_client, name="Ingest Test Col", owner="user-ingest"):
    resp = await app_client.post(
        "/internal/admin/shared/collections",
        headers=HEADERS,
        json={"name": name, "created_by": owner},
    )
    assert resp.status_code == 200
    return resp.json()["id"]


class TestCreateSource:
    async def test_create_source_text(self, app_client):
        cid = await _create_collection(app_client, "Text Source Col")
        resp = await app_client.post(
            "/internal/admin/shared/sources",
            headers=HEADERS,
            json={
                "collection_id": cid,
                "title": "My Text Source",
                "source_type": "text",
                "raw_content": "This is the raw text content for testing.\n\nIt has multiple paragraphs.",
                "created_by": "user-ingest",
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["source"]["status"] == "active"
        assert data["ingest_job"]["status"] == "completed"
        assert data["ingest_job"]["chunk_count"] >= 1
        assert "document" in data

    async def test_create_source_markdown(self, app_client):
        cid = await _create_collection(app_client, "MD Source Col")
        resp = await app_client.post(
            "/internal/admin/shared/sources",
            headers=HEADERS,
            json={
                "collection_id": cid,
                "title": "My Markdown Source",
                "source_type": "markdown",
                "raw_content": "# Heading\n\nSome content.\n\n## Subheading\n\nMore content.",
                "created_by": "user-ingest",
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["source"]["status"] == "active"
        assert data["ingest_job"]["chunk_count"] >= 1


class TestIngestJobLifecycle:
    async def test_ingest_job_lifecycle(self, app_client):
        cid = await _create_collection(app_client, "Job Lifecycle Col")
        resp = await app_client.post(
            "/internal/admin/shared/sources",
            headers=HEADERS,
            json={
                "collection_id": cid,
                "title": "Lifecycle Test",
                "source_type": "text",
                "raw_content": "Content for lifecycle test.",
                "created_by": "user-ingest",
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        # V1: job runs synchronously, so it should be completed
        assert data["ingest_job"]["status"] == "completed"
        assert data["ingest_job"]["chunk_count"] >= 1


class TestIngestWebPage:
    @patch("app.services.ingest.fetch_and_extract", new_callable=AsyncMock)
    async def test_ingest_web_page_success(self, mock_fetch, app_client):
        mock_fetch.return_value = {
            "url": "https://example.com/article",
            "title": "Example Article",
            "content": "This is the extracted article content with enough text to chunk.",
            "content_type": "text/html",
        }
        cid = await _create_collection(app_client, "Web Page Col")
        resp = await app_client.post(
            "/internal/admin/shared/sources",
            headers=HEADERS,
            json={
                "collection_id": cid,
                "title": "Web Page Test",
                "source_type": "web_page",
                "source_url": "https://example.com/article",
                "created_by": "user-ingest",
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["source"]["status"] == "active"
        assert data["source"]["source_url"] == "https://example.com/article"
        assert data["ingest_job"]["status"] == "completed"
        assert data["ingest_job"]["chunk_count"] >= 1
        mock_fetch.assert_called_once_with("https://example.com/article")

    @patch("app.services.ingest.fetch_and_extract", new_callable=AsyncMock)
    async def test_ingest_web_page_fetch_error(self, mock_fetch, app_client):
        from app.services.web_page_fetcher import FetchError

        mock_fetch.side_effect = FetchError("Connection timed out fetching 'example.com'")
        cid = await _create_collection(app_client, "Web Page Error Col")
        resp = await app_client.post(
            "/internal/admin/shared/sources",
            headers=HEADERS,
            json={
                "collection_id": cid,
                "title": "Unreachable Page",
                "source_type": "web_page",
                "source_url": "https://example.com/timeout",
                "created_by": "user-ingest",
            },
        )
        # Fetch failures create source/job in error state (500), not bare 422
        assert resp.status_code == 500
        assert "timed out" in resp.json()["detail"].lower()

    async def test_ingest_web_page_missing_url(self, app_client):
        cid = await _create_collection(app_client, "Web Page No URL Col")
        resp = await app_client.post(
            "/internal/admin/shared/sources",
            headers=HEADERS,
            json={
                "collection_id": cid,
                "title": "No URL",
                "source_type": "web_page",
                "created_by": "user-ingest",
            },
        )
        assert resp.status_code == 422
        assert "source_url" in resp.json()["detail"].lower()


class TestContentHashDedup:
    async def test_content_hash_dedup(self, app_client):
        """Same content can be ingested but content_hash allows dedup detection."""
        cid = await _create_collection(app_client, "Dedup Col")
        content = "Identical content for dedup testing."

        resp1 = await app_client.post(
            "/internal/admin/shared/sources",
            headers=HEADERS,
            json={
                "collection_id": cid,
                "title": "Source A",
                "source_type": "text",
                "raw_content": content,
                "created_by": "user-ingest",
            },
        )
        assert resp1.status_code == 200

        resp2 = await app_client.post(
            "/internal/admin/shared/sources",
            headers=HEADERS,
            json={
                "collection_id": cid,
                "title": "Source B",
                "source_type": "text",
                "raw_content": content,
                "created_by": "user-ingest",
            },
        )
        assert resp2.status_code == 200

        # Both should exist — dedup is informational, not enforced at ingest
        sources_resp = await app_client.get(
            "/internal/admin/shared/sources",
            headers=HEADERS,
            params={"collection_id": cid},
        )
        sources = sources_resp.json()
        hashes = [s["content_hash"] for s in sources]
        # Same hash for same content
        assert len(set(hashes)) == 1


class TestSourceDeleteCascades:
    async def test_source_delete_cascades(self, app_client):
        cid = await _create_collection(app_client, "Source Delete Col")
        resp = await app_client.post(
            "/internal/admin/shared/sources",
            headers=HEADERS,
            json={
                "collection_id": cid,
                "title": "Deletable Source",
                "source_type": "text",
                "raw_content": "Content to be deleted.",
                "created_by": "user-ingest",
            },
        )
        source_id = resp.json()["source"]["id"]

        # Delete source
        del_resp = await app_client.delete(
            f"/internal/admin/shared/sources/{source_id}", headers=HEADERS
        )
        assert del_resp.status_code == 200

        # Verify source is gone
        get_resp = await app_client.get(
            f"/internal/admin/shared/sources/{source_id}", headers=HEADERS
        )
        assert get_resp.status_code == 404
