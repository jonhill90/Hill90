"""Keycloak event-logging contract tests.

Login event storage exists to answer one question from the host: "did this user
log in, and when". Before 2026-07-31 nothing could, because `events_enabled` was
false on both realms and `event_entity` was therefore empty — and an empty
`event_entity` is not evidence that nobody logged in. See
docs/runbooks/keycloak-login-events.md.

The assertions that matter here are the ones with a blast radius:

  * admin event DETAILS must stay off. That column stores the full JSON
    representation of a changed resource, and a client representation carries
    its `secret`, so turning it on writes client secrets in plaintext into the
    platform Postgres and from there into every database backup.
  * retention must be finite. These tables live in the database every other
    platform service depends on.
  * the event type list must stay explicit. Keycloak's default is roughly ninety
    types including a row per token refresh.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
KEYCLOAK_SH = ROOT / "scripts" / "keycloak.sh"
REALM_JSON = ROOT / "platform" / "auth" / "keycloak" / "platform-realm.json"

THIRTY_DAYS = 30 * 24 * 3600


@pytest.fixture(scope="module")
def realm() -> dict:
    return json.loads(REALM_JSON.read_text())


@pytest.fixture(scope="module")
def script() -> str:
    return KEYCLOAK_SH.read_text()


# --- the realm import, used when a realm is created from nothing -------------

def test_realm_import_enables_events(realm):
    assert realm["eventsEnabled"] is True


def test_realm_import_sets_finite_retention(realm):
    assert realm["eventsExpiration"] == THIRTY_DAYS


def test_realm_import_lists_event_types_explicitly(realm):
    types = realm["enabledEventTypes"]
    assert "LOGIN" in types, "LOGIN is the whole point"
    assert "LOGIN_ERROR" in types, "a failed attempt is half the question"
    # Keycloak's default is ~90 types, one row per token refresh included.
    assert len(types) <= 10, f"event type list has grown to {len(types)}; is it still deliberate?"


def test_realm_import_keeps_admin_event_details_off(realm):
    # admin_event_entity.representation would hold client secrets in plaintext.
    assert realm["adminEventsDetailsEnabled"] is False


# --- keycloak.sh apply, which reconciles an EXISTING realm -------------------
#
# The realm import runs on first boot only (IGNORE_EXISTING), so for a realm
# that already exists the script is the only thing that applies this.

def test_script_has_the_reconciler():
    assert "ensure_event_logging()" in KEYCLOAK_SH.read_text()


def test_script_applies_to_both_realms(script):
    body = re.search(r"^cmd_apply\(\).*?^}", script, re.S | re.M)
    assert body, "cmd_apply not found"
    calls = re.findall(r"ensure_event_logging\s+(\S+)", body.group(0))
    assert any(c == "master" for c in calls), "master realm is not configured"
    assert any("KC_REALM" in c for c in calls), "the tenant realm is not configured"


def test_script_never_enables_admin_event_details(script):
    # The only occurrence should be the hardcoded False in the payload.
    assert not re.search(r'"adminEventsDetailsEnabled"\s*:\s*True', script)
    assert re.search(r'"adminEventsDetailsEnabled"\s*:\s*False', script)


def test_script_default_retention_is_finite(script):
    m = re.search(r'KC_EVENTS_EXPIRATION="\$\{KC_EVENTS_EXPIRATION:-(\d+)\}"', script)
    assert m, "KC_EVENTS_EXPIRATION default not found"
    seconds = int(m.group(1))
    assert 0 < seconds <= 90 * 24 * 3600, f"retention {seconds}s is not a bounded, sane window"


def test_script_feeds_the_payload_over_stdin_with_dash_i(script):
    """kc() has no -i, so a payload piped into `-f -` would never reach kcadm.

    This is not hypothetical: the first version of ensure_event_logging used
    kc() and would have silently sent nothing.
    """
    body = re.search(r"^ensure_event_logging\(\).*?^}", script, re.S | re.M)
    assert body, "ensure_event_logging not found"
    update = [ln for ln in body.group(0).splitlines() if "events/config" in ln and "update" in ln]
    assert update, "no update call for events/config"
    assert any("docker exec -i" in ln for ln in body.group(0).splitlines()), \
        "the events/config update must use `docker exec -i`, not the kc() helper"


def test_the_function_survives_naive_extraction(script):
    """`sed -n '/^ensure_event_logging()/,/^}/p' | bash -n` must parse.

    The repo's own tests extract shell functions with that idiom. A line
    beginning with `}` in column 0 inside the function — an unindented closing
    brace in an embedded python heredoc, for instance — truncates the extract
    and the test fails for a reason that has nothing to do with the code.
    """
    body = re.search(r"^ensure_event_logging\(\).*?^}", script, re.S | re.M)
    assert body
    inner = body.group(0).splitlines()[1:-1]
    offenders = [ln for ln in inner if ln.startswith("}")]
    assert not offenders, f"line(s) starting with '}}' truncate extraction: {offenders}"
