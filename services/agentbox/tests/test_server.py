"""Tests for app.server — server composition verification.

Source inspection tests verifying Starlette patterns in server.py.
These complement the functional tests in test_server_functional.py.
"""

from pathlib import Path


SERVER_PATH = Path(__file__).parent.parent / "app" / "server.py"


class TestServerComposition:
    def test_server_file_exists(self):
        """S1: Server file exists."""
        assert SERVER_PATH.exists()

    def test_health_route_registered(self):
        """S2: /health route registered as Starlette Route."""
        source = SERVER_PATH.read_text()
        assert 'Route("/health"' in source

    def test_work_route_registered(self):
        """S3: /work route registered as Starlette Route."""
        source = SERVER_PATH.read_text()
        assert 'Route("/work"' in source

    def test_runtime_imported(self):
        """S4: AgentRuntime imported and instantiated."""
        source = SERVER_PATH.read_text()
        assert "from app.runtime import AgentRuntime" in source
        assert "AgentRuntime(" in source

    def test_no_fastmcp_in_server(self):
        """S5: No FastMCP import in server.py."""
        source = SERVER_PATH.read_text()
        assert "fastmcp" not in source.lower()

    def test_no_tools_import_in_server(self):
        """S6: No tools/ import in server.py."""
        source = SERVER_PATH.read_text()
        assert "from tools" not in source
        assert "import tools" not in source

    def test_uvicorn_run_used(self):
        """S7: uvicorn.run used for serving."""
        source = SERVER_PATH.read_text()
        assert "uvicorn.run(" in source

    def test_starlette_app_constructed(self):
        """S8: Starlette app constructed."""
        source = SERVER_PATH.read_text()
        assert "Starlette(" in source
