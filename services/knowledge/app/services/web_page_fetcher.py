"""Web page fetcher with SSRF protection.

Implements the Fetch Safety Contract:
- URL validation (scheme, credentials, port, internal hostnames)
- Pre-connect DNS resolution check against blocked CIDR ranges
- Manual redirect following with re-validation on every hop
- Error messages omit resolved IP addresses
- Response size limits
"""

from __future__ import annotations

import ipaddress
import socket
from typing import Any
from urllib.parse import urlparse

import httpx
import structlog
import trafilatura

logger = structlog.get_logger()

MAX_RESPONSE_BYTES = 2 * 1024 * 1024  # 2 MB
MAX_REDIRECTS = 3
CONNECT_TIMEOUT = 10.0  # seconds
READ_TIMEOUT = 30.0  # seconds
USER_AGENT = "Hill90-KnowledgeService/1.0"
ALLOWED_PORTS = {80, 443}

# Docker service hostnames that must never be fetched
BLOCKED_HOSTNAMES = frozenset({
    "postgres",
    "api",
    "ai",
    "keycloak",
    "litellm",
    "openbao",
    "minio",
    "tempo",
    "knowledge",
    "docker-proxy",
    "promtail",
    "loki",
    "prometheus",
    "grafana",
})

# Tailscale/CGNAT range not covered by is_private in all Python versions
_TAILSCALE_CGNAT = ipaddress.ip_network("100.64.0.0/10")


class FetchError(Exception):
    """Raised when URL fetch fails validation or network checks."""


def _is_blocked_ip(ip_str: str) -> bool:
    """Check if an IP address falls in any blocked range.

    Expects a valid IP address string. Returns False for unparseable
    strings (hostnames are checked separately).
    """
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return False  # Not an IP address (e.g. hostname) — checked elsewhere

    if addr.is_loopback:
        return True
    if addr.is_private:
        return True
    if addr.is_link_local:
        return True
    if addr.is_reserved:
        return True
    if addr.is_multicast:
        return True
    if addr.is_unspecified:
        return True

    # Explicit Tailscale/CGNAT check (100.64.0.0/10)
    if isinstance(addr, ipaddress.IPv4Address) and addr in _TAILSCALE_CGNAT:
        return True

    return False


def _validate_url(url: str) -> tuple[str, str, int | None]:
    """Validate URL before any network I/O.

    Returns (scheme, hostname, port) if valid.
    Raises FetchError with category-only message if invalid.
    """
    parsed = urlparse(url)

    # Step 1-2: scheme
    if parsed.scheme not in ("http", "https"):
        raise FetchError(f"URL scheme '{parsed.scheme}' is not allowed; only http/https are accepted")

    # Step 3: hostname
    hostname = parsed.hostname
    if not hostname:
        raise FetchError("URL has no hostname")

    # Step 5: credentials
    if parsed.username or parsed.password:
        raise FetchError("URL must not contain credentials (user:pass@host)")

    # Step 6: internal hostnames (check before port to give clearer errors)
    hostname_lower = hostname.lower()
    if hostname_lower in BLOCKED_HOSTNAMES:
        raise FetchError(f"Hostname '{hostname_lower}' matches an internal service name")

    # Step 4: port
    port = parsed.port
    if port is not None and port not in ALLOWED_PORTS:
        raise FetchError(f"Non-standard port {port} is not allowed; only 80 and 443 are accepted")

    # Check if hostname is an IP literal in a blocked range
    try:
        ipaddress.ip_address(hostname)
        # It's an IP literal — check against blocked ranges
        if _is_blocked_ip(hostname):
            raise FetchError("URL points to a blocked IP address range")
    except ValueError:
        pass  # Not an IP literal — will resolve via DNS later

    return parsed.scheme, hostname, port


def _resolve_and_check(hostname: str, port: int | None) -> None:
    """Resolve hostname via DNS and check all IPs against blocked ranges.

    Raises FetchError if any resolved IP is blocked.
    Does NOT include the resolved IP in the error message.
    """
    resolve_port = port or 443
    try:
        results = socket.getaddrinfo(hostname, resolve_port, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise FetchError(f"DNS resolution failed for hostname '{hostname}'")

    if not results:
        raise FetchError(f"DNS resolution returned no results for hostname '{hostname}'")

    for family, _type, _proto, _canonname, sockaddr in results:
        ip_str = sockaddr[0]
        if _is_blocked_ip(ip_str):
            raise FetchError(
                f"Hostname '{hostname}' resolves to a blocked private/internal IP address range"
            )


async def fetch_and_extract(url: str) -> dict[str, Any]:
    """Fetch a web page and extract its text content.

    Returns dict with keys: url, title, content, content_type.
    Raises FetchError on validation failure, network error, or extraction failure.
    """
    # URL validation (before any network I/O)
    scheme, hostname, port = _validate_url(url)

    # DNS resolution check (before HTTP connect)
    _resolve_and_check(hostname, port)

    current_url = url
    redirects = 0

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(connect=CONNECT_TIMEOUT, read=READ_TIMEOUT, write=READ_TIMEOUT, pool=READ_TIMEOUT),
        follow_redirects=False,
        headers={"User-Agent": USER_AGENT},
    ) as client:
        while True:
            try:
                response = await client.send(
                    client.build_request("GET", current_url),
                    stream=True,
                )
            except httpx.ConnectTimeout:
                raise FetchError(f"Connection timed out fetching '{hostname}'")
            except httpx.ReadTimeout:
                raise FetchError(f"Read timed out fetching '{hostname}'")
            except httpx.ConnectError as exc:
                raise FetchError(f"Connection failed for '{hostname}': {exc}")
            except httpx.HTTPError as exc:
                raise FetchError(f"HTTP error fetching '{hostname}': {exc}")

            # Handle redirects manually with re-validation
            if response.is_redirect:
                await response.aclose()
                redirects += 1
                if redirects > MAX_REDIRECTS:
                    raise FetchError(
                        f"Too many redirects (max {MAX_REDIRECTS}) fetching '{hostname}'"
                    )

                location = response.headers.get("location", "")
                if not location:
                    raise FetchError("Redirect response missing Location header")

                # Resolve relative redirects
                if location.startswith("/"):
                    parsed_current = urlparse(current_url)
                    location = f"{parsed_current.scheme}://{parsed_current.netloc}{location}"

                # Re-validate the redirect target
                redir_scheme, redir_hostname, redir_port = _validate_url(location)
                _resolve_and_check(redir_hostname, redir_port)

                current_url = location
                continue

            # Non-redirect response — check Content-Length header first
            content_length = response.headers.get("content-length")
            if content_length and int(content_length) > MAX_RESPONSE_BYTES:
                await response.aclose()
                raise FetchError(
                    f"Response size {int(content_length)} bytes exceeds limit of {MAX_RESPONSE_BYTES} bytes"
                )

            # Stream body with incremental size enforcement
            chunks: list[bytes] = []
            bytes_read = 0
            try:
                async for chunk in response.aiter_bytes(chunk_size=65536):
                    bytes_read += len(chunk)
                    if bytes_read > MAX_RESPONSE_BYTES:
                        raise FetchError(
                            f"Response body exceeds size limit of {MAX_RESPONSE_BYTES} bytes"
                        )
                    chunks.append(chunk)
            finally:
                await response.aclose()

            body = b"".join(chunks)
            break

    # Extract content with trafilatura
    content_type = response.headers.get("content-type", "text/html")
    encoding = response.charset_encoding or "utf-8"
    html = body.decode(encoding, errors="replace")
    extracted = trafilatura.extract(html)

    if not extracted or not extracted.strip():
        raise FetchError(f"Could not extract readable content from URL '{hostname}'")

    # Try to get title from trafilatura metadata
    metadata = trafilatura.extract(html, output_format="xmltei", include_comments=False)
    title = hostname  # fallback

    logger.info(
        "web_page_fetched",
        url=url,
        hostname=hostname,
        content_length=len(extracted),
    )

    return {
        "url": url,
        "title": title,
        "content": extracted,
        "content_type": content_type,
    }
