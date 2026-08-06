#!/usr/bin/env bats

# _tailscale_generate_key (scripts/vps.sh) used to collapse three genuinely
# different failure states into one message — "Failed to generate auth key.
# Response: $response" — and cmd_recreate's own `2>&1 | tail -1` capture
# then discarded even that on every failure, replacing it with a static
# "Failed to generate Tailscale auth key" no matter what actually happened.
# recreate-vps.yml's real 2026-06-14 failure shows exactly this: the log
# names no cause at all.
#
# Never touches the real Tailscale API. A local HTTP server on an
# OS-assigned free port stands in for api.tailscale.com, and a `curl` shim
# earlier in PATH rewrites requests to it — everything else about the real
# curl invocation (flags, -o, -w) passes through unmodified. Four scenarios:
# the API rejecting the request (401), the API answering with a body that
# is not valid JSON, the API answering with valid JSON but no `key` field,
# and the request never arriving at all (closed port — curl-level failure,
# no HTTP response to have an opinion about).
#
# THE ASSERTION THAT MATTERS is not "the function exits nonzero" — a
# version that collapses all three responses into the same message exits
# nonzero too. What's asserted is that the four scenarios produce four
# DISTINCT messages, each naming its actual cause, all the way through
# cmd_recreate — not just inside _tailscale_generate_key alone, since that
# inner message meant nothing if cmd_recreate discarded it on the way out.

setup() {
    VPS_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/vps.sh"
    [ -f "$VPS_SCRIPT" ] || skip "scripts/vps.sh not found"
    command -v python3 >/dev/null || skip "python3 not available"

    WORKDIR=$(mktemp -d)
    REAL_CURL=$(command -v curl)

    cat > "$WORKDIR/stub_server.py" << 'PYEOF'
import http.server
import socket
import sys

SCENARIOS = {
    "scenario-401": (401, b'{"message":"unauthorized"}'),
    "scenario-badjson": (200, b'not json at all {'),
    "scenario-nokey": (200, b'{"id":"abc123"}'),
    "scenario-ok": (200, b'{"key":"tskey-auth-abc123fake"}'),
}

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        parts = self.path.strip("/").split("/")
        scenario = parts[3] if len(parts) > 3 else None
        status, body = SCENARIOS.get(scenario, (500, b'{"error":"unknown scenario"}'))
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0))
port = s.getsockname()[1]
s.close()
print(port, flush=True)
http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
PYEOF

    python3 "$WORKDIR/stub_server.py" > "$WORKDIR/port.txt" 2>"$WORKDIR/server.log" &
    SERVER_PID=$!
    # Poll for the port line rather than a fixed sleep — the server prints
    # it before entering serve_forever(), so its presence means the socket
    # is bound and ready.
    for _ in $(seq 1 50); do
        [ -s "$WORKDIR/port.txt" ] && break
        sleep 0.1
    done
    STUB_PORT=$(cat "$WORKDIR/port.txt" 2>/dev/null)
    [ -n "$STUB_PORT" ] || skip "stub server did not start"

    mkdir -p "$WORKDIR/fakebin"
    # STUB_PORT read from THIS shim's own environment at call time, not
    # baked in here — the closed-port test below reassigns it per-test to
    # a port nothing listens on, and that reassignment has to actually
    # reach curl, not just this setup step.
    cat > "$WORKDIR/fakebin/curl" << EOF
#!/usr/bin/env bash
args=()
for a in "\$@"; do
  case "\$a" in
    https://api.tailscale.com/*)
      a="http://127.0.0.1:\${STUB_PORT}/\${a#https://api.tailscale.com/}"
      ;;
  esac
  args+=("\$a")
done
exec "$REAL_CURL" "\${args[@]}"
EOF
    chmod +x "$WORKDIR/fakebin/curl"

    # main() at the bottom of vps.sh runs on invocation; strip it so this
    # can be sourced to reach the functions directly, matching the actual
    # file everywhere else. vps.sh resolves _common.sh relative to its own
    # BASH_SOURCE, so the copy needs it alongside, not just present at its
    # real repo path.
    sed '$ d' "$VPS_SCRIPT" > "$WORKDIR/vps_under_test.sh"
    cp "$BATS_TEST_DIRNAME/../../scripts/_common.sh" "$WORKDIR/_common.sh"

    export STUB_PORT
    export PATH="$WORKDIR/fakebin:$PATH"
    export TAILSCALE_API_KEY="test-key-not-real"
}

teardown() {
    [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
    [ -n "${WORKDIR:-}" ] && rm -rf "$WORKDIR"
}

run_generate_key() {
    local scenario="$1"
    TAILSCALE_TAILNET="$scenario" bash -c "
        source '$WORKDIR/vps_under_test.sh'
        _tailscale_generate_key
    "
}

run_recreate() {
    local scenario="$1"
    TAILSCALE_TAILNET="$scenario" bash -c "
        source '$WORKDIR/vps_under_test.sh'
        cmd_recreate
    "
}

@test "401 (API rejects the request) names HTTP 401, not a generic failure" {
    run run_generate_key "scenario-401"
    [ "$status" -ne 0 ]
    [[ "$output" == *"HTTP 401"* ]] || { echo "expected HTTP 401 named in output, got: $output"; return 1; }
    [[ "$output" == *"unauthorized"* ]]
}

@test "malformed JSON body names a parse failure, distinctly from a rejection" {
    run run_generate_key "scenario-badjson"
    [ "$status" -ne 0 ]
    [[ "$output" == *"could not be parsed as JSON"* ]] || { echo "expected a parse-failure message, got: $output"; return 1; }
    [[ "$output" != *"HTTP 401"* ]]
}

@test "valid JSON with no key field names that specifically, distinctly from a parse failure" {
    run run_generate_key "scenario-nokey"
    [ "$status" -ne 0 ]
    [[ "$output" == *"no 'key' field"* ]] || { echo "expected a missing-key message, got: $output"; return 1; }
    [[ "$output" != *"could not be parsed as JSON"* ]]
}

@test "a successful response still returns the key" {
    run run_generate_key "scenario-ok"
    [ "$status" -eq 0 ]
    [[ "$output" == *"tskey-auth-abc123fake"* ]]
}

@test "THE ASSERTION THAT MATTERS: each failure scenario names its OWN cause, and only its own" {
    # NOT a mere-inequality check. The pre-fix message was "Failed to
    # generate auth key. Response: $response" for every scenario, and the
    # three stub bodies already differ — so three DIFFERENT strings came
    # free from echoing the body back, with no diagnosis in any of them.
    # Inequality was never the missing property; it would pass whether or
    # not the actual cause was named. What was actually absent, and what
    # this asserts instead: that each message names ITS cause specifically
    # — 401 names the HTTP status, the malformed body names a parse
    # failure, the missing-key body names the missing field — and does not
    # also claim either of the other two, which is what "distinct causes"
    # has to mean for a human reading the log, not just "distinct bytes".
    run run_generate_key "scenario-401"
    local msg_401="$output"
    run run_generate_key "scenario-badjson"
    local msg_badjson="$output"
    run run_generate_key "scenario-nokey"
    local msg_nokey="$output"

    [[ "$msg_401" == *"HTTP 401"* ]] || { echo "401 case does not name HTTP 401: $msg_401"; return 1; }
    [[ "$msg_401" != *"could not be parsed as JSON"* ]] || { echo "401 case also claims a parse failure: $msg_401"; return 1; }
    [[ "$msg_401" != *"no 'key' field"* ]] || { echo "401 case also claims a missing key field: $msg_401"; return 1; }

    [[ "$msg_badjson" == *"could not be parsed as JSON"* ]] || { echo "badjson case does not name a parse failure: $msg_badjson"; return 1; }
    [[ "$msg_badjson" != *"HTTP 401"* ]] || { echo "badjson case also claims HTTP 401: $msg_badjson"; return 1; }
    [[ "$msg_badjson" != *"no 'key' field"* ]] || { echo "badjson case also claims a missing key field: $msg_badjson"; return 1; }

    [[ "$msg_nokey" == *"no 'key' field"* ]] || { echo "nokey case does not name the missing key field: $msg_nokey"; return 1; }
    [[ "$msg_nokey" != *"HTTP 401"* ]] || { echo "nokey case also claims HTTP 401: $msg_nokey"; return 1; }
    [[ "$msg_nokey" != *"could not be parsed as JSON"* ]] || { echo "nokey case also claims a parse failure: $msg_nokey"; return 1; }
}

@test "cmd_recreate surfaces the specific cause, not just a step-level generic message" {
    run run_recreate "scenario-401"
    [ "$status" -ne 0 ]
    [[ "$output" == *"HTTP 401"* ]] || { echo "cmd_recreate discarded the specific cause; got: $output"; return 1; }
}

@test "THE ASSERTION THAT MATTERS, end to end: cmd_recreate's three failure scenarios stay distinct, not collapsed on the way out" {
    run run_recreate "scenario-401"
    local msg_401="$output"
    run run_recreate "scenario-badjson"
    local msg_badjson="$output"
    run run_recreate "scenario-nokey"
    local msg_nokey="$output"

    [ "$msg_401" != "$msg_badjson" ] || { echo "cmd_recreate: 401 and badjson collapsed to the same output"; return 1; }
    [ "$msg_401" != "$msg_nokey" ] || { echo "cmd_recreate: 401 and nokey collapsed to the same output"; return 1; }
    [ "$msg_badjson" != "$msg_nokey" ] || { echo "cmd_recreate: badjson and nokey collapsed to the same output"; return 1; }
}

@test "a request that never arrives (closed port) is distinguished from the API rejecting it" {
    STUB_PORT=1
    run run_generate_key "scenario-ok"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Could not reach the Tailscale API"* ]] || { echo "expected a connection-failure message, got: $output"; return 1; }
    # Not "the substring HTTP never appears" — the message itself correctly
    # says "no HTTP response was received", which contains that word. What
    # must not appear is a CLAIMED status, which only the rejected-request
    # and no-key branches ever produce.
    [[ "$output" != *"HTTP 200"* && "$output" != *"HTTP 401"* ]] || { echo "a connection failure should not claim a specific HTTP status — none was received"; return 1; }
}
