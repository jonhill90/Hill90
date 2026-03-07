"""Tests for app.server — server composition verification.

Since app.server has module-level code that requires a valid agent.yml,
these tests verify server composition via source inspection rather than
import. The runtime module itself is tested in test_runtime.py.
"""

from pathlib import Path


SERVER_PATH = Path(__file__).parent.parent / "app" / "server.py"


class TestServerComposition:
    def test_server_file_exists(self):
        assert SERVER_PATH.exists()

    def test_health_endpoint_registered(self):
        """The /health endpoint should be registered."""
        source = SERVER_PATH.read_text()
        assert '@mcp.custom_route("/health"' in source

    def test_work_endpoint_registered(self):
        """The /work endpoint should be registered."""
        source = SERVER_PATH.read_text()
        assert '@mcp.custom_route("/work"' in source

    def test_runtime_imported(self):
        """AgentRuntime should be imported and instantiated."""
        source = SERVER_PATH.read_text()
        assert "from app.runtime import AgentRuntime" in source
        assert "runtime = AgentRuntime(" in source

    def test_identity_tool_not_mounted(self):
        """Identity MCP tool should not be imported or mounted."""
        source = SERVER_PATH.read_text()
        assert "from tools import identity" not in source
        assert "identity.configure" not in source

    def test_health_tool_not_mounted(self):
        """Health MCP tool should not be imported or mounted."""
        source = SERVER_PATH.read_text()
        assert "from tools import health" not in source
        assert "health.configure" not in source

    def test_shell_tool_still_available(self):
        """Shell MCP tool should still be conditionally mounted."""
        source = SERVER_PATH.read_text()
        assert "from tools import shell" in source

    def test_filesystem_tool_still_available(self):
        """Filesystem MCP tool should still be conditionally mounted."""
        source = SERVER_PATH.read_text()
        assert "from tools import filesystem" in source

    def test_work_token_read_from_env(self):
        """WORK_TOKEN should be read from environment."""
        source = SERVER_PATH.read_text()
        assert 'os.environ.get("WORK_TOKEN")' in source
