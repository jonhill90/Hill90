"""Path canonicalization and traversal prevention for knowledge entries."""

import re

# Valid path characters: lowercase alphanumeric, hyphens, underscores, forward slashes, dots
_VALID_PATH_RE = re.compile(r"^[a-z0-9_\-/][a-z0-9_\-/.]*$")
_MAX_DEPTH = 3


def canonicalize_path(path: str) -> str:
    """Normalize a path: lowercase, strip leading/trailing slashes, collapse doubles."""
    path = path.lower().strip("/")
    # Collapse double slashes
    while "//" in path:
        path = path.replace("//", "/")
    return path


def validate_path(path: str) -> str:
    """Validate and canonicalize an agent-relative path.

    Raises ValueError if the path is invalid or dangerous.
    Returns the canonicalized path.
    """
    # Reject absolute paths
    if path.startswith("/"):
        raise ValueError("absolute paths are not allowed")

    # Reject traversal attempts
    if ".." in path:
        raise ValueError("path traversal (..) is not allowed")

    # Reject hidden files and current-directory tricks
    # Check each segment for leading dots (hidden files/dirs)
    for segment in path.split("/"):
        if segment.startswith("."):
            raise ValueError("hidden files/directories (starting with .) are not allowed")

    # Canonicalize
    path = canonicalize_path(path)

    # Validate characters
    if not _VALID_PATH_RE.match(path):
        raise ValueError(f"path contains invalid characters: {path}")

    # Check extension
    if not path.endswith(".md"):
        raise ValueError("path must have .md extension")

    # Check depth (segments before filename)
    segments = path.split("/")
    if len(segments) > _MAX_DEPTH:
        raise ValueError(f"path depth exceeds maximum of {_MAX_DEPTH}: {path}")

    return path
