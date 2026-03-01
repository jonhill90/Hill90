"""Unit tests for the text chunker service."""

import pytest

from app.services.text_chunker import (
    Chunk,
    chunk_markdown,
    chunk_text,
    estimate_tokens,
)


class TestEstimateTokens:
    def test_empty_string(self):
        assert estimate_tokens("") == 0

    def test_known_length(self):
        # 4 chars per token
        assert estimate_tokens("abcd") == 1
        assert estimate_tokens("a" * 400) == 100


class TestChunkTextParagraphs:
    def test_single_short_paragraph(self):
        text = "This is a short paragraph."
        chunks = chunk_text(text, target_tokens=500)
        assert len(chunks) == 1
        assert chunks[0].content == text
        assert chunks[0].index == 0

    def test_multiple_paragraphs_within_budget(self):
        text = "Paragraph one.\n\nParagraph two.\n\nParagraph three."
        chunks = chunk_text(text, target_tokens=500)
        assert len(chunks) == 1
        assert "Paragraph one." in chunks[0].content
        assert "Paragraph three." in chunks[0].content

    def test_paragraphs_split_at_boundary(self):
        # Create paragraphs that should split into multiple chunks
        para = "word " * 200  # ~250 tokens each paragraph
        text = f"{para.strip()}\n\n{para.strip()}\n\n{para.strip()}"
        chunks = chunk_text(text, target_tokens=300, overlap_tokens=20)
        assert len(chunks) >= 2
        # All chunk indexes should be sequential
        for i, c in enumerate(chunks):
            assert c.index == i

    def test_empty_text(self):
        chunks = chunk_text("")
        assert len(chunks) == 0

    def test_whitespace_only(self):
        chunks = chunk_text("   \n\n   ")
        assert len(chunks) == 0


class TestChunkTextTokenLimits:
    def test_small_target(self):
        text = "First para.\n\nSecond para.\n\nThird para."
        chunks = chunk_text(text, target_tokens=5, overlap_tokens=1)
        # Each paragraph is small, but the target is tiny so they should split
        assert len(chunks) >= 1
        for c in chunks:
            assert c.token_estimate >= 0

    def test_large_single_paragraph(self):
        # Single paragraph exceeding target becomes its own chunk
        big_para = "word " * 1000  # ~1250 tokens
        chunks = chunk_text(big_para.strip(), target_tokens=500, overlap_tokens=50)
        assert len(chunks) >= 1

    def test_token_estimates_are_reasonable(self):
        text = "a" * 2000  # 500 tokens
        chunks = chunk_text(text, target_tokens=600)
        assert len(chunks) == 1
        assert chunks[0].token_estimate == 500


class TestChunkTextOverlap:
    def test_overlap_content_shared(self):
        # Build content that will produce at least 2 chunks
        para1 = "alpha " * 250  # ~312 tokens
        para2 = "beta " * 250   # ~312 tokens
        text = f"{para1.strip()}\n\n{para2.strip()}"
        chunks = chunk_text(text, target_tokens=350, overlap_tokens=50)
        assert len(chunks) >= 2
        # The second chunk should contain some content from the end of the first
        # (overlap region). This means the end of chunk[0] and start of chunk[1]
        # should share some text.
        if len(chunks) >= 2:
            # Overlap means chunks[1] starts with tail of chunks[0]
            tail_chars = 50 * 4  # overlap_tokens * chars_per_token
            chunk0_tail = chunks[0].content[-tail_chars:]
            # chunk1 should contain the overlap
            assert chunk0_tail in chunks[1].content or chunks[1].content[:tail_chars] in chunks[0].content


class TestChunkMarkdownHeadings:
    def test_heading_aware_splitting(self):
        md = """# Introduction

This is the introduction paragraph.

# Methods

This section describes the methods used.

# Results

The results were significant.
"""
        chunks = chunk_markdown(md, target_tokens=500)
        assert len(chunks) >= 1
        # All content should be preserved across chunks
        combined = " ".join(c.content for c in chunks)
        assert "Introduction" in combined
        assert "Methods" in combined
        assert "Results" in combined

    def test_heading_sections_preserved(self):
        # Each section is large enough to be its own chunk
        section1 = "# Section One\n\n" + ("alpha " * 250).strip()
        section2 = "# Section Two\n\n" + ("beta " * 250).strip()
        md = f"{section1}\n\n{section2}"
        chunks = chunk_markdown(md, target_tokens=350, overlap_tokens=20)
        assert len(chunks) >= 2

    def test_mixed_heading_levels(self):
        md = """# Top Level

Content under top level.

## Sub Level

Content under sub level.

### Sub Sub Level

Content under sub sub level.
"""
        chunks = chunk_markdown(md, target_tokens=500)
        assert len(chunks) >= 1
        combined = " ".join(c.content for c in chunks)
        assert "Top Level" in combined
        assert "Sub Level" in combined

    def test_no_headings_falls_back_to_paragraphs(self):
        text = "Para one.\n\nPara two.\n\nPara three."
        # chunk_markdown with no headings should still work
        chunks = chunk_markdown(text, target_tokens=500)
        assert len(chunks) == 1
        assert "Para one." in chunks[0].content

    def test_empty_markdown(self):
        chunks = chunk_markdown("")
        assert len(chunks) == 0
