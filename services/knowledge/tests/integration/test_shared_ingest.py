"""Integration tests for shared knowledge ingestion."""

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


class TestIngestRejectsWebPage:
    async def test_ingest_rejects_web_page(self, app_client):
        cid = await _create_collection(app_client, "Web Page Col")
        resp = await app_client.post(
            "/internal/admin/shared/sources",
            headers=HEADERS,
            json={
                "collection_id": cid,
                "title": "Web Page Test",
                "source_type": "web_page",
                "source_url": "https://example.com",
                "raw_content": "",
                "created_by": "user-ingest",
            },
        )
        assert resp.status_code == 422
        assert "not yet supported" in resp.json()["detail"].lower()


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
