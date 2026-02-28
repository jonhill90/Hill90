"""Tests for delegation management and subagent narrowing."""

import json
import time
import uuid

import pytest

from app.auth import AuthError, verify_model_router_token
from app.delegation import (
    Delegation,
    compute_effective_policy,
    validate_narrowing,
)
from app.policy import AgentPolicy, resolve_alias, resolve_aliases_list


# ---- validate_narrowing tests ----

class TestValidateNarrowing:
    """Validate that delegation constraints are a strict subset of parent policy."""

    def _parent_policy(self, **kwargs):
        defaults = dict(
            allowed_models=["gpt-4o-mini", "gpt-4o", "text-embedding-3-small"],
            max_requests_per_minute=30,
            max_tokens_per_day=100000,
            model_aliases=None,
        )
        defaults.update(kwargs)
        return AgentPolicy(**defaults)

    def test_valid_narrowing(self):
        """Subset models and lower limits pass validation."""
        violations = validate_narrowing(
            self._parent_policy(),
            allowed_models=["gpt-4o-mini"],
            max_rpm=5,
            max_tpd=10000,
        )
        assert violations == []

    def test_rejects_model_not_in_parent(self):
        """Model not in parent's allowlist is rejected."""
        violations = validate_narrowing(
            self._parent_policy(),
            allowed_models=["gpt-4o-mini", "claude-sonnet-4-20250514"],
            max_rpm=5,
            max_tpd=10000,
        )
        assert len(violations) == 1
        assert "claude-sonnet-4-20250514" in violations[0]

    def test_rejects_higher_rpm(self):
        """RPM exceeding parent's limit is rejected."""
        violations = validate_narrowing(
            self._parent_policy(),
            allowed_models=["gpt-4o-mini"],
            max_rpm=50,
            max_tpd=10000,
        )
        assert len(violations) == 1
        assert "max_requests_per_minute" in violations[0]

    def test_rejects_higher_tpd(self):
        """TPD exceeding parent's limit is rejected."""
        violations = validate_narrowing(
            self._parent_policy(),
            allowed_models=["gpt-4o-mini"],
            max_rpm=5,
            max_tpd=500000,
        )
        assert len(violations) == 1
        assert "max_tokens_per_day" in violations[0]

    def test_multiple_violations(self):
        """Multiple violations are reported."""
        violations = validate_narrowing(
            self._parent_policy(),
            allowed_models=["claude-sonnet-4-20250514"],
            max_rpm=50,
            max_tpd=500000,
        )
        assert len(violations) == 3

    def test_none_limits_accepted_when_parent_has_none(self):
        """Delegation with None limits is accepted when parent has None."""
        policy = self._parent_policy(max_requests_per_minute=None, max_tokens_per_day=None)
        violations = validate_narrowing(
            policy,
            allowed_models=["gpt-4o-mini"],
            max_rpm=None,
            max_tpd=None,
        )
        assert violations == []

    def test_child_limits_accepted_when_parent_unlimited(self):
        """Child can set limits even when parent has no limits."""
        policy = self._parent_policy(max_requests_per_minute=None, max_tokens_per_day=None)
        violations = validate_narrowing(
            policy,
            allowed_models=["gpt-4o-mini"],
            max_rpm=10,
            max_tpd=50000,
        )
        assert violations == []


# ---- compute_effective_policy tests ----

class TestComputeEffectivePolicy:
    """Compute intersection of parent policy and delegation."""

    def _parent_policy(self, **kwargs):
        defaults = dict(
            allowed_models=["gpt-4o-mini", "gpt-4o", "text-embedding-3-small"],
            max_requests_per_minute=30,
            max_tokens_per_day=100000,
            model_aliases=None,
        )
        defaults.update(kwargs)
        return AgentPolicy(**defaults)

    def _delegation(self, **kwargs):
        defaults = dict(
            id=str(uuid.uuid4()),
            parent_agent_id="orchestrator",
            parent_jti="parent-jti-abc",
            child_jti="child-jti-xyz",
            child_label="researcher",
            allowed_models=["gpt-4o-mini"],
            max_requests_per_minute=5,
            max_tokens_per_day=10000,
            expires_at=int(time.time()) + 3600,
            revoked_at=None,
            created_at="2025-01-01T00:00:00",
        )
        defaults.update(kwargs)
        return Delegation(**defaults)

    def test_model_intersection(self):
        """Effective models are intersection of parent and delegation."""
        effective = compute_effective_policy(
            self._parent_policy(),
            self._delegation(allowed_models=["gpt-4o-mini"]),
        )
        assert effective.allowed_models == ["gpt-4o-mini"]

    def test_model_removed_from_parent(self):
        """If parent policy no longer includes a model, effective is empty."""
        effective = compute_effective_policy(
            self._parent_policy(allowed_models=["gpt-4o"]),
            self._delegation(allowed_models=["gpt-4o-mini"]),
        )
        assert effective.allowed_models == []

    def test_rpm_minimum(self):
        """Effective RPM is minimum of parent and delegation."""
        effective = compute_effective_policy(
            self._parent_policy(max_requests_per_minute=30),
            self._delegation(max_requests_per_minute=5),
        )
        assert effective.max_requests_per_minute == 5

    def test_tpd_minimum(self):
        """Effective TPD is minimum of parent and delegation."""
        effective = compute_effective_policy(
            self._parent_policy(max_tokens_per_day=100000),
            self._delegation(max_tokens_per_day=10000),
        )
        assert effective.max_tokens_per_day == 10000

    def test_parent_none_defers_to_delegation(self):
        """When parent has no limit, delegation limit applies."""
        effective = compute_effective_policy(
            self._parent_policy(max_requests_per_minute=None),
            self._delegation(max_requests_per_minute=5),
        )
        assert effective.max_requests_per_minute == 5

    def test_delegation_none_defers_to_parent(self):
        """When delegation has no limit, parent limit applies."""
        effective = compute_effective_policy(
            self._parent_policy(max_requests_per_minute=30),
            self._delegation(max_requests_per_minute=None),
        )
        assert effective.max_requests_per_minute == 30

    def test_both_none_stays_none(self):
        """When both have no limit, effective is None (unlimited)."""
        effective = compute_effective_policy(
            self._parent_policy(max_requests_per_minute=None),
            self._delegation(max_requests_per_minute=None),
        )
        assert effective.max_requests_per_minute is None

    def test_delegation_id_set(self):
        """Effective policy carries delegation ID."""
        deleg = self._delegation()
        effective = compute_effective_policy(self._parent_policy(), deleg)
        assert effective.delegation_id == deleg.id


# ---- Auth with delegation claims ----

class TestDelegationAuth:
    """Auth verification for delegation (child) tokens."""

    def test_child_token_with_delegation_claims(self, ed25519_keypair, make_jwt):
        """Child token with delegation_id and parent_jti is accepted."""
        import jwt as pyjwt
        private_pem, public_pem = ed25519_keypair
        now = int(time.time())
        payload = {
            "sub": "orchestrator",
            "aud": "hill90-model-router",
            "iss": "hill90-api",
            "exp": now + 3600,
            "iat": now,
            "jti": "child-jti-xyz",
            "delegation_id": "deleg-uuid-123",
            "parent_jti": "parent-jti-abc",
        }
        token = pyjwt.encode(payload, private_pem, algorithm="EdDSA")

        claims = verify_model_router_token(token, public_pem)
        assert claims.delegation_id == "deleg-uuid-123"
        assert claims.parent_jti == "parent-jti-abc"
        assert claims.is_delegation is True

    def test_parent_token_has_no_delegation(self, ed25519_keypair, make_jwt):
        """Parent token has delegation_id=None and is_delegation=False."""
        _, public_pem = ed25519_keypair
        token = make_jwt()
        claims = verify_model_router_token(token, public_pem)
        assert claims.delegation_id is None
        assert claims.parent_jti is None
        assert claims.is_delegation is False

    def test_child_token_rejected_when_parent_jti_revoked(self, ed25519_keypair):
        """Child token is rejected when parent JTI is in revoked set."""
        import jwt as pyjwt
        private_pem, public_pem = ed25519_keypair
        now = int(time.time())
        payload = {
            "sub": "orchestrator",
            "aud": "hill90-model-router",
            "iss": "hill90-api",
            "exp": now + 3600,
            "iat": now,
            "jti": "child-jti-xyz",
            "delegation_id": "deleg-uuid-123",
            "parent_jti": "parent-jti-abc",
        }
        token = pyjwt.encode(payload, private_pem, algorithm="EdDSA")

        revoked = {"parent-jti-abc"}
        with pytest.raises(AuthError, match="parent token revoked"):
            verify_model_router_token(token, public_pem, revoked_jtis=revoked)

    def test_child_token_ok_when_parent_jti_not_revoked(self, ed25519_keypair):
        """Child token passes when parent JTI is not in revoked set."""
        import jwt as pyjwt
        private_pem, public_pem = ed25519_keypair
        now = int(time.time())
        payload = {
            "sub": "orchestrator",
            "aud": "hill90-model-router",
            "iss": "hill90-api",
            "exp": now + 3600,
            "iat": now,
            "jti": "child-jti-xyz",
            "delegation_id": "deleg-uuid-123",
            "parent_jti": "parent-jti-abc",
        }
        token = pyjwt.encode(payload, private_pem, algorithm="EdDSA")

        revoked = {"some-other-jti"}
        claims = verify_model_router_token(token, public_pem, revoked_jtis=revoked)
        assert claims.jti == "child-jti-xyz"

    def test_child_token_rejected_when_own_jti_revoked(self, ed25519_keypair):
        """Child token is rejected when its own JTI is revoked."""
        import jwt as pyjwt
        private_pem, public_pem = ed25519_keypair
        now = int(time.time())
        payload = {
            "sub": "orchestrator",
            "aud": "hill90-model-router",
            "iss": "hill90-api",
            "exp": now + 3600,
            "iat": now,
            "jti": "child-jti-xyz",
            "delegation_id": "deleg-uuid-123",
            "parent_jti": "parent-jti-abc",
        }
        token = pyjwt.encode(payload, private_pem, algorithm="EdDSA")

        revoked = {"child-jti-xyz"}
        with pytest.raises(AuthError, match="token revoked"):
            verify_model_router_token(token, public_pem, revoked_jtis=revoked)


# ---- Model alias resolution ----

class TestAliasResolution:
    """Model alias resolution from policy."""

    def _policy(self, aliases=None, **kwargs):
        defaults = dict(
            allowed_models=["gpt-4o-mini", "gpt-4o", "text-embedding-3-small"],
            max_requests_per_minute=30,
            max_tokens_per_day=100000,
            model_aliases=aliases,
        )
        defaults.update(kwargs)
        return AgentPolicy(**defaults)

    def test_alias_resolves_to_real_model(self):
        """Known alias resolves to target model."""
        policy = self._policy(aliases={"fast": "gpt-4o-mini", "smart": "gpt-4o"})
        assert resolve_alias("fast", policy) == "gpt-4o-mini"
        assert resolve_alias("smart", policy) == "gpt-4o"

    def test_unknown_name_passthrough(self):
        """Unknown name is returned unchanged."""
        policy = self._policy(aliases={"fast": "gpt-4o-mini"})
        assert resolve_alias("gpt-4o-mini", policy) == "gpt-4o-mini"
        assert resolve_alias("turbo", policy) == "turbo"

    def test_no_recursive_resolution(self):
        """Alias value is NOT resolved again (no recursion)."""
        policy = self._policy(aliases={"fast": "smart", "smart": "gpt-4o"})
        # "fast" → "smart" (literal, NOT resolved to "gpt-4o")
        assert resolve_alias("fast", policy) == "smart"

    def test_none_aliases_passthrough(self):
        """When model_aliases is None, all names pass through."""
        policy = self._policy(aliases=None)
        assert resolve_alias("fast", policy) == "fast"

    def test_empty_aliases_passthrough(self):
        """When model_aliases is empty dict, all names pass through."""
        policy = self._policy(aliases={})
        assert resolve_alias("fast", policy) == "fast"

    def test_resolve_aliases_list(self):
        """Batch resolution of a list of names."""
        policy = self._policy(aliases={"fast": "gpt-4o-mini", "embed": "text-embedding-3-small"})
        result = resolve_aliases_list(["fast", "gpt-4o", "embed"], policy)
        assert result == ["gpt-4o-mini", "gpt-4o", "text-embedding-3-small"]


# ---- Usage logging with delegation_id ----

class TestUsageWithDelegation:
    """Usage logging includes delegation_id."""

    @pytest.mark.asyncio
    async def test_usage_logged_with_delegation_id(self, mock_db_pool):
        """Delegation request includes delegation_id in usage record."""
        pool, conn = mock_db_pool
        conn.execute.return_value = None

        from app.usage import log_usage
        await log_usage(
            conn=conn,
            agent_id="orchestrator",
            model_name="gpt-4o-mini",
            request_type="chat.completion",
            status="success",
            latency_ms=150,
            delegation_id="deleg-uuid-123",
        )

        conn.execute.assert_called_once()
        call_args = conn.execute.call_args
        sql = call_args[0][0]
        assert "delegation_id" in sql
        params = call_args[0][1:]
        assert params[8] == "deleg-uuid-123"  # 9th param (index 8)

    @pytest.mark.asyncio
    async def test_usage_logged_without_delegation_id(self, mock_db_pool):
        """Parent request has delegation_id=None in usage record."""
        pool, conn = mock_db_pool
        conn.execute.return_value = None

        from app.usage import log_usage
        await log_usage(
            conn=conn,
            agent_id="orchestrator",
            model_name="gpt-4o-mini",
            request_type="chat.completion",
            status="success",
            latency_ms=150,
        )

        call_args = conn.execute.call_args
        params = call_args[0][1:]
        assert params[8] is None  # delegation_id defaults to None
