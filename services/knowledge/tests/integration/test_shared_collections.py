"""Integration tests for shared knowledge collections CRUD."""

import pytest

pytestmark = pytest.mark.integration

INTERNAL_TOKEN = "test-internal-token"
HEADERS = {"Authorization": f"Bearer {INTERNAL_TOKEN}"}


class TestCreateCollection:
    async def test_create_collection(self, app_client):
        resp = await app_client.post(
            "/internal/admin/shared/collections",
            headers=HEADERS,
            json={
                "name": "Test Collection",
                "description": "A test collection",
                "visibility": "private",
                "created_by": "user-alpha",
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "Test Collection"
        assert data["visibility"] == "private"
        assert data["created_by"] == "user-alpha"
        assert "id" in data

    async def test_create_duplicate_returns_409(self, app_client):
        body = {
            "name": "Unique Collection",
            "created_by": "user-alpha",
        }
        resp1 = await app_client.post(
            "/internal/admin/shared/collections", headers=HEADERS, json=body
        )
        assert resp1.status_code == 200

        resp2 = await app_client.post(
            "/internal/admin/shared/collections", headers=HEADERS, json=body
        )
        assert resp2.status_code == 409


class TestListCollections:
    async def test_list_collections_owner_scoped(self, app_client):
        # Create collections for different owners
        for owner in ["user-a", "user-b"]:
            await app_client.post(
                "/internal/admin/shared/collections",
                headers=HEADERS,
                json={"name": f"Col-{owner}", "created_by": owner, "visibility": "private"},
            )

        # Owner user-a should see only their own private collections
        resp = await app_client.get(
            "/internal/admin/shared/collections",
            headers=HEADERS,
            params={"owner": "user-a"},
        )
        assert resp.status_code == 200
        names = [c["name"] for c in resp.json()]
        assert "Col-user-a" in names
        assert "Col-user-b" not in names

    async def test_admin_sees_all(self, app_client):
        for owner in ["user-x", "user-y"]:
            await app_client.post(
                "/internal/admin/shared/collections",
                headers=HEADERS,
                json={"name": f"Admin-{owner}", "created_by": owner, "visibility": "private"},
            )

        # No owner filter = admin sees all
        resp = await app_client.get(
            "/internal/admin/shared/collections", headers=HEADERS
        )
        assert resp.status_code == 200
        names = [c["name"] for c in resp.json()]
        assert "Admin-user-x" in names
        assert "Admin-user-y" in names

    async def test_collection_visibility_scoping(self, app_client):
        # Create a shared collection from user-c
        await app_client.post(
            "/internal/admin/shared/collections",
            headers=HEADERS,
            json={"name": "Shared-Col", "created_by": "user-c", "visibility": "shared"},
        )

        # user-d should see user-c's shared collection
        resp = await app_client.get(
            "/internal/admin/shared/collections",
            headers=HEADERS,
            params={"owner": "user-d"},
        )
        assert resp.status_code == 200
        names = [c["name"] for c in resp.json()]
        assert "Shared-Col" in names


class TestUpdateCollection:
    async def test_update_collection(self, app_client):
        resp = await app_client.post(
            "/internal/admin/shared/collections",
            headers=HEADERS,
            json={"name": "Updatable", "created_by": "user-u"},
        )
        cid = resp.json()["id"]

        resp2 = await app_client.put(
            f"/internal/admin/shared/collections/{cid}",
            headers=HEADERS,
            json={"name": "Updated Name", "description": "New desc"},
        )
        assert resp2.status_code == 200
        assert resp2.json()["name"] == "Updated Name"
        assert resp2.json()["description"] == "New desc"


class TestDeleteCollection:
    async def test_delete_collection_cascades(self, app_client):
        # Create collection with a source
        resp = await app_client.post(
            "/internal/admin/shared/collections",
            headers=HEADERS,
            json={"name": "Deletable", "created_by": "user-del"},
        )
        cid = resp.json()["id"]

        # Add a source
        await app_client.post(
            "/internal/admin/shared/sources",
            headers=HEADERS,
            json={
                "collection_id": cid,
                "title": "Source in deletable",
                "source_type": "text",
                "raw_content": "Some content for deletion test.",
                "created_by": "user-del",
            },
        )

        # Delete collection — should cascade to sources
        resp_del = await app_client.delete(
            f"/internal/admin/shared/collections/{cid}", headers=HEADERS
        )
        assert resp_del.status_code == 200
        assert resp_del.json()["deleted"] is True

        # Verify collection is gone
        resp_get = await app_client.get(
            f"/internal/admin/shared/collections/{cid}", headers=HEADERS
        )
        assert resp_get.status_code == 404
