"""Unit tests for web page fetcher with SSRF protection.

Tests cover the full Fetch Safety Contract:
- URL validation (scheme, credentials, port, internal hostnames)
- DNS resolution check against blocked CIDR ranges
- Redirect re-validation on every hop
- Error message information leak prevention
- Response size limits (Content-Length header + streaming body enforcement)
"""

from __future__ import annotations

import socket
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.services.web_page_fetcher import (
    BLOCKED_HOSTNAMES,
    FetchError,
    MAX_RESPONSE_BYTES,
    _is_blocked_ip,
    _validate_url,
    fetch_and_extract,
)


# ---------------------------------------------------------------------------
# Helper: build mock streaming client + response
# ---------------------------------------------------------------------------


def _make_streaming_response(
    *,
    status_code: int = 200,
    headers: dict[str, str] | None = None,
    body: bytes = b"",
    is_redirect: bool = False,
    charset_encoding: str | None = "utf-8",
) -> MagicMock:
    """Build a mock httpx response compatible with streaming (send + aiter_bytes)."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.is_redirect = is_redirect
    resp.headers = headers or {}
    resp.charset_encoding = charset_encoding
    resp.aclose = AsyncMock()

    # Create an async generator for aiter_bytes
    _body = body

    async def _aiter_bytes(chunk_size: int = 65536):
        for i in range(0, len(_body), chunk_size):
            yield _body[i : i + chunk_size]

    resp.aiter_bytes = _aiter_bytes
    return resp


def _make_mock_client(response: MagicMock | Exception) -> AsyncMock:
    """Build a mock httpx.AsyncClient with send + build_request."""
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.build_request = MagicMock(return_value=MagicMock())

    if isinstance(response, Exception):
        mock_client.send = AsyncMock(side_effect=response)
    else:
        mock_client.send = AsyncMock(return_value=response)

    return mock_client


# DNS mock that returns a public IP (passes all checks)
PUBLIC_DNS = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 443))]


# ---------------------------------------------------------------------------
# URL Validation — scheme, credentials, port, hostnames
# ---------------------------------------------------------------------------


class TestValidateUrl:
    def test_accepts_https_url(self) -> None:
        _validate_url("https://example.com/page")

    def test_accepts_http_url(self) -> None:
        _validate_url("http://example.com/page")

    def test_rejects_ftp_scheme(self) -> None:
        with pytest.raises(FetchError, match="scheme"):
            _validate_url("ftp://example.com/file.txt")

    def test_rejects_file_scheme(self) -> None:
        with pytest.raises(FetchError, match="scheme"):
            _validate_url("file:///etc/passwd")

    def test_rejects_data_scheme(self) -> None:
        with pytest.raises(FetchError, match="scheme"):
            _validate_url("data:text/html,<h1>hi</h1>")

    def test_rejects_javascript_scheme(self) -> None:
        with pytest.raises(FetchError, match="scheme"):
            _validate_url("javascript:alert(1)")

    def test_rejects_url_with_userinfo(self) -> None:
        with pytest.raises(FetchError, match="credentials"):
            _validate_url("https://user:pass@example.com/")

    def test_rejects_url_with_username_only(self) -> None:
        with pytest.raises(FetchError, match="credentials"):
            _validate_url("https://admin@example.com/")

    def test_rejects_non_standard_port(self) -> None:
        with pytest.raises(FetchError, match="port"):
            _validate_url("https://example.com:8080/page")

    def test_accepts_port_80(self) -> None:
        _validate_url("http://example.com:80/page")

    def test_accepts_port_443(self) -> None:
        _validate_url("https://example.com:443/page")

    def test_rejects_empty_hostname(self) -> None:
        with pytest.raises(FetchError, match="hostname"):
            _validate_url("https:///path")

    def test_rejects_internal_service_hostname_postgres(self) -> None:
        with pytest.raises(FetchError, match="internal service"):
            _validate_url("http://postgres:5432/")

    def test_rejects_internal_service_hostname_api(self) -> None:
        with pytest.raises(FetchError, match="internal service"):
            _validate_url("http://api/health")

    def test_rejects_internal_service_hostname_keycloak(self) -> None:
        with pytest.raises(FetchError, match="internal service"):
            _validate_url("http://keycloak:8080/auth")

    def test_rejects_internal_service_hostname_litellm(self) -> None:
        with pytest.raises(FetchError, match="internal service"):
            _validate_url("http://litellm/v1/models")

    def test_rejects_internal_service_hostname_openbao(self) -> None:
        with pytest.raises(FetchError, match="internal service"):
            _validate_url("http://openbao:8200/v1/sys/health")

    def test_rejects_internal_service_hostname_knowledge(self) -> None:
        with pytest.raises(FetchError, match="internal service"):
            _validate_url("http://knowledge:8002/health")

    def test_rejects_ip_literal_loopback(self) -> None:
        with pytest.raises(FetchError, match="blocked"):
            _validate_url("http://127.0.0.1/")

    def test_rejects_ip_literal_private(self) -> None:
        with pytest.raises(FetchError, match="blocked"):
            _validate_url("http://10.0.0.1/")


# ---------------------------------------------------------------------------
# Blocked IP ranges — all 7 CIDR categories
# ---------------------------------------------------------------------------


class TestIsBlockedIp:
    def test_blocks_loopback_127(self) -> None:
        assert _is_blocked_ip("127.0.0.1") is True
        assert _is_blocked_ip("127.255.255.255") is True

    def test_blocks_rfc1918_class_a(self) -> None:
        assert _is_blocked_ip("10.0.0.1") is True
        assert _is_blocked_ip("10.255.255.255") is True

    def test_blocks_rfc1918_class_b_docker(self) -> None:
        assert _is_blocked_ip("172.16.0.1") is True
        assert _is_blocked_ip("172.31.255.255") is True
        # 172.32.x should NOT be blocked
        assert _is_blocked_ip("172.32.0.1") is False

    def test_blocks_rfc1918_class_c(self) -> None:
        assert _is_blocked_ip("192.168.0.1") is True
        assert _is_blocked_ip("192.168.255.255") is True

    def test_blocks_link_local(self) -> None:
        assert _is_blocked_ip("169.254.0.1") is True
        assert _is_blocked_ip("169.254.169.254") is True  # AWS metadata

    def test_blocks_tailscale_cgnat(self) -> None:
        assert _is_blocked_ip("100.64.0.1") is True
        assert _is_blocked_ip("100.100.100.100") is True
        assert _is_blocked_ip("100.127.255.255") is True

    def test_blocks_unspecified(self) -> None:
        assert _is_blocked_ip("0.0.0.0") is True

    def test_blocks_broadcast(self) -> None:
        assert _is_blocked_ip("255.255.255.255") is True

    def test_allows_public_ip(self) -> None:
        assert _is_blocked_ip("8.8.8.8") is False
        assert _is_blocked_ip("1.1.1.1") is False
        assert _is_blocked_ip("93.184.216.34") is False  # example.com

    def test_blocks_ipv6_loopback(self) -> None:
        assert _is_blocked_ip("::1") is True

    def test_blocks_ipv6_link_local(self) -> None:
        assert _is_blocked_ip("fe80::1") is True

    def test_blocks_ipv6_unique_local(self) -> None:
        assert _is_blocked_ip("fc00::1") is True
        assert _is_blocked_ip("fd00::1") is True


# ---------------------------------------------------------------------------
# DNS resolution → blocked IP detection
# ---------------------------------------------------------------------------


class TestDnsResolutionBlocking:
    @pytest.mark.asyncio
    async def test_blocks_dns_resolving_to_private_ip(self) -> None:
        """A public hostname that resolves to a private IP must be rejected."""
        with patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns:
            mock_dns.return_value = [
                (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("10.0.0.5", 80))
            ]
            with pytest.raises(FetchError, match="blocked"):
                await fetch_and_extract("https://evil.example.com/page")

    @pytest.mark.asyncio
    async def test_blocks_dns_resolving_to_loopback(self) -> None:
        with patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns:
            mock_dns.return_value = [
                (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", 80))
            ]
            with pytest.raises(FetchError, match="blocked"):
                await fetch_and_extract("https://evil.example.com/page")


# ---------------------------------------------------------------------------
# Redirect re-validation
# ---------------------------------------------------------------------------


class TestRedirectRevalidation:
    @pytest.mark.asyncio
    async def test_blocks_redirect_to_private_ip(self) -> None:
        """Redirect to http://127.0.0.1/ must be caught and rejected."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
        ):
            mock_dns.return_value = PUBLIC_DNS

            redirect_resp = _make_streaming_response(
                status_code=301,
                headers={"location": "http://127.0.0.1/secret"},
                is_redirect=True,
            )
            mock_client_cls.return_value = _make_mock_client(redirect_resp)

            with pytest.raises(FetchError, match="blocked|internal"):
                await fetch_and_extract("https://redirect.example.com/go")

    @pytest.mark.asyncio
    async def test_redirect_revalidates_scheme(self) -> None:
        """Redirect to ftp:// must be rejected."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
        ):
            mock_dns.return_value = PUBLIC_DNS

            redirect_resp = _make_streaming_response(
                status_code=302,
                headers={"location": "ftp://files.example.com/data"},
                is_redirect=True,
            )
            mock_client_cls.return_value = _make_mock_client(redirect_resp)

            with pytest.raises(FetchError, match="scheme"):
                await fetch_and_extract("https://redirect.example.com/go")

    @pytest.mark.asyncio
    async def test_max_redirects_enforced(self) -> None:
        """More than 3 redirects must be rejected."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
        ):
            mock_dns.return_value = PUBLIC_DNS

            redirect_resp = _make_streaming_response(
                status_code=302,
                headers={"location": "https://example.com/next"},
                is_redirect=True,
            )
            mock_client_cls.return_value = _make_mock_client(redirect_resp)

            with pytest.raises(FetchError, match="redirect"):
                await fetch_and_extract("https://loop.example.com/start")


# ---------------------------------------------------------------------------
# Error message information leak prevention
# ---------------------------------------------------------------------------


class TestErrorMessageNoIpLeak:
    @pytest.mark.asyncio
    async def test_error_message_no_ip_leak(self) -> None:
        """Error messages must not include the resolved IP address."""
        with patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns:
            mock_dns.return_value = [
                (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("10.42.99.7", 80))
            ]
            with pytest.raises(FetchError) as exc_info:
                await fetch_and_extract("https://sneaky.example.com/data")

            error_msg = str(exc_info.value)
            assert "10.42.99.7" not in error_msg
            assert "blocked" in error_msg.lower() or "private" in error_msg.lower()


# ---------------------------------------------------------------------------
# Response size limit — Content-Length header + streaming enforcement
# ---------------------------------------------------------------------------


class TestResponseSizeLimit:
    @pytest.mark.asyncio
    async def test_rejects_oversized_content_length_header(self) -> None:
        """Response with Content-Length > 2MB must be rejected before reading body."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
        ):
            mock_dns.return_value = PUBLIC_DNS

            resp = _make_streaming_response(
                headers={
                    "content-length": str(3 * 1024 * 1024),
                    "content-type": "text/html",
                },
            )
            mock_client = _make_mock_client(resp)
            mock_client_cls.return_value = mock_client

            with pytest.raises(FetchError, match="size"):
                await fetch_and_extract("https://big.example.com/huge-page")

            # aclose must be called even on rejection
            resp.aclose.assert_called()

    @pytest.mark.asyncio
    async def test_rejects_oversized_body_without_content_length(self) -> None:
        """Response without Content-Length that exceeds 2MB during streaming must be rejected."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
        ):
            mock_dns.return_value = PUBLIC_DNS

            # No content-length header — server streams without advertising size
            oversized_body = b"x" * (MAX_RESPONSE_BYTES + 1)
            resp = _make_streaming_response(
                headers={"content-type": "text/html"},
                body=oversized_body,
            )
            mock_client_cls.return_value = _make_mock_client(resp)

            with pytest.raises(FetchError, match="size limit"):
                await fetch_and_extract("https://big.example.com/no-content-length")

            # aclose must be called via finally block
            resp.aclose.assert_called()

    @pytest.mark.asyncio
    async def test_streaming_aborts_mid_read(self) -> None:
        """Body exceeding 2MB is rejected during streaming, not after full buffering."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
        ):
            mock_dns.return_value = PUBLIC_DNS

            # Build a response that yields many 64KB chunks exceeding the limit
            chunk_count = (MAX_RESPONSE_BYTES // 65536) + 2  # enough to exceed limit
            chunks_yielded: list[int] = []

            async def _tracked_aiter_bytes(chunk_size: int = 65536):
                for i in range(chunk_count):
                    chunks_yielded.append(i)
                    yield b"x" * 65536

            resp = MagicMock()
            resp.status_code = 200
            resp.is_redirect = False
            resp.headers = {"content-type": "text/html"}
            resp.charset_encoding = "utf-8"
            resp.aclose = AsyncMock()
            resp.aiter_bytes = _tracked_aiter_bytes

            mock_client_cls.return_value = _make_mock_client(resp)

            with pytest.raises(FetchError, match="size limit"):
                await fetch_and_extract("https://big.example.com/streaming")

            # Verify streaming aborted before all chunks were read
            assert len(chunks_yielded) < chunk_count


# ---------------------------------------------------------------------------
# Successful fetch and extract
# ---------------------------------------------------------------------------


class TestFetchAndExtract:
    @pytest.mark.asyncio
    async def test_web_page_fetcher_extracts_content(self) -> None:
        """Successful fetch returns title and extracted text."""
        html = "<html><head><title>Test Page</title></head><body><p>Hello world paragraph.</p></body></html>"
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
            patch("app.services.web_page_fetcher.trafilatura") as mock_traf,
        ):
            mock_dns.return_value = PUBLIC_DNS

            resp = _make_streaming_response(
                headers={"content-length": "200", "content-type": "text/html"},
                body=html.encode(),
            )
            mock_client_cls.return_value = _make_mock_client(resp)

            mock_traf.extract.return_value = "Hello world paragraph."

            result = await fetch_and_extract("https://example.com/page")

            assert result["content"] == "Hello world paragraph."
            assert result["url"] == "https://example.com/page"

    @pytest.mark.asyncio
    async def test_web_page_fetcher_timeout(self) -> None:
        """Connection timeout raises FetchError."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
        ):
            mock_dns.return_value = PUBLIC_DNS

            mock_client_cls.return_value = _make_mock_client(
                httpx.ConnectTimeout("timed out")
            )

            with pytest.raises(FetchError, match="timed out|timeout"):
                await fetch_and_extract("https://slow.example.com/page")

    @pytest.mark.asyncio
    async def test_web_page_fetcher_extraction_fails(self) -> None:
        """When trafilatura returns None, raise FetchError."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
            patch("app.services.web_page_fetcher.trafilatura") as mock_traf,
        ):
            mock_dns.return_value = PUBLIC_DNS

            resp = _make_streaming_response(
                headers={"content-length": "200", "content-type": "text/html"},
                body=b"<html></html>",
            )
            mock_client_cls.return_value = _make_mock_client(resp)

            mock_traf.extract.return_value = None

            with pytest.raises(FetchError, match="extract"):
                await fetch_and_extract("https://empty.example.com/page")
