"""Text chunker for shared knowledge ingestion.

Splits text and markdown content into overlapping chunks at natural boundaries
(paragraph breaks, markdown headings). Aims for ~500 tokens per chunk with
~50 token overlap between adjacent chunks.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class Chunk:
    """A text chunk with metadata."""

    index: int
    content: str
    token_estimate: int


# Rough token estimate: 1 token ≈ 4 characters (matches AKM context route pattern)
_CHARS_PER_TOKEN = 4

DEFAULT_TARGET_TOKENS = 500
DEFAULT_OVERLAP_TOKENS = 50
MAX_SOURCE_SIZE = 100 * 1024  # 100 KB

# Markdown heading pattern: # through ######
_HEADING_RE = re.compile(r"^(#{1,6})\s+", re.MULTILINE)


def estimate_tokens(text: str) -> int:
    """Estimate token count from text length. Returns at least 1 for non-empty text."""
    if not text:
        return 0
    return max(1, len(text) // _CHARS_PER_TOKEN)


def _split_into_sections(text: str) -> list[str]:
    """Split markdown text at heading boundaries, preserving headings with their content."""
    positions = [m.start() for m in _HEADING_RE.finditer(text)]

    if not positions:
        # No headings — treat entire text as one section
        return [text]

    sections: list[str] = []

    # Content before first heading (if any)
    if positions[0] > 0:
        preamble = text[: positions[0]].strip()
        if preamble:
            sections.append(preamble)

    # Each heading starts a new section
    for i, pos in enumerate(positions):
        end = positions[i + 1] if i + 1 < len(positions) else len(text)
        section = text[pos:end].strip()
        if section:
            sections.append(section)

    return sections


def _split_into_paragraphs(text: str) -> list[str]:
    """Split text at double-newline paragraph boundaries."""
    paragraphs = re.split(r"\n\s*\n", text)
    return [p.strip() for p in paragraphs if p.strip()]


def _merge_paragraphs_into_chunks(
    paragraphs: list[str],
    target_tokens: int,
    overlap_tokens: int,
) -> list[Chunk]:
    """Merge paragraphs into chunks respecting token limits with overlap."""
    if not paragraphs:
        return []

    chunks: list[Chunk] = []
    current_parts: list[str] = []
    current_tokens = 0
    overlap_buffer: list[str] = []

    for para in paragraphs:
        para_tokens = estimate_tokens(para)

        # If a single paragraph exceeds target, it becomes its own chunk
        if para_tokens > target_tokens and not current_parts:
            chunks.append(Chunk(
                index=len(chunks),
                content=para,
                token_estimate=para_tokens,
            ))
            # Keep tail as overlap for next chunk
            overlap_text = para[-(overlap_tokens * _CHARS_PER_TOKEN) :]
            overlap_buffer = [overlap_text]
            current_parts = list(overlap_buffer)
            current_tokens = estimate_tokens(overlap_text)
            continue

        # If adding this paragraph would exceed target, finalize current chunk
        if current_parts and current_tokens + para_tokens > target_tokens:
            chunk_text = "\n\n".join(current_parts)
            chunks.append(Chunk(
                index=len(chunks),
                content=chunk_text,
                token_estimate=estimate_tokens(chunk_text),
            ))

            # Build overlap from tail of current chunk
            overlap_chars = overlap_tokens * _CHARS_PER_TOKEN
            tail = chunk_text[-overlap_chars:]
            overlap_buffer = [tail]
            current_parts = list(overlap_buffer)
            current_tokens = estimate_tokens(tail)

        current_parts.append(para)
        current_tokens += para_tokens

    # Final chunk
    if current_parts:
        # Don't emit a chunk that is purely overlap from the previous chunk
        chunk_text = "\n\n".join(current_parts)
        if chunks:
            prev_content = chunks[-1].content
            if chunk_text != prev_content[-len(chunk_text) :]:
                chunks.append(Chunk(
                    index=len(chunks),
                    content=chunk_text,
                    token_estimate=estimate_tokens(chunk_text),
                ))
        else:
            chunks.append(Chunk(
                index=len(chunks),
                content=chunk_text,
                token_estimate=estimate_tokens(chunk_text),
            ))

    return chunks


def chunk_text(
    text: str,
    *,
    target_tokens: int = DEFAULT_TARGET_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
) -> list[Chunk]:
    """Chunk plain text content at paragraph boundaries."""
    paragraphs = _split_into_paragraphs(text)
    return _merge_paragraphs_into_chunks(paragraphs, target_tokens, overlap_tokens)


def chunk_markdown(
    text: str,
    *,
    target_tokens: int = DEFAULT_TARGET_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
) -> list[Chunk]:
    """Chunk markdown content, splitting at heading boundaries first, then paragraphs."""
    sections = _split_into_sections(text)

    # Further split each section into paragraphs, then merge into chunks
    all_paragraphs: list[str] = []
    for section in sections:
        paragraphs = _split_into_paragraphs(section)
        all_paragraphs.extend(paragraphs)

    return _merge_paragraphs_into_chunks(all_paragraphs, target_tokens, overlap_tokens)
