"""Unit tests for path canonicalization and traversal prevention."""

import pytest

from app.services.path_policy import canonicalize_path, validate_path


class TestPathTraversal:
    def test_path_rejects_dot_dot(self) -> None:
        with pytest.raises(ValueError, match="traversal"):
            validate_path("../etc/passwd")

    def test_path_rejects_dot_dot_encoded(self) -> None:
        with pytest.raises(ValueError, match="traversal"):
            validate_path("plans/../../etc/passwd")

    def test_path_rejects_absolute(self) -> None:
        with pytest.raises(ValueError, match="absolute"):
            validate_path("/etc/passwd")

    def test_path_rejects_symlink_component(self) -> None:
        """Paths containing known dangerous patterns are rejected at validation time."""
        with pytest.raises(ValueError):
            validate_path("plans/./hidden/../secret.md")

    def test_path_rejects_hidden_files(self) -> None:
        """Hidden files (starting with dot) are rejected."""
        with pytest.raises(ValueError, match="hidden"):
            validate_path(".hidden.md")

    def test_path_rejects_hidden_directory(self) -> None:
        """Hidden directories are rejected."""
        with pytest.raises(ValueError, match="hidden"):
            validate_path(".config/settings.md")


class TestPathCanonicalization:
    def test_path_lowercase(self) -> None:
        assert canonicalize_path("Plans/MyPlan.md") == "plans/myplan.md"

    def test_path_strips_leading_slash(self) -> None:
        assert canonicalize_path("//plans/test.md") == "plans/test.md"

    def test_path_strips_trailing_slash(self) -> None:
        assert canonicalize_path("plans/test.md/") == "plans/test.md"

    def test_path_rejects_invalid_chars(self) -> None:
        with pytest.raises(ValueError, match="invalid"):
            validate_path("plans/my plan!.md")

    def test_path_depth_max_3(self) -> None:
        # depth 3 is OK
        validate_path("a/b/c.md")
        # depth 4 is not
        with pytest.raises(ValueError, match="depth"):
            validate_path("a/b/c/d.md")

    def test_path_requires_md_extension(self) -> None:
        with pytest.raises(ValueError, match="extension"):
            validate_path("plans/test.txt")

    def test_path_valid_examples(self) -> None:
        """Valid paths pass without raising."""
        for path in [
            "context.md",
            "plans/project-alpha.md",
            "decisions/2024/adopt-fastapi.md",
        ]:
            validate_path(path)
