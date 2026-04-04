"""Unit tests for YAML frontmatter parsing."""

import pytest

from app.services.frontmatter import parse_frontmatter, FrontmatterError


class TestFrontmatterParsing:
    def test_parse_valid_frontmatter(self) -> None:
        content = """---
title: My Plan
type: plan
tags:
  - architecture
  - api
---
# Plan Content

This is the body.
"""
        meta, body = parse_frontmatter(content)
        assert meta["title"] == "My Plan"
        assert meta["type"] == "plan"
        assert meta["tags"] == ["architecture", "api"]
        assert "# Plan Content" in body

    def test_parse_missing_required_fields(self) -> None:
        content = """---
tags:
  - test
---
Body without title or type.
"""
        with pytest.raises(FrontmatterError, match="title"):
            parse_frontmatter(content)

    def test_parse_invalid_type(self) -> None:
        content = """---
title: Bad Type
type: invalid_type
---
Body.
"""
        with pytest.raises(FrontmatterError, match="type"):
            parse_frontmatter(content)

    def test_parse_no_frontmatter(self) -> None:
        content = "Just a plain markdown file."
        with pytest.raises(FrontmatterError, match="frontmatter"):
            parse_frontmatter(content)

    def test_parse_valid_types(self) -> None:
        """All known types should be accepted."""
        for entry_type in ["plan", "decision", "journal", "research", "context", "note", "notebook"]:
            content = f"""---
title: Test {entry_type}
type: {entry_type}
---
Body.
"""
            meta, body = parse_frontmatter(content)
            assert meta["type"] == entry_type

    def test_parse_optional_fields_preserved(self) -> None:
        content = """---
title: With Status
type: plan
status: active
---
Body.
"""
        meta, body = parse_frontmatter(content)
        assert meta["status"] == "active"
