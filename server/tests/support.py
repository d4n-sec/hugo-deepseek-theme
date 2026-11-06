"""HTTP test support for the Threadline service tests."""

from __future__ import annotations

import http.cookiejar
import json
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Mapping, Optional

import app
from tests.mock_github import (
    ATTACHMENT_TOKEN,
    CLIENT_ID,
    CLIENT_SECRET,
    MockGitHub,
    OWNER,
    READ_TOKEN,
    REPO,
)

SITE_ORIGIN = "http://127.0.0.1:1313"
SITE_RETURN = SITE_ORIGIN + "/posts/example?from=oauth"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


class Response:
    def __init__(
        self,
        status: int,
        headers: list[tuple[str, str]],
        body: bytes,
        url: str,
    ) -> None:
        self.status = status
        self.headers = headers
        self.body = body
        self.url = url

    def header(self, name: str, default: Optional[str] = None) -> Optional[str]:
        lower = name.lower()
        for key, value in reversed(self.headers):
            if key.lower() == lower:
                return value
        return default

    def header_all(self, name: str) -> list[str]:
        lower = name.lower()
        return [value for key, value in self.headers if key.lower() == lower]

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))

    def text(self) -> str:
        return self.body.decode("utf-8", "replace")


class Client:
    """A real HTTP client with a persistent cookiejar and no auto-redirect."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar), NoRedirect()
        )

    def get(self, target: str, **kwargs: Any) -> Response:
        return self.request("GET", target, **kwargs)

    def post(self, target: str, **kwargs: Any) -> Response:
        return self.request("POST", target, **kwargs)

    def request(
        self,
        method: str,
        target: str,
        *,
        json_body: Any = None,
        body: Optional[bytes] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> Response:
        url = (
            target
            if target.startswith("http://") or target.startswith("https://")
            else self.base_url + target
        )
        request_headers = dict(headers or {})
        data = body
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json")
        request = urllib.request.Request(
            url, data=data, headers=request_headers, method=method
        )
        try:
            response = self.opener.open(request, timeout=10)
        except urllib.error.HTTPError as exc:
            response = exc
        try:
            raw = response.read()
            status = response.status
            response_headers = list(response.getheaders())
        finally:
            response.close()
        return Response(status, response_headers, raw, url)

    def multipart(
        self,
        target: str,
        *,
        filename: str,
        content: bytes,
        content_type: str,
        field: str = "file",
        headers: Optional[Mapping[str, str]] = None,
    ) -> Response:
        boundary = "----testboundary" + "x" * 16
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode("utf-8") + content + f"\r\n--{boundary}--\r\n".encode("ascii")
        request_headers = dict(headers or {})
        request_headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        return self.request(
            "POST", target, body=body, headers=request_headers
        )

    def cookie_value(self, name: str) -> Optional[str]:
        for cookie in self.jar:
            if cookie.name == name:
                return cookie.value
        return None


class RunningService:
    def __init__(
        self,
        mock: MockGitHub,
        temp_dir: Path,
        *,
        attachments_mode: str = "disabled",
        attachments_max_bytes: int = 5242880,
        extra_env: Optional[Mapping[str, str]] = None,
    ) -> None:
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        finally:
            probe.close()
        self.port = port
        self.base_url = f"http://127.0.0.1:{port}"
        env = {
            "HOST": "127.0.0.1",
            "PORT": str(port),
            "PUBLIC_BASE_URL": self.base_url,
            "SITE_ORIGINS": SITE_ORIGIN,
            "COOKIE_SECURE": "false",
            "COOKIE_SAMESITE": "Lax",
            "COMMENTS_REPOSITORY": f"{OWNER}/{REPO}",
            "BLOGGER_GITHUB_LOGIN": "blogger",
            "DATABASE_PATH": str(temp_dir / f"threadline-{port}.db"),
            "GITHUB_API_BASE": mock.base_url,
            "GITHUB_OAUTH_AUTHORIZE_URL": mock.oauth_authorize_url,
            "GITHUB_OAUTH_TOKEN_URL": mock.oauth_token_url,
            "GITHUB_CLIENT_ID": CLIENT_ID,
            "GITHUB_CLIENT_SECRET": CLIENT_SECRET,
            "GITHUB_OAUTH_SCOPE": "",
            "GITHUB_READ_TOKEN": READ_TOKEN,
            "SESSION_TTL_SECONDS": "3600",
            "ATTACHMENTS_MODE": attachments_mode,
            "ATTACHMENTS_MAX_BYTES": str(attachments_max_bytes),
            "ATTACHMENTS_ALLOWED_TYPES": (
                "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain"
            ),
        }
        if attachments_mode == "local":
            env["ATTACHMENTS_DIR"] = str(temp_dir / f"attachments-{port}")
            env["ATTACHMENTS_PUBLIC_BASE_URL"] = self.base_url
        if attachments_mode == "http":
            env["ATTACHMENTS_HTTP_URL"] = mock.base_url + "/upload"
            env["ATTACHMENTS_HTTP_TOKEN"] = ATTACHMENT_TOKEN
        env.update(dict(extra_env or {}))
        self.env = env
        self.config = app.Config.from_env(env)
        self.service = app.Application(self.config)
        self.httpd = app.ThreadlineHTTPServer(
            (self.config.host, self.config.port), self.service
        )
        self.thread = threading.Thread(
            target=self.httpd.serve_forever, daemon=True, name="threadline-test"
        )
        self.thread.start()

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    def client(self) -> Client:
        return Client(self.base_url)


def login(
    client: Client,
    mock: MockGitHub,
    user: str,
    return_to: str = SITE_RETURN,
) -> dict[str, Any]:
    start = client.get(
        "/api/auth/github?returnTo=" + urllib.parse.quote(return_to, safe="")
    )
    assert start.status == 302, start.text()
    authorize = start.header("Location")
    assert authorize
    separator = "&" if "?" in authorize else "?"
    authorize_response = client.get(f"{authorize}{separator}login={user}")
    assert authorize_response.status == 302, authorize_response.text()
    callback = authorize_response.header("Location")
    assert callback
    callback_response = client.get(callback)
    assert callback_response.status == 302, callback_response.text()
    session = client.get("/api/session")
    assert session.status == 200
    payload = session.json()
    assert payload["authenticated"] is True
    return payload


def auth_headers(session_payload: Mapping[str, Any]) -> dict[str, str]:
    return {
        "X-CSRF-Token": str(session_payload["csrfToken"]),
        "Origin": SITE_ORIGIN,
    }


def make_png() -> bytes:
    return b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
