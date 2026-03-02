"""Integration tests for GET /internal/admin/shared/stats endpoint."""

from datetime import datetime, timedelta, timezone

import pytest

pytestmark = pytest.mark.integration

INTERNAL_TOKEN = "test-internal-token"
INTERNAL_HEADERS = {"Authorization": f"Bearer {INTERNAL_TOKEN}"}


def _collect_keys(obj):
    """Recursively collect all keys from a nested dict/list structure."""
    keys = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            keys.add(k)
            keys |= _collect_keys(v)
    elif isinstance(obj, list):
        for item in obj:
            keys |= _collect_keys(item)
    return keys


async def _create_collection(app_client, name, owner, visibility="shared"):
    """Helper to create a collection. Returns the collection ID."""
    resp = await app_client.post(
        "/internal/admin/shared/collections",
        headers=INTERNAL_HEADERS,
        json={"name": name, "created_by": owner, "visibility": visibility},
    )
    assert resp.status_code == 200, f"collection create failed: {resp.text}"
    return resp.json()["id"]


async def _ingest_source(app_client, collection_id, title, content, owner):
    """Helper to create a source via ingest. Returns response JSON."""
    resp = await app_client.post(
        "/internal/admin/shared/sources",
        headers=INTERNAL_HEADERS,
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


async def _admin_search(app_client, q, requester_id, requester_type="user"):
    """Helper for internal admin search. Returns response JSON."""
    resp = await app_client.get(
        "/internal/admin/shared/search",
        headers=INTERNAL_HEADERS,
        params={"q": q, "requester_id": requester_id, "requester_type": requester_type},
    )
    assert resp.status_code == 200, f"search failed: {resp.text}"
    return resp.json()


async def _agent_search(app_client, q, agent_token):
    """Helper for agent-facing search. Returns response JSON."""
    resp = await app_client.get(
        "/api/v1/shared/search",
        headers={"Authorization": f"Bearer {agent_token}"},
        params={"q": q},
    )
    assert resp.status_code == 200, f"agent search failed: {resp.text}"
    return resp.json()


class TestSharedStats:
    async def test_stats_requires_auth(self, app_client):
        """Request without token returns 401."""
        resp = await app_client.get("/internal/admin/shared/stats")
        assert resp.status_code == 401

    async def test_stats_empty_db(self, app_client):
        """Returns zeroes on empty DB."""
        resp = await app_client.get("/internal/admin/shared/stats", headers=INTERNAL_HEADERS)
        assert resp.status_code == 200
        data = resp.json()

        assert data["search"]["total"] == 0
        assert data["ingest"]["total_jobs"] == 0
        assert data["corpus"]["total_collections"] == 0
        assert data["corpus"]["total_sources"] == 0
        assert data["corpus"]["total_chunks"] == 0
        assert data["corpus"]["total_tokens"] == 0

    async def test_stats_search_counts(self, app_client):
        """Create content, search (with results + without results), verify search.total and zero_result_count."""
        cid = await _create_collection(app_client, "Stats Search Col", "user-stats")
        await _ingest_source(
            app_client, cid, "Stats Doc",
            "Kubernetes orchestration for containerized workloads.",
            "user-stats",
        )

        # Search with results
        await _admin_search(app_client, "Kubernetes", "user-stats")
        # Search without results
        await _admin_search(app_client, "xyznonexistent", "user-stats")

        resp = await app_client.get("/internal/admin/shared/stats", headers=INTERNAL_HEADERS)
        data = resp.json()

        assert data["search"]["total"] >= 2
        assert data["search"]["zero_result_count"] >= 1

    async def test_stats_zero_result_rate(self, app_client):
        """Verify search.zero_result_rate is computed correctly."""
        cid = await _create_collection(app_client, "ZRR Col", "user-zrr")
        await _ingest_source(
            app_client, cid, "ZRR Doc",
            "Terraform infrastructure as code provisioning.",
            "user-zrr",
        )

        # One search with results
        await _admin_search(app_client, "Terraform", "user-zrr")
        # One search without results
        await _admin_search(app_client, "xyznonexistent", "user-zrr")

        resp = await app_client.get("/internal/admin/shared/stats", headers=INTERNAL_HEADERS)
        data = resp.json()

        total = data["search"]["total"]
        zrc = data["search"]["zero_result_count"]
        expected_rate = round(zrc / total, 3) if total > 0 else 0.0
        assert data["search"]["zero_result_rate"] == expected_rate
        # At least one zero-result in this test
        assert data["search"]["zero_result_rate"] > 0

    async def test_stats_by_requester_type(self, app_client, agent_token):
        """Verify by_requester_type is a list with requester_type, total, zero_result_count, zero_result_rate."""
        cid = await _create_collection(app_client, "Req Type Col", "test-user-sub")
        await _ingest_source(
            app_client, cid, "Req Type Doc",
            "GraphQL schema design and query language.",
            "test-user-sub",
        )

        # User search
        await _admin_search(app_client, "GraphQL", "user-rt", requester_type="user")
        # Agent search
        await _agent_search(app_client, "GraphQL", agent_token)

        resp = await app_client.get("/internal/admin/shared/stats", headers=INTERNAL_HEADERS)
        data = resp.json()

        by_rt = data["search"]["by_requester_type"]
        assert isinstance(by_rt, list)
        assert len(by_rt) >= 2

        for entry in by_rt:
            assert "requester_type" in entry
            assert "total" in entry
            assert "zero_result_count" in entry
            assert "zero_result_rate" in entry

    async def test_stats_by_requester_type_zero_result_rate(self, app_client, agent_token):
        """Agent does zero-result search, user does successful search. Verify rates differ."""
        cid = await _create_collection(app_client, "RT ZRR Col", "test-user-sub")
        await _ingest_source(
            app_client, cid, "RT ZRR Doc",
            "Redis caching patterns and data structures.",
            "test-user-sub",
        )

        # Agent search with no results
        await _agent_search(app_client, "xyznonexistent", agent_token)
        # User search with results
        await _admin_search(app_client, "Redis", "user-rtzrr", requester_type="user")

        resp = await app_client.get("/internal/admin/shared/stats", headers=INTERNAL_HEADERS)
        data = resp.json()

        by_rt = {e["requester_type"]: e for e in data["search"]["by_requester_type"]}
        assert by_rt["agent"]["zero_result_rate"] > 0
        assert by_rt["user"]["zero_result_rate"] == 0

    async def test_stats_ingest_counts(self, app_client):
        """Create sources (some succeed, some fail), verify ingest counts."""
        cid = await _create_collection(app_client, "Ingest Count Col", "user-ic")

        # Successful ingest
        await _ingest_source(
            app_client, cid, "IC Doc 1",
            "PostgreSQL indexing strategies and query optimization.",
            "user-ic",
        )
        await _ingest_source(
            app_client, cid, "IC Doc 2",
            "Docker container networking and bridge drivers.",
            "user-ic",
        )

        # Trigger a failed ingest: web_page with missing source_url returns 422
        # which does not create a job. Instead, insert a failed job directly.
        async with app_client._transport.app.state.pool.acquire() as conn:  # type: ignore[union-attr]
            source_row = await conn.fetchrow(
                """INSERT INTO shared_sources
                   (collection_id, title, source_type, content_hash, created_by, status, error_message)
                   VALUES ($1, 'Fail Source', 'text', '', 'user-ic', 'error', 'simulated failure')
                   RETURNING id""",
                (await conn.fetchval(
                    "SELECT id FROM shared_collections WHERE name = 'Ingest Count Col'"
                )),
            )
            await conn.execute(
                """INSERT INTO shared_ingest_jobs (source_id, status, error_message)
                   VALUES ($1, 'failed', 'simulated failure')""",
                source_row["id"],
            )

        resp = await app_client.get("/internal/admin/shared/stats", headers=INTERNAL_HEADERS)
        data = resp.json()

        assert data["ingest"]["completed"] >= 2
        assert data["ingest"]["failed"] >= 1
        assert data["ingest"]["total_jobs"] >= 3

    async def test_stats_ingest_error_rate(self, app_client):
        """Verify ingest.error_rate = failed / total_jobs."""
        # Insert known jobs directly for deterministic test
        pool = app_client._transport.app.state.pool  # type: ignore[union-attr]
        cid = await _create_collection(app_client, "Error Rate Col", "user-er")

        async with pool.acquire() as conn:
            src_id = await conn.fetchval(
                """INSERT INTO shared_sources
                   (collection_id, title, source_type, content_hash, created_by, status)
                   VALUES ($1, 'ER Source', 'text', '', 'user-er', 'active')
                   RETURNING id""",
                (await conn.fetchval(
                    "SELECT id FROM shared_collections WHERE name = 'Error Rate Col'"
                )),
            )
            # 2 completed, 1 failed
            for _ in range(2):
                await conn.execute(
                    "INSERT INTO shared_ingest_jobs (source_id, status) VALUES ($1, 'completed')",
                    src_id,
                )
            await conn.execute(
                "INSERT INTO shared_ingest_jobs (source_id, status, error_message) VALUES ($1, 'failed', 'err')",
                src_id,
            )

        resp = await app_client.get("/internal/admin/shared/stats", headers=INTERNAL_HEADERS)
        data = resp.json()

        total_jobs = data["ingest"]["total_jobs"]
        failed = data["ingest"]["failed"]
        expected_rate = round(failed / total_jobs, 3) if total_jobs > 0 else 0.0
        assert data["ingest"]["error_rate"] == expected_rate

    async def test_stats_source_breakdown(self, app_client):
        """Verify sources.by_status and sources.by_type dicts."""
        cid = await _create_collection(app_client, "Src Breakdown Col", "user-sb")
        await _ingest_source(
            app_client, cid, "SB Text",
            "Content about microservice architecture.",
            "user-sb",
        )

        resp = await app_client.get("/internal/admin/shared/stats", headers=INTERNAL_HEADERS)
        data = resp.json()

        assert isinstance(data["sources"]["by_status"], dict)
        assert isinstance(data["sources"]["by_type"], dict)
        # At least one active source and one text source
        assert data["sources"]["by_status"].get("active", 0) >= 1
        assert data["sources"]["by_type"].get("text", 0) >= 1

    async def test_stats_corpus_totals(self, app_client):
        """Verify corpus.total_collections, total_sources, total_chunks, total_tokens."""
        cid = await _create_collection(app_client, "Corpus Col", "user-corpus")
        await _ingest_source(
            app_client, cid, "Corpus Doc",
            "Observability with OpenTelemetry traces metrics and logs.",
            "user-corpus",
        )

        resp = await app_client.get("/internal/admin/shared/stats", headers=INTERNAL_HEADERS)
        data = resp.json()

        assert data["corpus"]["total_collections"] >= 1
        assert data["corpus"]["total_sources"] >= 1
        assert data["corpus"]["total_chunks"] >= 1
        assert data["corpus"]["total_tokens"] >= 1

    async def test_stats_since_filter(self, app_client):
        """Create data, then query with a future timestamp; time-scoped counts should be 0."""
        cid = await _create_collection(app_client, "Since Col", "user-since")
        await _ingest_source(
            app_client, cid, "Since Doc",
            "Content about continuous integration pipelines.",
            "user-since",
        )
        await _admin_search(app_client, "continuous integration", "user-since")

        # Use a future timestamp
        future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        resp = await app_client.get(
            "/internal/admin/shared/stats",
            headers=INTERNAL_HEADERS,
            params={"since": future},
        )
        assert resp.status_code == 200
        data = resp.json()

        # Time-scoped search counts should be 0
        assert data["search"]["total"] == 0
        assert data["ingest"]["total_jobs"] == 0

    async def test_stats_duration_ms_recorded(self, app_client, db_pool):
        """Do a search, verify the shared_retrievals row has duration_ms IS NOT NULL."""
        cid = await _create_collection(app_client, "Duration Col", "user-dur")
        await _ingest_source(
            app_client, cid, "Duration Doc",
            "Prometheus monitoring and alerting rules.",
            "user-dur",
        )
        await _admin_search(app_client, "Prometheus", "user-dur")

        row = await db_pool.fetchrow(
            """SELECT duration_ms FROM shared_retrievals
               WHERE requester_id = 'user-dur'
               ORDER BY created_at DESC LIMIT 1"""
        )
        assert row is not None
        assert row["duration_ms"] is not None

    async def test_stats_avg_duration_ms(self, app_client):
        """Do searches, verify search.avg_duration_ms is not None."""
        cid = await _create_collection(app_client, "Avg Dur Col", "user-avgdur")
        await _ingest_source(
            app_client, cid, "Avg Dur Doc",
            "Grafana dashboard visualization and alerting.",
            "user-avgdur",
        )
        await _admin_search(app_client, "Grafana", "user-avgdur")
        await _admin_search(app_client, "dashboard", "user-avgdur")

        resp = await app_client.get("/internal/admin/shared/stats", headers=INTERNAL_HEADERS)
        data = resp.json()

        assert data["search"]["avg_duration_ms"] is not None

    async def test_stats_no_query_text_leak(self, app_client):
        """Stats response must not contain any key named 'query'."""
        cid = await _create_collection(app_client, "No Query Leak Col", "user-nql")
        await _ingest_source(
            app_client, cid, "NQL Doc",
            "Content about secret management and encryption.",
            "user-nql",
        )
        await _admin_search(app_client, "secret management", "user-nql")

        resp = await app_client.get("/internal/admin/shared/stats", headers=INTERNAL_HEADERS)
        assert resp.status_code == 200
        data = resp.json()

        all_keys = _collect_keys(data)
        assert "query" not in all_keys

    async def test_stats_no_requester_id_leak(self, app_client):
        """Stats response must not contain 'requester_id' or 'requester_name' keys."""
        cid = await _create_collection(app_client, "No ID Leak Col", "user-nil")
        await _ingest_source(
            app_client, cid, "NIL Doc",
            "Content about identity federation and SSO.",
            "user-nil",
        )
        await _admin_search(app_client, "identity federation", "user-nil")

        resp = await app_client.get("/internal/admin/shared/stats", headers=INTERNAL_HEADERS)
        assert resp.status_code == 200
        data = resp.json()

        all_keys = _collect_keys(data)
        assert "requester_id" not in all_keys
        assert "requester_name" not in all_keys
