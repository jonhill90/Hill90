"""Tests verifying FastMCP has been fully removed from agentbox.

These tests serve as CI drift gates — they prevent FastMCP from being
reintroduced to the codebase.
"""

import ast
from pathlib import Path


AGENTBOX_ROOT = Path(__file__).parent.parent
APP_DIR = AGENTBOX_ROOT / "app"
SERVER_PATH = APP_DIR / "server.py"
TOOLS_DIR = AGENTBOX_ROOT / "tools"
PYPROJECT_PATH = AGENTBOX_ROOT / "pyproject.toml"


class TestFastMCPElimination:
    def test_no_fastmcp_in_app_modules(self):
        """F1: No fastmcp import in any app/ module."""
        for py_file in APP_DIR.glob("*.py"):
            tree = ast.parse(py_file.read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        assert "fastmcp" not in alias.name, (
                            f"fastmcp import found in {py_file.name}: {alias.name}"
                        )
                elif isinstance(node, ast.ImportFrom):
                    if node.module and "fastmcp" in node.module:
                        raise AssertionError(
                            f"fastmcp import found in {py_file.name}: from {node.module}"
                        )

    def test_no_fastmcp_in_server_source(self):
        """F2: No fastmcp import in server.py."""
        source = SERVER_PATH.read_text()
        assert "fastmcp" not in source.lower(), "fastmcp reference found in server.py"

    def test_tools_directory_removed(self):
        """F3: tools/ directory does not exist."""
        assert not TOOLS_DIR.exists(), f"tools/ directory still exists at {TOOLS_DIR}"

    def test_fastmcp_not_in_pyproject(self):
        """F4: fastmcp not in pyproject.toml."""
        content = PYPROJECT_PATH.read_text()
        assert "fastmcp" not in content.lower(), "fastmcp found in pyproject.toml"
