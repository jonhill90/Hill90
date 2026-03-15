"""Tests for router model resolution and route selection."""

from unittest.mock import AsyncMock

import pytest

from app.models import (
    RouterModelInfo,
    UserModelInfo,
    get_fallback_route,
    resolve_route_credentials,
    resolve_router_model,
    select_route,
)


@pytest.fixture
def mock_conn():
    return AsyncMock()


def make_router(strategy="fallback", default_route="primary", routes=None):
    if routes is None:
        routes = [
            {"key": "primary", "connection_id": "conn-1", "litellm_model": "openai/gpt-4o", "priority": 1},
            {"key": "secondary", "connection_id": "conn-2", "litellm_model": "anthropic/claude-sonnet-4-20250514", "priority": 2, "task_types": ["code_review"]},
        ]
    return RouterModelInfo(strategy=strategy, default_route=default_route, routes=routes)


class TestResolveRouterModel:
    """C1-C3: Router model lookup."""

    @pytest.mark.asyncio
    async def test_c1_finds_active_router(self, mock_conn):
        mock_conn.fetchrow.return_value = {
            "routing_config": {
                "strategy": "fallback",
                "default_route": "primary",
                "routes": [
                    {"key": "primary", "connection_id": "conn-1", "litellm_model": "openai/gpt-4o", "priority": 1},
                ],
            }
        }

        result = await resolve_router_model(mock_conn, "my-router", "user-a")

        assert result is not None
        assert result.strategy == "fallback"
        assert result.default_route == "primary"
        assert len(result.routes) == 1

    @pytest.mark.asyncio
    async def test_c2_returns_none_for_single(self, mock_conn):
        mock_conn.fetchrow.return_value = None

        result = await resolve_router_model(mock_conn, "single-model", "user-a")

        assert result is None
        sql = mock_conn.fetchrow.call_args[0][0]
        assert "model_type = 'router'" in sql

    @pytest.mark.asyncio
    async def test_c3_returns_none_for_inactive(self, mock_conn):
        mock_conn.fetchrow.return_value = None

        result = await resolve_router_model(mock_conn, "inactive-router", "user-a")

        assert result is None
        sql = mock_conn.fetchrow.call_args[0][0]
        assert "is_active = true" in sql


class TestSelectRoute:
    """C4-C6: Route selection logic."""

    def test_c4_fallback_strategy_returns_default(self):
        router = make_router(strategy="fallback")
        route = select_route(router, None)

        assert route is not None
        assert route["key"] == "primary"

    def test_c5_task_routing_matching_type(self):
        router = make_router(strategy="task_routing")
        route = select_route(router, "code_review")

        assert route is not None
        assert route["key"] == "secondary"

    def test_c6_task_routing_no_match_falls_back_to_default(self):
        router = make_router(strategy="task_routing")
        route = select_route(router, "unknown_task")

        assert route is not None
        assert route["key"] == "primary"


class TestResolveRouteCredentials:
    """C7-C9: Owner-scoped route credential resolution."""

    @pytest.mark.asyncio
    async def test_c7_valid_owner(self, mock_conn):
        mock_conn.fetchrow.return_value = {
            "api_key_encrypted": b"encrypted-key",
            "api_key_nonce": b"nonce",
            "api_base_url": None,
        }

        route = {"connection_id": "conn-1", "litellm_model": "openai/gpt-4o"}
        result = await resolve_route_credentials(mock_conn, route, "user-a")

        assert result is not None
        assert result.litellm_model == "openai/gpt-4o"
        assert result.api_key_encrypted == b"encrypted-key"
        sql = mock_conn.fetchrow.call_args[0][0]
        assert "created_by = $2" in sql

    @pytest.mark.asyncio
    async def test_c8_cross_owner_returns_none(self, mock_conn):
        """Cross-owner connection_id returns None — defense-in-depth."""
        mock_conn.fetchrow.return_value = None

        route = {"connection_id": "other-users-conn", "litellm_model": "openai/gpt-4o"}
        result = await resolve_route_credentials(mock_conn, route, "user-a")

        assert result is None

    @pytest.mark.asyncio
    async def test_c9_malformed_config_returns_none(self, mock_conn):
        """Malformed routing config (missing fields) returns None."""
        route = {"litellm_model": "openai/gpt-4o"}  # missing connection_id
        result = await resolve_route_credentials(mock_conn, route, "user-a")

        assert result is None
        mock_conn.fetchrow.assert_not_called()


class TestFallbackRoute:
    """C11-C12: Fallback retry logic."""

    def test_c11_get_fallback_after_primary_failure(self):
        router = make_router(strategy="fallback")
        fallback = get_fallback_route(router, "primary")

        assert fallback is not None
        assert fallback["key"] == "secondary"

    def test_c12_no_second_fallback(self):
        router = make_router(strategy="fallback")
        fallback = get_fallback_route(router, "secondary")

        assert fallback is None

    def test_fallback_not_available_for_task_routing(self):
        router = make_router(strategy="task_routing")
        fallback = get_fallback_route(router, "primary")

        assert fallback is None
