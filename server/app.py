#!/usr/bin/env python3
"""Threadline comments service.

A small, dependency-free HTTP service that stores blog comments and article
reactions in GitHub Issues.  It is intentionally a single Python module so it
can be deployed by copying ``app.py`` and running ``python3 app.py``.

The service is designed to sit behind a TLS reverse proxy.  It is not a
general-purpose web framework: routes, validation, and storage are deliberately
explicit and small.
"""

from __future__ import annotations

import argparse
import contextlib
import email.message
import hashlib
import hmac
import http.cookies
import http.server
import json
import logging
import os
import pathlib
import re
import secrets
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Optional


LOG = logging.getLogger("threadline")

APP_VERSION = "1.0.0"
SESSION_COOKIE = "threadline_session"
OAUTH_STATE_COOKIE = "threadline_oauth_state"
OAUTH_STATE_TTL_SECONDS = 600
MAX_JSON_BODY_BYTES = 64 * 1024
MAX_TITLE_CHARS = 200
MAX_ARTICLE_URL_CHARS = 2048
MAX_COMMENT_CHARS = 5000
MAX_QUOTE_TEXT_CHARS = 800
MAX_QUOTE_CONTEXT_CHARS = 120
MAX_QUOTE_HEADING_CHARS = 200
MAX_QUOTE_OFFSET = 10_000_000
MAX_ISSUE_TITLE_CHARS = 256
MAX_ISSUE_TITLE_FALLBACK = "Discussion"
MAX_PAGINATED_ITEMS = 1000
PAGE_SIZE = 100
GITHUB_TIMEOUT_SECONDS = 20
ATTACHMENT_TIMEOUT_SECONDS = 30
USER_AGENT = f"Threadline/{APP_VERSION}"

COMMENT_REFRESH_WARNING = (
    "The comment was saved, but the comment list could not be refreshed. "
    "Reload the article to update the comment count."
)
REACTION_PARTIAL_WARNING = (
    "The reaction change could not be completed cleanly. The returned state "
    "reflects GitHub's current reactions; retry to finish the change."
)
REACTION_CONFLICT_WARNING = (
    "The reaction changed elsewhere before this request was applied. The "
    "returned state reflects GitHub's current reaction; no change was made."
)
REACTION_STATE_UNKNOWN_MESSAGE = (
    "The reaction change may have been applied, but the current reaction "
    "state could not be read. Reload the article to confirm your reaction."
)

COMMENT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
LOGIN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
ATTACHMENT_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{24,128}$")
MIME_RE = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$")
SUBMISSION_RE = re.compile(r"^[0-9a-f]{64}$")
SUBMISSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")

# Only these types are implemented by the local driver.  The allow-list is
# deliberately an allow-list: SVG, HTML, and scripts can never be uploaded,
# even if they are accidentally added to ATTACHMENTS_ALLOWED_TYPES.
ATTACHMENT_TYPE_RULES: dict[str, dict[str, Any]] = {
    "image/png": {
        "extensions": {".png"},
        "magic": lambda data: data.startswith(b"\x89PNG\r\n\x1a\n"),
        "inline": True,
    },
    "image/jpeg": {
        "extensions": {".jpg", ".jpeg"},
        "magic": lambda data: data.startswith(b"\xff\xd8\xff"),
        "inline": True,
    },
    "image/gif": {
        "extensions": {".gif"},
        "magic": lambda data: data.startswith((b"GIF87a", b"GIF89a")),
        "inline": True,
    },
    "image/webp": {
        "extensions": {".webp"},
        "magic": lambda data: len(data) >= 12
        and data.startswith(b"RIFF")
        and data[8:12] == b"WEBP",
        "inline": True,
    },
    "application/pdf": {
        "extensions": {".pdf"},
        "magic": lambda data: data.startswith(b"%PDF-"),
        "inline": False,
    },
    "text/plain": {
        "extensions": {".txt"},
        "magic": None,
        "inline": True,
    },
}
DEFAULT_ALLOWED_TYPES = tuple(ATTACHMENT_TYPE_RULES.keys())

META_MARKER_RE = re.compile(
    r"<!--\s*threadline-meta\s+(\{.*?\})\s*-->", re.IGNORECASE | re.DOTALL
)
META_MARKER_STRIP_RE = re.compile(
    r"<!--\s*threadline-meta\b.*?-->\s*", re.IGNORECASE | re.DOTALL
)


class ConfigError(ValueError):
    """Raised for an invalid environment configuration."""


class APIError(Exception):
    """An error that should become the documented JSON error response."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        headers: Optional[list[tuple[str, str]]] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.headers = headers or []


class AttachmentError(APIError):
    pass


class OAuthError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class GitHubAPIError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        retry_after: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.retry_after = retry_after

    def as_api_error(self) -> APIError:
        headers: list[tuple[str, str]] = []
        if self.retry_after is not None:
            headers.append(("Retry-After", str(self.retry_after)))
        return APIError(self.status, self.code, self.message, headers)


def _mutation_may_have_applied(error: GitHubAPIError) -> bool:
    """Return True when a failed write could still have reached GitHub.

    Transport failures, timeouts, 5xx responses, and the generic
    ``github_unavailable`` / ``github_error`` mappings are ambiguous: the
    request may have been applied before the response was lost. Authentication,
    permission, not-found, validation, and rate-limit errors are definitive
    pre-write rejections.
    """
    if error.code in {"github_unavailable", "github_error"}:
        return True
    return error.status == 408 or error.status >= 500


def _env_bool(value: str, name: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ConfigError(f"{name} must be true or false")


def _env_int(value: str, name: str, minimum: int, maximum: int) -> int:
    try:
        number = int(value.strip(), 10)
    except (TypeError, ValueError):
        raise ConfigError(f"{name} must be an integer") from None
    if number < minimum or number > maximum:
        raise ConfigError(f"{name} must be between {minimum} and {maximum}")
    return number


def _parse_url(value: str, name: str, *, allow_path: bool = True) -> urllib.parse.SplitResult:
    value = value.strip()
    if not value:
        raise ConfigError(f"{name} is required")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value) or "\\" in value:
        raise ConfigError(f"{name} contains invalid characters")
    try:
        parts = urllib.parse.urlsplit(value)
        _ = parts.port  # Validate malformed/non-numeric ports.
    except ValueError:
        raise ConfigError(f"{name} must be a valid absolute URL") from None
    if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
        raise ConfigError(f"{name} must be an absolute http(s) URL")
    if parts.username is not None or parts.password is not None:
        raise ConfigError(f"{name} must not contain credentials")
    if parts.query or parts.fragment:
        raise ConfigError(f"{name} must not contain a query string or fragment")
    if not allow_path and parts.path not in {"", "/"}:
        raise ConfigError(f"{name} must be an origin without a path")
    return parts


def normalize_origin(value: str, name: str = "origin") -> str:
    """Return a browser-style origin for an http(s) URL, dropping default port."""
    value = value.strip()
    if not value:
        raise ConfigError(f"{name} is required")
    try:
        parts = urllib.parse.urlsplit(value)
        port = parts.port
    except ValueError:
        raise ConfigError(f"{name} must be a valid origin") from None
    if parts.scheme.lower() not in {"http", "https"} or not parts.hostname:
        raise ConfigError(f"{name} must be an http(s) origin")
    if parts.username is not None or parts.password is not None:
        raise ConfigError(f"{name} must not contain credentials")
    if "\\" in value:
        raise ConfigError(f"{name} must be a valid origin")
    if parts.path not in {"", "/"} or parts.query or parts.fragment:
        raise ConfigError(f"{name} must be an origin without a path, query, or fragment")
    scheme = parts.scheme.lower()
    host = parts.hostname.lower()
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    if port is None or (scheme == "http" and port == 80) or (
        scheme == "https" and port == 443
    ):
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port}"


def origin_for_url(value: str) -> str:
    """Return the normalized origin of an absolute URL, or raise ValueError."""
    try:
        parts = urllib.parse.urlsplit(value)
        port = parts.port
    except ValueError as exc:
        raise ValueError("invalid URL") from exc
    if parts.scheme.lower() not in {"http", "https"} or not parts.hostname:
        raise ValueError("not an http(s) URL")
    if parts.username is not None or parts.password is not None:
        raise ValueError("URL credentials are not allowed")
    if "\\" in value:
        raise ValueError("backslashes are not allowed")
    scheme = parts.scheme.lower()
    host = parts.hostname.lower()
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    if port is None or (scheme == "http" and port == 80) or (
        scheme == "https" and port == 443
    ):
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port}"


def add_query_params(url: str, params: Iterable[tuple[str, str]]) -> str:
    """Add parameters while replacing the reserved auth result parameters."""
    parts = urllib.parse.urlsplit(url)
    existing = [
        (key, value)
        for key, value in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        if key not in {"auth", "auth_error"}
    ]
    query = urllib.parse.urlencode(existing + list(params))
    return urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, parts.path, query, parts.fragment)
    )


def _sanitize_text(value: str, maximum: int) -> str:
    cleaned = "".join(
        ch for ch in value if ord(ch) >= 32 and ord(ch) != 127
    )
    cleaned = " ".join(cleaned.split())
    return cleaned[:maximum]


def compact_json(value: Mapping[str, Any]) -> str:
    """Return compact ASCII JSON that cannot terminate an HTML comment."""
    encoded = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    return (
        encoded.replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
    )


def _is_control_code(code: int) -> bool:
    return code < 32 or 0x7F <= code <= 0x9F


def strip_control(value: str) -> str:
    return "".join(
        ch
        for ch in value
        if not _is_control_code(ord(ch))
        and not 0xD800 <= ord(ch) <= 0xDFFF
    )


def _clean_quote_text_value(value: str, *, allow_newlines: bool) -> str:
    cleaned: list[str] = []
    for ch in value:
        code = ord(ch)
        if allow_newlines and ch == "\n":
            cleaned.append(ch)
            continue
        if _is_control_code(code) or 0xD800 <= code <= 0xDFFF:
            continue
        cleaned.append(ch)
    return "".join(cleaned).strip()


def _clean_quote_field(
    value: Any, label: str, maximum: int, *, allow_newlines: bool
) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise APIError(
            400, "invalid_request", f"quote.{label} must be a string."
        )
    cleaned = _clean_quote_text_value(value, allow_newlines=allow_newlines)
    if len(cleaned) > maximum:
        raise APIError(
            400,
            "invalid_request",
            f"quote.{label} must be at most {maximum} characters.",
        )
    return cleaned


def validate_quote_metadata(value: Any) -> Optional[dict[str, Any]]:
    """Validate optional selected-text metadata from a request or marker."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise APIError(400, "invalid_request", "quote must be an object or null.")
    text = _clean_quote_field(
        value.get("text"),
        "text",
        MAX_QUOTE_TEXT_CHARS,
        allow_newlines=True,
    )
    if not text:
        raise APIError(
            400,
            "invalid_request",
            "quote.text must contain between 1 and "
            f"{MAX_QUOTE_TEXT_CHARS} characters.",
        )
    prefix = _clean_quote_field(
        value.get("prefix"),
        "prefix",
        MAX_QUOTE_CONTEXT_CHARS,
        allow_newlines=False,
    )
    suffix = _clean_quote_field(
        value.get("suffix"),
        "suffix",
        MAX_QUOTE_CONTEXT_CHARS,
        allow_newlines=False,
    )
    heading = _clean_quote_field(
        value.get("heading"),
        "heading",
        MAX_QUOTE_HEADING_CHARS,
        allow_newlines=False,
    )
    offset = value.get("offset", 0)
    if offset is None:
        offset = 0
    if isinstance(offset, bool) or not isinstance(offset, int):
        raise APIError(
            400,
            "invalid_request",
            f"quote.offset must be an integer between 0 and {MAX_QUOTE_OFFSET}.",
        )
    if offset < 0 or offset > MAX_QUOTE_OFFSET:
        raise APIError(
            400,
            "invalid_request",
            f"quote.offset must be an integer between 0 and {MAX_QUOTE_OFFSET}.",
        )
    return {
        "text": text,
        "prefix": prefix,
        "suffix": suffix,
        "offset": offset,
        "heading": heading,
    }


def _quote_from_marker(value: Any) -> Optional[dict[str, Any]]:
    try:
        return validate_quote_metadata(value)
    except APIError:
        return None


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def parse_comment_meta(body: str) -> tuple[str, dict[str, Any]]:
    """Parse the last valid metadata marker and strip every marker."""
    visibility = "public"
    effect = "off"
    submission: Optional[str] = None
    quote: Optional[dict[str, Any]] = None
    for match in META_MARKER_RE.finditer(body):
        try:
            candidate = json.loads(match.group(1))
        except (TypeError, ValueError):
            continue
        if not isinstance(candidate, dict):
            continue
        if candidate.get("version") != 1:
            continue
        candidate_visibility = candidate.get("visibility")
        candidate_effect = candidate.get("effect")
        if not isinstance(candidate_visibility, str) or candidate_visibility not in {
            "public",
            "commenter",
            "blogger",
        }:
            continue
        if not isinstance(candidate_effect, str) or candidate_effect not in {
            "off",
            "subtle",
            "strong",
        }:
            continue
        visibility = candidate_visibility
        effect = candidate_effect
        candidate_submission = candidate.get("submission")
        submission = (
            candidate_submission
            if isinstance(candidate_submission, str)
            and SUBMISSION_RE.fullmatch(candidate_submission)
            else None
        )
        quote = _quote_from_marker(candidate.get("quote"))
    cleaned = META_MARKER_STRIP_RE.sub("", body).strip()
    return cleaned, {
        "visibility": visibility,
        "effect": effect,
        "submission": submission,
        "quote": quote,
    }


def issue_title(comment_id: str, title: Optional[str]) -> str:
    prefix = f"[threadline:{comment_id}] "
    cleaned = _sanitize_text(title or MAX_ISSUE_TITLE_FALLBACK, MAX_ISSUE_TITLE_CHARS)
    if not cleaned:
        cleaned = MAX_ISSUE_TITLE_FALLBACK
    available = max(1, MAX_ISSUE_TITLE_CHARS - len(prefix))
    return f"{prefix}{cleaned[:available]}"


def issue_body(comment_id: str, title: Optional[str], article_url: str) -> str:
    display_title = _sanitize_text(title or MAX_ISSUE_TITLE_FALLBACK, 200) or (
        MAX_ISSUE_TITLE_FALLBACK
    )
    return (
        f"<!-- threadline-comment-id: {comment_id} -->\n"
        f"# {display_title}\n\n"
        f"Article: {article_url}\n\n"
        "This Issue stores comments, reactions, and optional attachment links "
        "for the article above. All of it is public on GitHub and through the "
        "GitHub API. Page display filters do not provide privacy.\n\n"
        "_This Issue is managed by Threadline._\n"
    )


def comment_marker(
    visibility: str,
    effect: str,
    submission: str,
    quote: Optional[Mapping[str, Any]] = None,
) -> str:
    metadata: dict[str, Any] = {
        "version": 1,
        "visibility": visibility,
        "effect": effect,
        "submission": submission,
    }
    if quote is not None:
        metadata["quote"] = dict(quote)
    return "<!-- threadline-meta " + compact_json(metadata) + " -->"


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    public_base_url: str
    site_origins: tuple[str, ...]
    cookie_secure: bool
    cookie_samesite: str
    comments_repository: str
    repo_owner: str
    repo_name: str
    blogger_login: str
    issue_label: Optional[str]
    database_path: str
    github_api_base: str
    github_oauth_authorize_url: str
    github_oauth_token_url: str
    github_client_id: str
    github_client_secret: str
    github_oauth_scope: str
    github_read_token: Optional[str]
    session_ttl_seconds: int
    attachments_mode: str
    attachments_dir: Optional[str]
    attachments_public_base_url: str
    attachments_http_url: Optional[str]
    attachments_http_token: Optional[str]
    attachments_max_bytes: int
    attachments_allowed_types: tuple[str, ...]

    @property
    def auth_configured(self) -> bool:
        return bool(self.github_client_id and self.github_client_secret)

    @property
    def callback_url(self) -> str:
        return f"{self.public_base_url}/api/auth/callback"

    @property
    def public_path_prefix(self) -> str:
        return urllib.parse.urlsplit(self.public_base_url).path.rstrip("/")

    @property
    def session_cookie_path(self) -> str:
        return f"{self.public_path_prefix}/" if self.public_path_prefix else "/"

    @property
    def oauth_cookie_path(self) -> str:
        return f"{self.public_path_prefix}/api/auth"

    def allows_origin(self, origin: str) -> bool:
        return origin in self.site_origins

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Config":
        def required(name: str) -> str:
            value = env.get(name, "").strip()
            if not value:
                raise ConfigError(f"{name} is required")
            return value

        host = env.get("HOST", "127.0.0.1").strip() or "127.0.0.1"
        port = _env_int(env.get("PORT", "8787"), "PORT", 1, 65535)

        public_base_url = required("PUBLIC_BASE_URL").rstrip("/")
        _parse_url(public_base_url, "PUBLIC_BASE_URL")

        origins_value = required("SITE_ORIGINS")
        origins = []
        for piece in origins_value.split(","):
            piece = piece.strip()
            if not piece:
                continue
            origin = normalize_origin(piece, "SITE_ORIGINS entry")
            if origin not in origins:
                origins.append(origin)
        if not origins:
            raise ConfigError("SITE_ORIGINS must contain at least one origin")

        cookie_secure = _env_bool(
            env.get("COOKIE_SECURE", "false"), "COOKIE_SECURE"
        )
        cookie_samesite_raw = env.get("COOKIE_SAMESITE", "Lax").strip().lower()
        samesite_map = {"lax": "Lax", "strict": "Strict", "none": "None"}
        if cookie_samesite_raw not in samesite_map:
            raise ConfigError("COOKIE_SAMESITE must be Lax, Strict, or None")
        cookie_samesite = samesite_map[cookie_samesite_raw]
        if cookie_samesite == "None" and not cookie_secure:
            raise ConfigError("COOKIE_SAMESITE=None requires COOKIE_SECURE=true")

        repository = required("COMMENTS_REPOSITORY")
        if not REPOSITORY_RE.match(repository):
            raise ConfigError("COMMENTS_REPOSITORY must have the form owner/repo")
        owner, repo = repository.split("/", 1)

        blogger_login = required("BLOGGER_GITHUB_LOGIN")
        if not LOGIN_RE.match(blogger_login):
            raise ConfigError("BLOGGER_GITHUB_LOGIN is not a valid GitHub login")

        issue_label_raw = env.get("ISSUE_LABEL", "").strip()
        issue_label: Optional[str] = None
        if issue_label_raw:
            issue_label = _sanitize_text(issue_label_raw, 100)
            if not issue_label:
                raise ConfigError("ISSUE_LABEL must not be blank")

        database_path = required("DATABASE_PATH")
        try:
            database_path = str(pathlib.Path(database_path).expanduser().resolve())
        except (OSError, ValueError):
            raise ConfigError("DATABASE_PATH is not a usable path") from None

        github_api_base = (
            env.get("GITHUB_API_BASE", "https://api.github.com").strip().rstrip("/")
        )
        if not github_api_base:
            raise ConfigError("GITHUB_API_BASE is required")
        _parse_url(github_api_base, "GITHUB_API_BASE")

        authorize_url = env.get(
            "GITHUB_OAUTH_AUTHORIZE_URL",
            "https://github.com/login/oauth/authorize",
        ).strip()
        token_url = env.get(
            "GITHUB_OAUTH_TOKEN_URL",
            "https://github.com/login/oauth/access_token",
        ).strip()
        _parse_url(authorize_url, "GITHUB_OAUTH_AUTHORIZE_URL")
        _parse_url(token_url, "GITHUB_OAUTH_TOKEN_URL")

        client_id = env.get("GITHUB_CLIENT_ID", "").strip()
        client_secret = env.get("GITHUB_CLIENT_SECRET", "").strip()
        if bool(client_id) != bool(client_secret):
            raise ConfigError(
                "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together"
            )
        if any(
            ord(ch) < 32 or ord(ch) == 127 for ch in client_id + client_secret
        ):
            raise ConfigError("OAuth client credentials contain invalid characters")

        scope = env.get("GITHUB_OAUTH_SCOPE", "").strip()
        read_token_raw = env.get("GITHUB_READ_TOKEN", "").strip()
        read_token = read_token_raw or None
        if read_token and any(ord(ch) < 32 or ord(ch) == 127 for ch in read_token):
            raise ConfigError("GITHUB_READ_TOKEN contains invalid characters")

        session_ttl = _env_int(
            env.get("SESSION_TTL_SECONDS", "28800"),
            "SESSION_TTL_SECONDS",
            1,
            60 * 60 * 24 * 365,
        )

        attachments_mode = env.get("ATTACHMENTS_MODE", "disabled").strip().lower()
        if attachments_mode not in {"disabled", "local", "http"}:
            raise ConfigError(
                "ATTACHMENTS_MODE must be disabled, local, or http"
            )
        attachments_dir_raw = env.get("ATTACHMENTS_DIR", "").strip()
        attachments_dir: Optional[str] = None
        if attachments_mode == "local":
            if not attachments_dir_raw:
                raise ConfigError("ATTACHMENTS_DIR is required when ATTACHMENTS_MODE=local")
            try:
                attachments_dir = str(
                    pathlib.Path(attachments_dir_raw).expanduser().resolve()
                )
            except (OSError, ValueError):
                raise ConfigError("ATTACHMENTS_DIR is not a usable path") from None

        attachments_public_raw = env.get(
            "ATTACHMENTS_PUBLIC_BASE_URL", ""
        ).strip().rstrip("/")
        if attachments_public_raw:
            _parse_url(attachments_public_raw, "ATTACHMENTS_PUBLIC_BASE_URL")
        else:
            attachments_public_raw = public_base_url

        http_url_raw = env.get("ATTACHMENTS_HTTP_URL", "").strip()
        if attachments_mode == "http":
            if not http_url_raw:
                raise ConfigError("ATTACHMENTS_HTTP_URL is required when ATTACHMENTS_MODE=http")
            _parse_url(http_url_raw, "ATTACHMENTS_HTTP_URL")
        http_token = env.get("ATTACHMENTS_HTTP_TOKEN", "").strip() or None
        if http_token and any(ord(ch) < 32 or ord(ch) == 127 for ch in http_token):
            raise ConfigError("ATTACHMENTS_HTTP_TOKEN contains invalid characters")

        max_bytes = _env_int(
            env.get("ATTACHMENTS_MAX_BYTES", "5242880"),
            "ATTACHMENTS_MAX_BYTES",
            1,
            100 * 1024 * 1024,
        )
        allowed_raw = env.get(
            "ATTACHMENTS_ALLOWED_TYPES", ",".join(DEFAULT_ALLOWED_TYPES)
        ).strip()
        if not allowed_raw:
            allowed_raw = ",".join(DEFAULT_ALLOWED_TYPES)
        allowed_types: list[str] = []
        for piece in allowed_raw.split(","):
            mime = piece.strip().lower()
            if not mime:
                continue
            if not MIME_RE.fullmatch(mime):
                raise ConfigError("ATTACHMENTS_ALLOWED_TYPES contains an invalid MIME type")
            if mime not in ATTACHMENT_TYPE_RULES:
                raise ConfigError(
                    f"ATTACHMENTS_ALLOWED_TYPES contains unsupported or unsafe type: {mime}"
                )
            if mime not in allowed_types:
                allowed_types.append(mime)
        if not allowed_types:
            raise ConfigError("ATTACHMENTS_ALLOWED_TYPES must contain at least one type")
        if any(t in {"image/svg+xml", "text/html", "application/xhtml+xml"} for t in allowed_types):
            raise ConfigError("SVG and HTML attachment types are not allowed")

        return cls(
            host=host,
            port=port,
            public_base_url=public_base_url,
            site_origins=tuple(origins),
            cookie_secure=cookie_secure,
            cookie_samesite=cookie_samesite,
            comments_repository=repository,
            repo_owner=owner,
            repo_name=repo,
            blogger_login=blogger_login,
            issue_label=issue_label,
            database_path=database_path,
            github_api_base=github_api_base,
            github_oauth_authorize_url=authorize_url,
            github_oauth_token_url=token_url,
            github_client_id=client_id,
            github_client_secret=client_secret,
            github_oauth_scope=scope,
            github_read_token=read_token,
            session_ttl_seconds=session_ttl,
            attachments_mode=attachments_mode,
            attachments_dir=attachments_dir,
            attachments_public_base_url=attachments_public_raw,
            attachments_http_url=http_url_raw or None,
            attachments_http_token=http_token,
            attachments_max_bytes=max_bytes,
            attachments_allowed_types=tuple(allowed_types),
        )


def _decode_double_quoted_env(value: str) -> str:
    escapes = {
        "n": "\n",
        "r": "\r",
        "t": "\t",
        "\\": "\\",
        '"': '"',
        "'": "'",
    }
    result: list[str] = []
    index = 0
    while index < len(value):
        character = value[index]
        if character == "\\" and index + 1 < len(value):
            following = value[index + 1]
            if following in escapes:
                result.append(escapes[following])
                index += 2
                continue
            result.append(character)
            index += 1
            continue
        result.append(character)
        index += 1
    return "".join(result)


def load_env_file(path: str) -> dict[str, str]:
    """Parse a small .env file without evaluating shell syntax."""
    values: dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            lines = handle.readlines()
    except OSError as exc:
        raise ConfigError(f"Could not read env file: {exc.strerror or 'I/O error'}") from None
    for line_number, raw in enumerate(lines, start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ConfigError(f"Invalid env file entry on line {line_number}")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            quote = value[0]
            inner = value[1:-1]
            if quote == "'":
                value = inner
            else:
                # Support common escapes only.  Do not evaluate commands or
                # interpolate variables.
                value = _decode_double_quoted_env(inner)
        else:
            # Allow a trailing comment in an unquoted value when separated by
            # whitespace, but keep URL fragments intact.
            hash_at = value.find(" #")
            if hash_at >= 0:
                value = value[:hash_at].rstrip()
        values[key] = value
    return values


class SessionStore:
    def __init__(self, ttl_seconds: int) -> None:
        self.ttl_seconds = ttl_seconds
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def create(
        self,
        login: str,
        name: str,
        avatar_url: str,
        html_url: str,
        access_token: str,
    ) -> "Session":
        session = Session(
            token=secrets.token_urlsafe(48),
            csrf=secrets.token_urlsafe(32),
            login=login,
            name=name or login,
            avatar_url=avatar_url,
            url=html_url,
            access_token=access_token,
            created_at=time.time(),
            expires_at=time.time() + self.ttl_seconds,
        )
        with self._lock:
            self._prune_locked()
            self._sessions[session.token] = session
        return session

    def get(self, token: Optional[str]) -> Optional["Session"]:
        if not token:
            return None
        now = time.time()
        with self._lock:
            session = self._sessions.get(token)
            if session is None:
                return None
            if session.expires_at <= now:
                self._sessions.pop(token, None)
                return None
            return session

    def delete(self, token: Optional[str]) -> None:
        if not token:
            return
        with self._lock:
            self._sessions.pop(token, None)

    def _prune_locked(self) -> None:
        now = time.time()
        expired = [key for key, value in self._sessions.items() if value.expires_at <= now]
        for key in expired:
            self._sessions.pop(key, None)


@dataclass
class Session:
    token: str
    csrf: str
    login: str
    name: str
    avatar_url: str
    url: str
    access_token: str
    created_at: float
    expires_at: float

    def viewer_json(self) -> dict[str, Any]:
        return {
            "login": self.login,
            "name": self.name,
            "avatarUrl": self.avatar_url,
            "url": self.url,
        }


class OAuthStateStore:
    def __init__(self) -> None:
        self._states: dict[str, tuple[str, str, float]] = {}
        self._lock = threading.Lock()

    def create(self, return_to: str) -> tuple[str, str]:
        state = secrets.token_urlsafe(32)
        cookie_value = secrets.token_urlsafe(32)
        now = time.time()
        with self._lock:
            self._prune_locked(now)
            # Bound memory used by abandoned sign-in attempts.
            if len(self._states) >= 5000:
                try:
                    oldest = next(iter(self._states))
                    self._states.pop(oldest, None)
                except StopIteration:
                    pass
            self._states[state] = (cookie_value, return_to, now + OAUTH_STATE_TTL_SECONDS)
        return state, cookie_value

    def consume(self, state: Optional[str], cookie_value: Optional[str]) -> Optional[str]:
        if not state or not cookie_value:
            return None
        now = time.time()
        with self._lock:
            entry = self._states.get(state)
            if entry is None:
                return None
            expected_cookie, return_to, expires_at = entry
            if expires_at <= now:
                self._states.pop(state, None)
                return None
            if not hmac.compare_digest(expected_cookie, cookie_value):
                return None
            self._states.pop(state, None)
            return return_to

    def _prune_locked(self, now: float) -> None:
        expired = [key for key, value in self._states.items() if value[2] <= now]
        for key in expired:
            self._states.pop(key, None)


class Database:
    def __init__(self, path: str) -> None:
        self.path = path
        parent = os.path.dirname(os.path.abspath(path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self.path, timeout=10.0, isolation_level=None
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    @contextlib.contextmanager
    def _connection(self):
        connection = self._connect()
        try:
            yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connection() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS article_issues (
                    comment_id TEXT PRIMARY KEY,
                    issue_number INTEGER NOT NULL,
                    issue_url TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS attachments (
                    token TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    mime TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    path TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )

    def get_issue(self, comment_id: str) -> Optional["IssueRef"]:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT issue_number, issue_url FROM article_issues WHERE comment_id = ?",
                (comment_id,),
            ).fetchone()
        if row is None:
            return None
        return IssueRef(number=int(row["issue_number"]), url=str(row["issue_url"]))

    def save_issue(self, comment_id: str, issue: "IssueRef") -> "IssueRef":
        now = now_iso()
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    """
                    INSERT INTO article_issues
                        (comment_id, issue_number, issue_url, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(comment_id) DO NOTHING
                    """,
                    (comment_id, issue.number, issue.url, now, now),
                )
                connection.execute("COMMIT")
            except BaseException:
                connection.execute("ROLLBACK")
                raise
            row = connection.execute(
                "SELECT issue_number, issue_url FROM article_issues WHERE comment_id = ?",
                (comment_id,),
            ).fetchone()
        if row is None:
            # This should only be observable if the database is damaged.
            raise RuntimeError("failed to persist article issue mapping")
        return IssueRef(number=int(row["issue_number"]), url=str(row["issue_url"]))

    def save_attachment(self, record: Mapping[str, Any]) -> None:
        with self._connection() as connection:
            connection.execute(
                """
                INSERT INTO attachments (token, name, mime, size, path, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    record["token"],
                    record["name"],
                    record["mime"],
                    record["size"],
                    record["path"],
                    record["created_at"],
                ),
            )

    def get_attachment(self, token: str) -> Optional[sqlite3.Row]:
        with self._connection() as connection:
            return connection.execute(
                "SELECT token, name, mime, size, path, created_at FROM attachments WHERE token = ?",
                (token,),
            ).fetchone()


@dataclass(frozen=True)
class IssueRef:
    number: int
    url: str


def _github_retry_after(headers: Mapping[str, str]) -> Optional[int]:
    raw_retry = headers.get("retry-after")
    if raw_retry:
        try:
            return max(0, int(str(raw_retry).strip()))
        except ValueError:
            pass
    reset = headers.get("x-ratelimit-reset")
    if reset:
        try:
            return max(0, int(float(str(reset))) - int(time.time()))
        except (TypeError, ValueError):
            pass
    return None


def _github_error(status: int, headers: Mapping[str, str], raw_body: bytes) -> GitHubAPIError:
    message = ""
    try:
        payload = json.loads(raw_body.decode("utf-8", "replace"))
        if isinstance(payload, dict):
            message = str(payload.get("message") or "")
    except (TypeError, ValueError):
        pass
    message = strip_control(message)[:300]
    remaining = str(headers.get("x-ratelimit-remaining", "") or "")
    retry_after = _github_retry_after(headers)
    is_rate_limit = status == 429 or (
        status == 403
        and (
            remaining == "0"
            or retry_after is not None
            or "rate limit" in message.lower()
        )
    )
    if status == 401:
        return GitHubAPIError(
            401,
            "session_expired",
            "Your GitHub authorization is no longer valid. Sign in with GitHub again.",
        )
    if is_rate_limit:
        if retry_after is not None:
            detail = f" GitHub asks clients to retry in about {retry_after} seconds."
        else:
            detail = " Please wait and try again later."
        return GitHubAPIError(
            429,
            "rate_limited",
            "The GitHub API rate limit has been reached." + detail,
            retry_after=retry_after,
        )
    if status == 403:
        return GitHubAPIError(
            403,
            "permission",
            "GitHub denied permission. Check that the signed-in account can write "
            "Issues in the configured repository and that the GitHub App is installed "
            "there.",
        )
    if status == 404:
        return GitHubAPIError(
            404,
            "not_found",
            "The configured repository or Issue was not found or is not accessible.",
        )
    if status == 422:
        details = f" {message}" if message else ""
        return GitHubAPIError(
            422,
            "validation",
            "GitHub rejected the request during validation." + details,
        )
    if status >= 500 or status in {408, 502, 503, 504}:
        return GitHubAPIError(
            502,
            "github_unavailable",
            "GitHub is temporarily unavailable. Please try again shortly.",
        )
    return GitHubAPIError(
        502,
        "github_error",
        "GitHub returned an unexpected response. Please try again later.",
    )


class GitHubClient:
    """Minimal GitHub REST client using urllib and caller-supplied tokens."""

    def __init__(self, config: Config) -> None:
        self.config = config

    def _request(
        self,
        method: str,
        path: str,
        token: Optional[str],
        *,
        query: Optional[Mapping[str, Any]] = None,
        payload: Optional[Mapping[str, Any]] = None,
        max_response_bytes: int = 5 * 1024 * 1024,
    ) -> tuple[Any, Mapping[str, str]]:
        url = self.config.github_api_base + path
        if query:
            encoded = urllib.parse.urlencode(
                {key: value for key, value in query.items() if value is not None}
            )
            url = f"{url}?{encoded}"
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        body: Optional[bytes] = None
        if payload is not None:
            body = json.dumps(
                payload, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(
                request, timeout=GITHUB_TIMEOUT_SECONDS
            ) as response:
                response_headers = {
                    str(key).lower(): str(value)
                    for key, value in response.headers.items()
                }
                if response.status < 200 or response.status >= 300:
                    raw = response.read(65536)
                    raise _github_error(response.status, response_headers, raw)
                raw = response.read(max_response_bytes + 1)
        except urllib.error.HTTPError as exc:
            response_headers = (
                {
                    str(key).lower(): str(value)
                    for key, value in exc.headers.items()
                }
                if exc.headers
                else {}
            )
            try:
                raw = exc.read(65536)
            except Exception:
                raw = b""
            finally:
                exc.close()
            raise _github_error(exc.code, response_headers, raw) from None
        except GitHubAPIError:
            raise
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise GitHubAPIError(
                502,
                "github_unavailable",
                "Could not reach GitHub. Check network connectivity and try again.",
            ) from None
        if len(raw) > max_response_bytes:
            raise GitHubAPIError(
                502,
                "github_unavailable",
                "GitHub returned an unexpectedly large response.",
            )
        if not raw:
            return None, response_headers
        try:
            return json.loads(raw.decode("utf-8")), response_headers
        except (UnicodeDecodeError, ValueError):
            raise GitHubAPIError(
                502,
                "github_unavailable",
                "GitHub returned an unreadable response.",
            ) from None

    def find_issue(self, comment_id: str, token: Optional[str]) -> Optional[IssueRef]:
        query = (
            f'repo:{self.config.comments_repository} is:issue in:title '
            f'"threadline:{comment_id}"'
        )
        payload, _ = self._request(
            "GET",
            "/search/issues",
            token,
            query={"q": query, "per_page": 100},
        )
        if not isinstance(payload, dict):
            return None
        items = payload.get("items")
        if not isinstance(items, list):
            return None
        prefix = f"[threadline:{comment_id}]"
        numbers: list[int] = []
        urls: dict[int, str] = {}
        for item in items:
            if not isinstance(item, dict):
                continue
            title = item.get("title")
            number = item.get("number")
            if not isinstance(title, str) or not isinstance(number, int):
                continue
            if not title.startswith(prefix):
                continue
            numbers.append(number)
            html_url = item.get("html_url")
            if isinstance(html_url, str) and html_url:
                urls[number] = html_url
        if not numbers:
            return None
        number = min(numbers)
        return IssueRef(
            number=number,
            url=urls.get(number)
            or f"https://github.com/{self.config.comments_repository}/issues/{number}",
        )

    def create_issue(
        self,
        comment_id: str,
        title: Optional[str],
        article_url: str,
        token: str,
    ) -> IssueRef:
        payload: dict[str, Any] = {
            "title": issue_title(comment_id, title),
            "body": issue_body(comment_id, title, article_url),
        }
        if self.config.issue_label:
            payload["labels"] = [self.config.issue_label]
        response, _ = self._request(
            "POST",
            f"/repos/{self.config.repo_owner}/{self.config.repo_name}/issues",
            token,
            payload=payload,
        )
        if not isinstance(response, dict) or not isinstance(response.get("number"), int):
            raise GitHubAPIError(
                502, "github_unavailable", "GitHub did not return a valid Issue."
            )
        html_url = response.get("html_url")
        if not isinstance(html_url, str) or not html_url:
            html_url = (
                f"https://github.com/{self.config.comments_repository}/issues/"
                f"{response['number']}"
            )
        return IssueRef(number=response["number"], url=html_url)

    def list_comments(
        self, issue_number: int, token: Optional[str]
    ) -> tuple[list[dict[str, Any]], bool]:
        items: list[dict[str, Any]] = []
        truncated = False
        pages = (MAX_PAGINATED_ITEMS + PAGE_SIZE - 1) // PAGE_SIZE
        for page in range(1, pages + 1):
            payload, _ = self._request(
                "GET",
                f"/repos/{self.config.repo_owner}/{self.config.repo_name}"
                f"/issues/{issue_number}/comments",
                token,
                query={"per_page": PAGE_SIZE, "page": page},
            )
            if not isinstance(payload, list):
                raise GitHubAPIError(
                    502,
                    "github_unavailable",
                    "GitHub returned an invalid comment list.",
                )
            items.extend(item for item in payload if isinstance(item, dict))
            if len(payload) < PAGE_SIZE:
                break
            if page == pages:
                truncated = True
        return items, truncated

    def list_reactions(
        self, issue_number: int, token: Optional[str]
    ) -> tuple[list[dict[str, Any]], bool]:
        items: list[dict[str, Any]] = []
        truncated = False
        pages = (MAX_PAGINATED_ITEMS + PAGE_SIZE - 1) // PAGE_SIZE
        for page in range(1, pages + 1):
            payload, _ = self._request(
                "GET",
                f"/repos/{self.config.repo_owner}/{self.config.repo_name}"
                f"/issues/{issue_number}/reactions",
                token,
                query={"per_page": PAGE_SIZE, "page": page},
            )
            if not isinstance(payload, list):
                raise GitHubAPIError(
                    502,
                    "github_unavailable",
                    "GitHub returned an invalid reaction list.",
                )
            items.extend(item for item in payload if isinstance(item, dict))
            if len(payload) < PAGE_SIZE:
                break
            if page == pages:
                truncated = True
        return items, truncated

    def create_comment(self, issue_number: int, body: str, token: str) -> dict[str, Any]:
        payload, _ = self._request(
            "POST",
            f"/repos/{self.config.repo_owner}/{self.config.repo_name}"
            f"/issues/{issue_number}/comments",
            token,
            payload={"body": body},
        )
        if not isinstance(payload, dict) or not isinstance(payload.get("id"), int):
            raise GitHubAPIError(
                502, "github_unavailable", "GitHub did not return a valid comment."
            )
        return payload

    def add_reaction(self, issue_number: int, content: str, token: str) -> None:
        self._request(
            "POST",
            f"/repos/{self.config.repo_owner}/{self.config.repo_name}"
            f"/issues/{issue_number}/reactions",
            token,
            payload={"content": content},
        )

    def delete_reaction(self, issue_number: int, reaction_id: int, token: str) -> None:
        self._request(
            "DELETE",
            f"/repos/{self.config.repo_owner}/{self.config.repo_name}"
            f"/issues/{issue_number}/reactions/{reaction_id}",
            token,
        )

    def get_user(self, token: str) -> dict[str, Any]:
        payload, _ = self._request("GET", "/user", token)
        if not isinstance(payload, dict) or not isinstance(payload.get("login"), str):
            raise GitHubAPIError(
                502, "github_unavailable", "GitHub did not return a valid user profile."
            )
        return payload


def _attachment_content_disposition(name: str, inline: bool) -> str:
    fallback = "".join(
        ch if (32 <= ord(ch) < 127 and ch not in {'"', "\\"}) else "_"
        for ch in name
    ) or "attachment"
    encoded = urllib.parse.quote(name, safe="")
    disposition = "inline" if inline else "attachment"
    return f'{disposition}; filename="{fallback}"; filename*=UTF-8\'\'{encoded}'


def _safe_filename(name: Optional[str]) -> str:
    base = (name or "attachment").replace("\\", "/").rsplit("/", 1)[-1]
    base = strip_control(base).strip().strip(".")
    if not base:
        base = "attachment"
    if len(base) > 200:
        suffix = pathlib.PurePath(base).suffix[:20]
        stem_limit = max(1, 200 - len(suffix))
        base = base[:stem_limit] + suffix
    return base


def _validate_attachment(
    data: bytes, filename: Optional[str], content_type: str, config: Config
) -> tuple[str, str]:
    if not data:
        raise AttachmentError(400, "invalid_request", "The attachment file is empty.")
    safe_name = _safe_filename(filename)
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    if not MIME_RE.fullmatch(mime) or mime not in config.attachments_allowed_types:
        raise AttachmentError(
            415,
            "invalid_type",
            "This attachment type is not allowed. Allowed types: "
            + ", ".join(config.attachments_allowed_types)
            + ".",
        )
    rule = ATTACHMENT_TYPE_RULES.get(mime)
    if rule is None:
        raise AttachmentError(415, "invalid_type", "This attachment type is not allowed.")
    extension = pathlib.PurePath(safe_name).suffix.lower()
    if extension not in rule["extensions"]:
        raise AttachmentError(
            415,
            "invalid_type",
            "The file extension does not match the declared attachment type.",
        )
    magic = rule["magic"]
    if magic is not None and not magic(data):
        raise AttachmentError(
            415, "invalid_type", "The file contents do not match the declared type."
        )
    if mime == "text/plain":
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise AttachmentError(
                415, "invalid_type", "Text attachments must be valid UTF-8."
            ) from None
        if "\x00" in text:
            raise AttachmentError(
                415, "invalid_type", "Text attachments must not contain NUL bytes."
            )
    if len(data) > config.attachments_max_bytes:
        raise AttachmentError(
            413,
            "too_large",
            f"The attachment exceeds the {config.attachments_max_bytes} byte limit.",
        )
    return safe_name, mime


class AttachmentService:
    def __init__(self, config: Config, database: Database) -> None:
        self.config = config
        self.database = database
        if config.attachments_mode == "local" and config.attachments_dir:
            os.makedirs(config.attachments_dir, mode=0o700, exist_ok=True)
            try:
                os.chmod(config.attachments_dir, 0o700)
            except OSError:
                pass

    @property
    def enabled(self) -> bool:
        return self.config.attachments_mode != "disabled"

    def upload(self, data: bytes, filename: Optional[str], content_type: str) -> dict[str, Any]:
        if not self.enabled:
            raise AttachmentError(
                503,
                "attachments_disabled",
                "Attachment storage is not configured on this server.",
            )
        safe_name, mime = _validate_attachment(data, filename, content_type, self.config)
        if len(data) > self.config.attachments_max_bytes:
            raise AttachmentError(
                413,
                "too_large",
                f"The attachment exceeds the {self.config.attachments_max_bytes} byte limit.",
            )
        if self.config.attachments_mode == "local":
            url = self._store_local(data, safe_name, mime)
        else:
            url = self._store_http(data, safe_name, mime)
        return {
            "url": url,
            "name": safe_name,
            "size": len(data),
            "mime": mime,
            "scope": "public",
        }

    def _store_local(self, data: bytes, name: str, mime: str) -> str:
        assert self.config.attachments_dir is not None
        token = secrets.token_urlsafe(24)
        path = os.path.join(self.config.attachments_dir, token)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(path, flags, 0o640)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
        except OSError:
            try:
                os.unlink(path)
            except OSError:
                pass
            raise AttachmentError(
                502, "upload_failed", "Could not store the attachment."
            ) from None
        try:
            self.database.save_attachment(
                {
                    "token": token,
                    "name": name,
                    "mime": mime,
                    "size": len(data),
                    "path": path,
                    "created_at": now_iso(),
                }
            )
        except Exception:
            try:
                os.unlink(path)
            except OSError:
                pass
            raise AttachmentError(
                502, "upload_failed", "Could not record the attachment."
            ) from None
        return f"{self.config.attachments_public_base_url}/uploads/{token}"

    def _store_http(self, data: bytes, name: str, mime: str) -> str:
        assert self.config.attachments_http_url is not None
        boundary = "----threadline" + secrets.token_hex(16)
        ascii_name = "".join(
            ch if 32 <= ord(ch) < 127 and ch not in {'"', "\\"} else "_"
            for ch in name
        ) or "attachment"
        encoded_name = urllib.parse.quote(name, safe="")
        headers = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{ascii_name}"; '
            f"filename*=UTF-8''{encoded_name}\r\n"
            f"Content-Type: {mime}\r\n\r\n"
        ).encode("utf-8")
        body = headers + data + f"\r\n--{boundary}--\r\n".encode("ascii")
        request_headers = {
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        }
        if self.config.attachments_http_token:
            request_headers["Authorization"] = (
                f"Bearer {self.config.attachments_http_token}"
            )
        request = urllib.request.Request(
            self.config.attachments_http_url,
            data=body,
            headers=request_headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(
                request, timeout=ATTACHMENT_TIMEOUT_SECONDS
            ) as response:
                raw = response.read(256 * 1024 + 1)
                status = response.status
        except urllib.error.HTTPError as exc:
            exc.close()
            raise AttachmentError(
                502,
                "upload_failed",
                "The configured attachment storage rejected the upload.",
            ) from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise AttachmentError(
                502,
                "upload_failed",
                "The configured attachment storage could not be reached.",
            ) from None
        if status < 200 or status >= 300 or len(raw) > 256 * 1024:
            raise AttachmentError(
                502,
                "upload_failed",
                "The configured attachment storage returned an invalid response.",
            )
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise AttachmentError(
                502,
                "upload_failed",
                "The configured attachment storage did not return JSON.",
            ) from None
        url: Any = None
        if isinstance(payload, dict):
            url = payload.get("url")
            if url is None and isinstance(payload.get("attachment"), dict):
                url = payload["attachment"].get("url")
            if url is None and isinstance(payload.get("data"), dict):
                url = payload["data"].get("url")
        if not isinstance(url, str) or len(url) > MAX_ARTICLE_URL_CHARS:
            raise AttachmentError(
                502,
                "upload_failed",
                "The configured attachment storage did not return a valid URL.",
            )
        try:
            parts = urllib.parse.urlsplit(url)
            _ = parts.port
        except ValueError:
            parts = None
        if (
            parts is None
            or parts.scheme.lower() not in {"http", "https"}
            or not parts.netloc
            or parts.username is not None
            or parts.password is not None
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in url)
        ):
            raise AttachmentError(
                502,
                "upload_failed",
                "The configured attachment storage did not return a valid http(s) URL.",
            )
        return url


def parse_multipart_file(
    body: bytes, content_type: str, *, max_file_bytes: int
) -> tuple[Optional[str], str, bytes]:
    """Extract the ``file`` part from a multipart/form-data body.

    The parser is deliberately limited: one field is needed and the body is
    already bounded by the HTTP layer.  It keeps file bytes byte-for-byte.
    """
    message = email.message.Message()
    message["content-type"] = content_type
    if message.get_content_type().lower() != "multipart/form-data":
        raise AttachmentError(
            415, "invalid_type", "Expected multipart/form-data with a file field."
        )
    boundary = message.get_param("boundary")
    if not isinstance(boundary, str) or not boundary or len(boundary) > 200:
        raise AttachmentError(400, "invalid_multipart", "Missing multipart boundary.")
    try:
        boundary_bytes = boundary.encode("ascii")
    except UnicodeEncodeError:
        raise AttachmentError(
            400, "invalid_multipart", "Invalid multipart boundary."
        ) from None
    delimiter = b"--" + boundary_bytes

    def find_delimiter(start: int) -> tuple[int, bool, int]:
        position = start
        while True:
            index = body.find(delimiter, position)
            if index < 0:
                return -1, False, -1
            at_line_start = index == 0 or body[index - 2 : index] == b"\r\n"
            after = index + len(delimiter)
            if not at_line_start:
                position = index + 1
                continue
            if body[after : after + 2] == b"--":
                return index, True, after + 2
            if body[after : after + 2] == b"\r\n":
                return index, False, after + 2
            position = index + 1

    first, first_closing, after_first = find_delimiter(0)
    if first < 0 or first_closing:
        raise AttachmentError(400, "invalid_multipart", "Malformed multipart body.")
    cursor = after_first
    while True:
        next_index, closing, after_next = find_delimiter(cursor)
        if next_index < 0:
            raise AttachmentError(400, "invalid_multipart", "Malformed multipart body.")
        segment = body[cursor:next_index]
        if segment.endswith(b"\r\n"):
            segment = segment[:-2]
        if segment:
            header_blob, separator, content = segment.partition(b"\r\n\r\n")
            if not separator:
                raise AttachmentError(
                    400, "invalid_multipart", "Malformed multipart headers."
                )
            header_message = email.message.Message()
            for raw_line in header_blob.split(b"\r\n"):
                if b":" not in raw_line:
                    raise AttachmentError(
                        400, "invalid_multipart", "Malformed multipart headers."
                    )
                key, _, value = raw_line.partition(b":")
                try:
                    key_text = key.decode("ascii").strip()
                except UnicodeDecodeError:
                    key_text = key.decode("latin-1").strip()
                try:
                    # RFC 7578 says multipart form field names/filenames are
                    # normally UTF-8. Fall back to Latin-1 for older clients.
                    value_text = value.decode("utf-8").strip()
                except UnicodeDecodeError:
                    value_text = value.decode("latin-1").strip()
                if key_text.lower() in {"content-disposition", "content-type"}:
                    try:
                        header_message[key_text] = value_text
                    except Exception:
                        raise AttachmentError(
                            400, "invalid_multipart", "Malformed multipart headers."
                        ) from None
            if header_message.get_content_disposition() != "form-data":
                raise AttachmentError(
                    400, "invalid_multipart", "Invalid multipart disposition."
                )
            field_name = header_message.get_param("name", header="content-disposition")
            if field_name == "file":
                if len(content) > max_file_bytes:
                    raise AttachmentError(
                        413,
                        "too_large",
                        "The attachment exceeds the configured size limit.",
                    )
                filename = header_message.get_filename()
                part_content_type = header_message.get_content_type()
                return filename, part_content_type, content
        if closing:
            break
        cursor = after_next
    raise AttachmentError(400, "invalid_request", "The multipart file field is required.")


class Application:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.database = Database(config.database_path)
        self.github = GitHubClient(config)
        self.sessions = SessionStore(config.session_ttl_seconds)
        self.oauth_states = OAuthStateStore()
        self.attachments = AttachmentService(config, self.database)
        self._issue_locks = [threading.Lock() for _ in range(128)]
        self._submission_lock = threading.Lock()
        self._inflight_submissions: set[str] = set()

    def _issue_lock(self, comment_id: str) -> threading.Lock:
        digest = hashlib.sha256(comment_id.encode("utf-8")).digest()
        return self._issue_locks[digest[0] % len(self._issue_locks)]

    def _read_token(self, session: Optional[Session]) -> Optional[str]:
        return self.config.github_read_token or (
            session.access_token if session is not None else None
        )

    def resolve_issue_read(
        self, comment_id: str, session: Optional[Session]
    ) -> Optional[IssueRef]:
        mapping = self.database.get_issue(comment_id)
        if mapping is not None:
            return mapping
        with self._issue_lock(comment_id):
            mapping = self.database.get_issue(comment_id)
            if mapping is not None:
                return mapping
            found = self.github.find_issue(comment_id, self._read_token(session))
            if found is None:
                return None
            return self.database.save_issue(comment_id, found)

    def resolve_issue_write(
        self,
        comment_id: str,
        session: Session,
        title: Optional[str],
        article_url: str,
    ) -> IssueRef:
        """Resolve or create an Issue. The caller must hold the issue lock."""
        mapping = self.database.get_issue(comment_id)
        if mapping is not None:
            return mapping
        found = self.github.find_issue(comment_id, self._read_token(session))
        if found is not None:
            return self.database.save_issue(comment_id, found)
        created = self.github.create_issue(
            comment_id, title, article_url, session.access_token
        )
        return self.database.save_issue(comment_id, created)

    def resolve_issue_for_comment(
        self,
        comment_id: str,
        session: Session,
        title: Optional[str],
        article_url: str,
    ) -> tuple[IssueRef, list[dict[str, Any]]]:
        """Resolve or create an Issue, then read comments before the write.

        The pre-write read is always performed, including for a newly created
        Issue (where the list is expected to be empty). This keeps the
        duplicate-check path identical and fails safely before the comment
        write if GitHub cannot return the list. The caller must hold the issue
        lock.
        """
        read_token = self._read_token(session)
        mapping = self.database.get_issue(comment_id)
        if mapping is not None:
            issue = mapping
        else:
            found = self.github.find_issue(comment_id, read_token)
            if found is not None:
                issue = self.database.save_issue(comment_id, found)
            else:
                created = self.github.create_issue(
                    comment_id, title, article_url, session.access_token
                )
                issue = self.database.save_issue(comment_id, created)
        comments, _ = self.github.list_comments(issue.number, read_token)
        return issue, comments

    def comment_from_github(
        self, raw: Mapping[str, Any], viewer: Optional[Session]
    ) -> dict[str, Any]:
        author = raw.get("user") if isinstance(raw.get("user"), dict) else {}
        login = str(author.get("login") or "unknown")
        name = str(author.get("name") or login)
        avatar_url = str(author.get("avatar_url") or "")
        html_url = str(author.get("html_url") or "")
        raw_body = raw.get("body") if isinstance(raw.get("body"), str) else ""
        body, meta = parse_comment_meta(raw_body)
        is_author = bool(
            viewer is not None and viewer.login.lower() == login.lower()
        )
        return {
            "id": raw.get("id"),
            "author": {
                "login": login,
                "name": name,
                "avatarUrl": avatar_url,
                "url": html_url,
            },
            "body": body,
            "createdAt": str(raw.get("created_at") or ""),
            "updatedAt": str(raw.get("updated_at") or raw.get("created_at") or ""),
            "visibility": meta["visibility"],
            "effect": meta["effect"],
            "quote": meta["quote"],
            "isAuthor": is_author,
        }

    def visible_comments(
        self, comments: Iterable[Mapping[str, Any]], viewer: Optional[Session]
    ) -> list[dict[str, Any]]:
        visible: list[dict[str, Any]] = []
        for raw in comments:
            comment = self.comment_from_github(raw, viewer)
            visibility = comment["visibility"]
            if visibility == "public":
                visible.append(comment)
            elif viewer is None:
                continue
            elif visibility == "commenter":
                if comment["author"]["login"].lower() == viewer.login.lower():
                    visible.append(comment)
            elif visibility == "blogger":
                if viewer.login.lower() == self.config.blogger_login.lower():
                    visible.append(comment)
        visible.sort(
            key=lambda item: (
                str(item.get("createdAt") or ""),
                item.get("id") if isinstance(item.get("id"), int) else 0,
            )
        )
        return visible

    @staticmethod
    def find_comment_submission(
        comments: Iterable[Mapping[str, Any]], login: str, submission: str
    ) -> Optional[Mapping[str, Any]]:
        """Return this viewer's comment with the matching metadata submission."""
        target_login = login.lower()
        for raw in comments:
            author = raw.get("user") if isinstance(raw.get("user"), dict) else {}
            if str(author.get("login") or "").lower() != target_login:
                continue
            raw_body = raw.get("body") if isinstance(raw.get("body"), str) else ""
            _, meta = parse_comment_meta(raw_body)
            if meta.get("submission") == submission:
                return raw
        return None

    @staticmethod
    def reaction_snapshot(
        reactions: Iterable[Mapping[str, Any]], viewer: Optional[Session]
    ) -> dict[str, Any]:
        like = 0
        dislike = 0
        viewer_value: Optional[str] = None
        viewer_login = viewer.login.lower() if viewer is not None else None
        for reaction in reactions:
            content = reaction.get("content")
            if content == "+1":
                like += 1
            elif content == "-1":
                dislike += 1
            else:
                continue
            user = reaction.get("user") if isinstance(reaction.get("user"), dict) else {}
            login = str(user.get("login") or "").lower()
            if viewer_login is not None and login == viewer_login:
                if content == "+1" and viewer_value is None:
                    viewer_value = "like"
                elif content == "-1" and viewer_value is None:
                    viewer_value = "dislike"
        return {"like": like, "dislike": dislike, "viewer": viewer_value}

    def claim_submission(self, key: str) -> bool:
        """Claim only an in-flight key; completed retries use the marker."""
        with self._submission_lock:
            if key in self._inflight_submissions:
                return False
            self._inflight_submissions.add(key)
            return True

    def mark_submission_complete(self, key: str) -> None:
        with self._submission_lock:
            self._inflight_submissions.discard(key)

    def release_submission(self, key: str) -> None:
        with self._submission_lock:
            self._inflight_submissions.discard(key)

    def empty_article(self, comment_id: str) -> dict[str, Any]:
        return {
            "commentId": comment_id,
            "available": True,
            "issueNumber": None,
            "issueUrl": None,
            "comments": [],
            "commentCount": 0,
            "reactions": {"like": 0, "dislike": 0, "viewer": None},
        }

    def get_article(
        self, comment_id: str, viewer: Optional[Session]
    ) -> dict[str, Any]:
        issue = self.resolve_issue_read(comment_id, viewer)
        if issue is None:
            return self.empty_article(comment_id)
        token = self._read_token(viewer)
        raw_comments, _ = self.github.list_comments(issue.number, token)
        comments = self.visible_comments(raw_comments, viewer)
        reactions, _ = self.github.list_reactions(issue.number, token)
        return {
            "commentId": comment_id,
            "available": True,
            "issueNumber": issue.number,
            "issueUrl": issue.url,
            "comments": comments,
            "commentCount": len(comments),
            "reactions": self.reaction_snapshot(reactions, viewer),
        }


class ThreadlineHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], application: Application):
        self.application = application
        super().__init__(address, ThreadlineRequestHandler)


class ThreadlineRequestHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"Threadline/{APP_VERSION}"
    sys_version = ""

    @property
    def app(self) -> Application:
        return self.server.application  # type: ignore[attr-defined]

    def version_string(self) -> str:
        return self.server_version

    def log_request(self, code: Any = "-", size: Any = "-") -> None:
        try:
            path = urllib.parse.urlsplit(self.path).path
        except Exception:
            path = "-"
        LOG.info("%s %s %s", self.command, path, code)

    def log_message(self, format: str, *args: Any) -> None:
        # Never allow BaseHTTPRequestHandler to log raw request lines/queries.
        LOG.debug("HTTP server message")

    def log_error(self, format: str, *args: Any) -> None:
        LOG.warning("HTTP protocol error")

    def _dispatch(self, method: str) -> None:
        path = "/"
        self._response_started = False
        self._request_body_read = False
        try:
            parsed = urllib.parse.urlsplit(self.path)
            path = parsed.path
            if method == "GET":
                self._route_get(path, parsed)
            elif method == "POST":
                self._route_post(path)
            elif method == "OPTIONS":
                self._route_options(path)
            else:
                self._send_error(
                    APIError(405, "method_not_allowed", "HTTP method not allowed.")
                )
        except APIError as exc:
            if method not in {"GET", "HEAD", "OPTIONS"} and not self._request_body_read:
                # Do not reuse a connection whose request body was never
                # consumed; otherwise leftover bytes could be parsed as a
                # subsequent request.
                self.close_connection = True
            self._send_error(exc)
        except GitHubAPIError as exc:
            if method not in {"GET", "HEAD", "OPTIONS"} and not self._request_body_read:
                self.close_connection = True
            self._send_error(exc.as_api_error())
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as exc:  # Defensive: never leak exception text.
            LOG.error(
                "Unhandled server error for %s %s (%s)",
                method,
                path,
                type(exc).__name__,
            )
            try:
                self._send_error(
                    APIError(500, "internal_error", "An internal server error occurred.")
                )
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_OPTIONS(self) -> None:
        self._dispatch("OPTIONS")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_PATCH(self) -> None:
        self._dispatch("PATCH")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def _route_get(self, path: str, parsed: urllib.parse.SplitResult) -> None:
        if path == "/api/health":
            self._send_json(200, {"ok": True})
            return
        if path == "/api/session":
            self._handle_session()
            return
        if path == "/api/auth/github":
            self._handle_auth_start(parsed)
            return
        if path == "/api/auth/callback":
            self._handle_auth_callback(parsed)
            return
        match = re.fullmatch(r"/api/articles/([^/]+)", path)
        if match:
            comment_id = self._decode_segment(match.group(1))
            self._handle_get_article(comment_id)
            return
        match = re.fullmatch(r"/uploads/([^/]+)", path)
        if match:
            token = self._decode_segment(match.group(1))
            self._handle_attachment_serve(token)
            return
        raise APIError(404, "not_found", "Endpoint not found.")

    def _route_post(self, path: str) -> None:
        if path == "/api/auth/logout":
            self._handle_logout()
            return
        match = re.fullmatch(r"/api/articles/([^/]+)/comments", path)
        if match:
            comment_id = self._decode_segment(match.group(1))
            self._handle_create_comment(comment_id)
            return
        match = re.fullmatch(r"/api/articles/([^/]+)/reaction", path)
        if match:
            comment_id = self._decode_segment(match.group(1))
            self._handle_reaction(comment_id)
            return
        if path == "/api/attachments":
            self._handle_attachment_upload()
            return
        raise APIError(404, "not_found", "Endpoint not found.")

    def _route_options(self, path: str) -> None:
        origin = self.headers.get("Origin", "")
        if origin and not self.app.config.allows_origin(origin):
            raise APIError(403, "origin_not_allowed", "Origin is not allowed.")
        if path == "" or not path.startswith("/"):
            raise APIError(404, "not_found", "Endpoint not found.")
        self._send_preflight()

    @staticmethod
    def _decode_segment(value: str) -> str:
        try:
            return urllib.parse.unquote(value, errors="strict")
        except UnicodeDecodeError:
            raise APIError(400, "invalid_request", "Invalid URL encoding.") from None

    def _session_cookie_token(self) -> Optional[str]:
        header = self.headers.get("Cookie")
        if not header:
            return None
        jar = http.cookies.SimpleCookie()
        try:
            jar.load(header)
        except http.cookies.CookieError:
            return None
        morsel = jar.get(SESSION_COOKIE)
        return morsel.value if morsel is not None else None

    def _oauth_state_cookie(self) -> Optional[str]:
        header = self.headers.get("Cookie")
        if not header:
            return None
        jar = http.cookies.SimpleCookie()
        try:
            jar.load(header)
        except http.cookies.CookieError:
            return None
        morsel = jar.get(OAUTH_STATE_COOKIE)
        return morsel.value if morsel is not None else None

    def _current_session(self) -> Optional[Session]:
        return self.app.sessions.get(self._session_cookie_token())

    def _require_session(self) -> Session:
        session = self._current_session()
        if session is None:
            raise APIError(
                401,
                "authentication_required",
                "Sign in with GitHub to perform this action.",
            )
        return session

    def _check_state_change(self) -> Session:
        session = self._require_session()
        supplied = self.headers.get("X-CSRF-Token", "")
        if not supplied or not hmac.compare_digest(supplied, session.csrf):
            raise APIError(
                403,
                "csrf_invalid",
                "A valid X-CSRF-Token header is required.",
            )
        origin = self.headers.get("Origin")
        if origin is not None and not self.app.config.allows_origin(origin):
            raise APIError(403, "origin_not_allowed", "Origin is not allowed.")
        return session

    def _cookie(
        self,
        name: str,
        value: str,
        *,
        path: str,
        max_age: Optional[int] = None,
        expire: bool = False,
        http_only: bool = True,
    ) -> str:
        morsel = http.cookies.Morsel()
        morsel.set(name, value, value)
        morsel["path"] = path
        if http_only:
            morsel["httponly"] = True
        morsel["samesite"] = self.app.config.cookie_samesite
        if self.app.config.cookie_secure:
            morsel["secure"] = True
        if expire:
            morsel["max-age"] = 0
            morsel["expires"] = "Thu, 01 Jan 1970 00:00:00 GMT"
        elif max_age is not None:
            morsel["max-age"] = max_age
        return morsel.OutputString()

    def _session_cookie(self, session: Session) -> str:
        return self._cookie(
            SESSION_COOKIE,
            session.token,
            path=self.app.config.session_cookie_path,
            max_age=self.app.config.session_ttl_seconds,
        )

    def _clear_session_cookie(self) -> str:
        return self._cookie(
            SESSION_COOKIE,
            "",
            path=self.app.config.session_cookie_path,
            expire=True,
        )

    def _oauth_cookie(self, value: str) -> str:
        return self._cookie(
            OAUTH_STATE_COOKIE,
            value,
            path=self.app.config.oauth_cookie_path,
            max_age=OAUTH_STATE_TTL_SECONDS,
        )

    def _clear_oauth_cookie(self) -> str:
        return self._cookie(
            OAUTH_STATE_COOKIE,
            "",
            path=self.app.config.oauth_cookie_path,
            expire=True,
        )

    def _handle_session(self) -> None:
        session = self._current_session()
        config = self.app.config
        payload = {
            "authenticated": session is not None,
            "viewer": session.viewer_json() if session is not None else None,
            "csrfToken": session.csrf if session is not None else None,
            "config": {
                "repository": config.comments_repository,
                "blogger": config.blogger_login,
                "commentsEnabled": bool(config.comments_repository),
                "authConfigured": config.auth_configured,
                "attachments": {
                    "enabled": config.attachments_mode != "disabled",
                    "maxBytes": config.attachments_max_bytes,
                    "allowedTypes": list(config.attachments_allowed_types),
                    "scope": "public",
                },
            },
        }
        self._send_json(200, payload)

    def _handle_get_article(self, comment_id: str) -> None:
        if not COMMENT_ID_RE.fullmatch(comment_id):
            raise APIError(
                400,
                "invalid_comment_id",
                "commentId must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$.",
            )
        article = self.app.get_article(comment_id, self._current_session())
        self._send_json(200, article)

    def _handle_comment_validation(
        self, data: Mapping[str, Any]
    ) -> tuple[
        str,
        str,
        str,
        Optional[dict[str, Any]],
        Optional[str],
        str,
        Optional[str],
    ]:
        body = data.get("body")
        if not isinstance(body, str):
            raise APIError(400, "invalid_request", "body must be a string.")
        body = body.strip()
        if not body or len(body) > MAX_COMMENT_CHARS:
            raise APIError(
                400,
                "invalid_request",
                f"body must contain between 1 and {MAX_COMMENT_CHARS} characters.",
            )
        if "\x00" in body:
            raise APIError(400, "invalid_request", "body must not contain NUL characters.")
        visibility = data.get("visibility")
        if not isinstance(visibility, str) or visibility not in {
            "public",
            "commenter",
            "blogger",
        }:
            raise APIError(
                400,
                "invalid_request",
                "visibility must be one of public, commenter, or blogger.",
            )
        effect = data.get("effect")
        if not isinstance(effect, str) or effect not in {
            "off",
            "subtle",
            "strong",
        }:
            raise APIError(
                400,
                "invalid_request",
                "effect must be one of off, subtle, or strong.",
            )
        quote = validate_quote_metadata(data.get("quote"))
        submission_id: Optional[str] = None
        if "submissionId" in data:
            candidate = data.get("submissionId")
            if not isinstance(candidate, str) or not SUBMISSION_ID_RE.fullmatch(
                candidate
            ):
                raise APIError(
                    400,
                    "invalid_request",
                    "submissionId must be a string matching "
                    "^[A-Za-z0-9_-]{16,128}$.",
                )
            submission_id = candidate
        title, article_url = self._article_context(data)
        return (
            body,
            visibility,
            effect,
            quote,
            title,
            article_url,
            submission_id,
        )

    def _article_context(
        self, data: Mapping[str, Any]
    ) -> tuple[Optional[str], str]:
        title_value = data.get("title")
        title: Optional[str] = None
        if title_value is not None:
            if not isinstance(title_value, str):
                raise APIError(400, "invalid_request", "title must be a string.")
            title = title_value.strip()
            if not title:
                title = None
            else:
                if len(title) > MAX_TITLE_CHARS:
                    raise APIError(
                        400,
                        "invalid_request",
                        f"title must be at most {MAX_TITLE_CHARS} characters.",
                    )
                if any(ord(ch) < 32 or ord(ch) == 127 for ch in title):
                    raise APIError(
                        400, "invalid_request", "title must not contain control characters."
                    )
        article_url_value = data.get("articleUrl")
        fallback_url = self.app.config.site_origins[0] + "/"
        article_url = fallback_url
        if article_url_value is not None:
            if not isinstance(article_url_value, str):
                raise APIError(400, "invalid_request", "articleUrl must be a string.")
            candidate = article_url_value.strip()
            if candidate:
                if len(candidate) > MAX_ARTICLE_URL_CHARS:
                    raise APIError(
                        400,
                        "invalid_request",
                        f"articleUrl must be at most {MAX_ARTICLE_URL_CHARS} characters.",
                    )
                try:
                    parts = urllib.parse.urlsplit(candidate)
                    _ = parts.port
                except ValueError:
                    parts = None
                if (
                    parts is None
                    or parts.scheme.lower() not in {"http", "https"}
                    or not parts.netloc
                    or parts.username is not None
                    or parts.password is not None
                    or any(ord(ch) < 32 or ord(ch) == 127 for ch in candidate)
                ):
                    raise APIError(
                        400, "invalid_request", "articleUrl must be an absolute http(s) URL."
                    )
                article_url = candidate
        return title, article_url

    def _handle_create_comment(self, comment_id: str) -> None:
        session = self._check_state_change()
        if not COMMENT_ID_RE.fullmatch(comment_id):
            raise APIError(
                400,
                "invalid_comment_id",
                "commentId must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$.",
            )
        data = self._read_json_object()
        (
            body,
            visibility,
            effect,
            quote,
            title,
            article_url,
            submission_id,
        ) = self._handle_comment_validation(data)
        submission_key = self._submission_key(
            session,
            comment_id,
            body,
            visibility,
            effect,
            quote,
            title,
            article_url,
            submission_id,
        )
        if not self.app.claim_submission(submission_key):
            raise APIError(
                409,
                "duplicate_submission",
                "An identical comment is already being submitted. Please wait "
                "and retry; a completed write will be returned as the existing "
                "comment.",
            )
        try:
            with self.app._issue_lock(comment_id):
                issue, pre_write_comments = (
                    self.app.resolve_issue_for_comment(
                        comment_id, session, title, article_url
                    )
                )
                read_token = self.app._read_token(session)
                # The pre-write read is authoritative for idempotency. Failure
                # here must not be allowed to reach a write.
                existing = self.app.find_comment_submission(
                    pre_write_comments, session.login, submission_key
                )
                if existing is not None:
                    self._send_json(
                        200,
                        {
                            "comment": self.app.comment_from_github(
                                existing, session
                            ),
                            "commentCount": len(
                                self.app.visible_comments(
                                    pre_write_comments, session
                                )
                            ),
                            "duplicate": True,
                            "refreshFailed": False,
                        },
                    )
                    return
                body_with_meta = body + "\n\n" + comment_marker(
                    visibility, effect, submission_key, quote
                )
                raw_comment = self.app.github.create_comment(
                    issue.number, body_with_meta, session.access_token
                )
                self.app.mark_submission_complete(submission_key)
                refresh_failed = False
                refreshed_comments: list[dict[str, Any]] = []
                try:
                    refreshed_comments, _ = self.app.github.list_comments(
                        issue.number, read_token
                    )
                except GitHubAPIError:
                    # The write is authoritative and the client can retry
                    # idempotently. Do not report the create as failed.
                    refresh_failed = True
            comment = self.app.comment_from_github(raw_comment, session)
            payload: dict[str, Any] = {
                "comment": comment,
                "commentCount": (
                    None
                    if refresh_failed
                    else len(
                        self.app.visible_comments(refreshed_comments, session)
                    )
                ),
                "duplicate": False,
                "refreshFailed": refresh_failed,
            }
            if refresh_failed:
                payload["warning"] = COMMENT_REFRESH_WARNING
            self._send_json(201, payload)
        finally:
            self.app.release_submission(submission_key)

    @staticmethod
    def _submission_key(
        session: Session,
        comment_id: str,
        body: str,
        visibility: str,
        effect: str,
        quote: Optional[Mapping[str, Any]],
        title: Optional[str],
        article_url: str,
        submission_id: Optional[str] = None,
    ) -> str:
        digest = hashlib.sha256()
        parts: tuple[str, ...]
        if submission_id is None:
            # Preserve the legacy key exactly so existing public markers remain
            # idempotent for clients that do not send submissionId.
            parts = (
                session.login.lower(),
                comment_id,
                body,
                visibility,
                effect,
                compact_json(quote or {}),
                title or "",
                article_url,
            )
        else:
            parts = (
                "threadline-submission-id-v1",
                submission_id,
                session.login.lower(),
                comment_id,
                body,
                visibility,
                effect,
                compact_json(quote or {}),
                title or "",
                article_url,
            )
        for part in parts:
            encoded = part.encode("utf-8")
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
        return digest.hexdigest()

    def _handle_reaction(self, comment_id: str) -> None:
        session = self._check_state_change()
        if not COMMENT_ID_RE.fullmatch(comment_id):
            raise APIError(
                400,
                "invalid_comment_id",
                "commentId must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$.",
            )
        data = self._read_json_object()
        if "reaction" not in data:
            raise APIError(
                400, "invalid_request", "reaction is required (like, dislike, or null)."
            )
        reaction = data.get("reaction")
        if reaction is not None and (
            not isinstance(reaction, str) or reaction not in {"like", "dislike"}
        ):
            raise APIError(
                400,
                "invalid_request",
                "reaction must be like, dislike, or null.",
            )
        expected_viewer_provided = "expectedViewer" in data
        expected_viewer = data.get("expectedViewer")
        if expected_viewer_provided and expected_viewer is not None and (
            not isinstance(expected_viewer, str)
            or expected_viewer not in {"like", "dislike"}
        ):
            raise APIError(
                400,
                "invalid_request",
                "expectedViewer must be like, dislike, or null when present.",
            )
        title, article_url = self._article_context(data)
        content = {"like": "+1", "dislike": "-1", None: None}[reaction]
        with self.app._issue_lock(comment_id):
            issue = self.app.resolve_issue_write(
                comment_id, session, title, article_url
            )
            read_token = self.app._read_token(session)
            raw_reactions, _ = self.app.github.list_reactions(
                issue.number, read_token
            )
            current_snapshot = self.app.reaction_snapshot(raw_reactions, session)
            if (
                expected_viewer_provided
                and current_snapshot["viewer"] != expected_viewer
            ):
                # A retry based on stale browser state must not invert an
                # already-applied switch. Return the real state instead.
                self._send_json(
                    200,
                    {
                        "reactions": current_snapshot,
                        "partial": False,
                        "conflict": True,
                        "warning": REACTION_CONFLICT_WARNING,
                    },
                )
                return
            viewer_login = session.login.lower()
            own = []
            for item in raw_reactions:
                user = item.get("user") if isinstance(item.get("user"), dict) else {}
                if str(user.get("login") or "").lower() != viewer_login:
                    continue
                if item.get("content") in {"+1", "-1"}:
                    own.append(item)

            operation_failed = False
            mutation_may_have_applied = False
            delete_items: list[Mapping[str, Any]] = []
            if content is None:
                delete_items = list(own)
            else:
                target_items = [
                    item for item in own if item.get("content") == content
                ]
                if not target_items:
                    # Switch: add the target first so the old reaction survives
                    # an add failure. Only delete the old state after success.
                    try:
                        self.app.github.add_reaction(
                            issue.number, content, session.access_token
                        )
                    except GitHubAPIError as exc:
                        operation_failed = True
                        if _mutation_may_have_applied(exc):
                            mutation_may_have_applied = True
                    else:
                        mutation_may_have_applied = True
                        delete_items = list(own)
                elif len(own) == 1:
                    # Same reaction again toggles it off.
                    delete_items = list(own)
                else:
                    # A previous partial switch can leave both reactions. Retry
                    # converges by keeping one target and removing stale state.
                    keep = target_items[0]
                    delete_items = [item for item in own if item is not keep]

            if not operation_failed:
                for item in delete_items:
                    reaction_id = item.get("id")
                    if not isinstance(reaction_id, int):
                        continue
                    try:
                        self.app.github.delete_reaction(
                            issue.number, reaction_id, session.access_token
                        )
                    except GitHubAPIError as exc:
                        operation_failed = True
                        if _mutation_may_have_applied(exc):
                            mutation_may_have_applied = True
                        break
                    else:
                        mutation_may_have_applied = True

            # Never fabricate a state. If a mutation returned successfully or
            # failed ambiguously (lost response, timeout, 5xx), the write may
            # have been applied. A failed authoritative refresh then makes the
            # post-write state unknown.
            try:
                refreshed, _ = self.app.github.list_reactions(
                    issue.number, read_token
                )
            except GitHubAPIError:
                if mutation_may_have_applied:
                    raise APIError(
                        502,
                        "reaction_state_unknown",
                        REACTION_STATE_UNKNOWN_MESSAGE,
                    ) from None
                raise

        payload: dict[str, Any] = {
            "reactions": self.app.reaction_snapshot(refreshed, session),
            "partial": operation_failed,
            "conflict": False,
        }
        if operation_failed:
            payload["warning"] = REACTION_PARTIAL_WARNING
        self._send_json(200, payload)

    def _handle_attachment_upload(self) -> None:
        self._check_state_change()
        if self.app.config.attachments_mode == "disabled":
            raise AttachmentError(
                503,
                "attachments_disabled",
                "Attachment uploads are disabled on this server.",
            )
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("multipart/form-data"):
            raise AttachmentError(
                415,
                "invalid_type",
                "Expected multipart/form-data with a file field.",
            )
        # Allow enough multipart overhead that ordinary over-limit uploads are
        # fully parsed and rejected with a readable 413 rather than closing the
        # socket while the client is still sending. The file itself remains
        # bounded by ATTACHMENTS_MAX_BYTES.
        max_request = max(
            self.app.config.attachments_max_bytes + 256 * 1024,
            8 * 1024 * 1024,
        )
        raw = self._read_body(max_request, error_code="too_large")
        filename, part_type, content = parse_multipart_file(
            raw,
            content_type,
            max_file_bytes=self.app.config.attachments_max_bytes,
        )
        attachment = self.app.attachments.upload(content, filename, part_type)
        self._send_json(201, {"attachment": attachment})

    def _handle_attachment_serve(self, token: str) -> None:
        if not ATTACHMENT_TOKEN_RE.fullmatch(token):
            raise APIError(404, "not_found", "Attachment not found.")
        if self.app.config.attachments_mode != "local":
            raise APIError(404, "not_found", "Attachment not found.")
        row = self.app.database.get_attachment(token)
        if row is None:
            raise APIError(404, "not_found", "Attachment not found.")
        path = str(row["path"])
        directory = self.app.config.attachments_dir or ""
        try:
            real_path = os.path.realpath(path)
            real_dir = os.path.realpath(directory)
            if os.path.commonpath([real_path, real_dir]) != real_dir:
                raise APIError(404, "not_found", "Attachment not found.")
        except (OSError, ValueError):
            raise APIError(404, "not_found", "Attachment not found.") from None
        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(real_path, flags)
        except OSError:
            raise APIError(404, "not_found", "Attachment not found.") from None
        try:
            stat = os.fstat(descriptor)
            size = stat.st_size
            mime = str(row["mime"])
            name = str(row["name"])
            inline = bool(
                ATTACHMENT_TYPE_RULES.get(mime, {}).get("inline", False)
            )
            self.send_response(200)
            self._send_common_headers()
            self.send_header("Content-Type", mime + ("; charset=utf-8" if mime == "text/plain" else ""))
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", _attachment_content_disposition(name, inline))
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.send_header("Content-Security-Policy", "default-src 'none'; sandbox")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self._response_started = True
            with os.fdopen(descriptor, "rb") as handle:
                descriptor = -1
                while True:
                    chunk = handle.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        finally:
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass

    def _handle_auth_start(self, parsed: urllib.parse.SplitResult) -> None:
        config = self.app.config
        if not config.auth_configured:
            raise APIError(
                503,
                "auth_not_configured",
                "GitHub sign-in is not configured on this server.",
            )
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        return_to_values = query.get("returnTo") or []
        return_to = return_to_values[0] if return_to_values else ""
        if not return_to:
            raise APIError(
                400, "invalid_return_to", "returnTo must be an absolute site URL."
            )
        try:
            return_parts = urllib.parse.urlsplit(return_to)
            _ = return_parts.port
        except ValueError:
            raise APIError(
                400, "invalid_return_to", "returnTo must be an absolute site URL."
            ) from None
        if (
            return_parts.scheme.lower() not in {"http", "https"}
            or not return_parts.netloc
            or return_parts.username is not None
            or return_parts.password is not None
            or "\\" in return_to
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in return_to)
        ):
            raise APIError(
                400, "invalid_return_to", "returnTo must be an absolute site URL."
            )
        try:
            return_origin = origin_for_url(return_to)
        except ValueError:
            raise APIError(
                400, "invalid_return_to", "returnTo must be an absolute site URL."
            ) from None
        if not config.allows_origin(return_origin):
            raise APIError(
                400,
                "invalid_return_to",
                "returnTo must use one of SITE_ORIGINS.",
            )
        state, state_cookie = self.app.oauth_states.create(return_to)
        authorize_parts = urllib.parse.urlsplit(config.github_oauth_authorize_url)
        existing = urllib.parse.parse_qsl(authorize_parts.query, keep_blank_values=True)
        params = [
            ("client_id", config.github_client_id),
            ("redirect_uri", config.callback_url),
            ("state", state),
            ("response_type", "code"),
        ]
        if config.github_oauth_scope:
            params.append(("scope", config.github_oauth_scope))
        query_string = urllib.parse.urlencode(existing + params)
        location = urllib.parse.urlunsplit(
            (
                authorize_parts.scheme,
                authorize_parts.netloc,
                authorize_parts.path,
                query_string,
                authorize_parts.fragment,
            )
        )
        self._send_redirect(location, cookies=[self._oauth_cookie(state_cookie)])

    def _oauth_exchange(self, code: str) -> str:
        config = self.app.config
        data = urllib.parse.urlencode(
            {
                "client_id": config.github_client_id,
                "client_secret": config.github_client_secret,
                "code": code,
                "redirect_uri": config.callback_url,
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            config.github_oauth_token_url,
            data=data,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": USER_AGENT,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=GITHUB_TIMEOUT_SECONDS) as response:
                raw = response.read(256 * 1024 + 1)
                content_type = response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as exc:
            exc.close()
            raise OAuthError("oauth_exchange_failed") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise OAuthError("oauth_exchange_failed") from None
        if len(raw) > 256 * 1024:
            raise OAuthError("oauth_exchange_failed")
        try:
            text = raw.decode("utf-8")
            if "json" in content_type.lower() or text.lstrip().startswith("{"):
                payload = json.loads(text)
            else:
                parsed = urllib.parse.parse_qs(text)
                payload = {key: values[0] for key, values in parsed.items() if values}
        except (UnicodeDecodeError, ValueError):
            raise OAuthError("oauth_exchange_failed") from None
        if not isinstance(payload, dict) or payload.get("error"):
            raise OAuthError("oauth_exchange_failed")
        access_token = payload.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise OAuthError("oauth_exchange_failed")
        return access_token

    def _handle_auth_callback(self, parsed: urllib.parse.SplitResult) -> None:
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)

        def first(name: str) -> Optional[str]:
            values = query.get(name)
            return values[0] if values else None

        return_to = self.app.oauth_states.consume(
            first("state"), self._oauth_state_cookie()
        )
        if return_to is None:
            raise APIError(
                400,
                "invalid_state",
                "The OAuth state is invalid or has expired. Start sign-in again.",
            )
        provider_error = first("error")
        cookies = [self._clear_oauth_cookie()]
        if provider_error:
            safe_error = re.sub(r"[^A-Za-z0-9_-]", "_", provider_error)[:50]
            self._send_redirect(
                add_query_params(return_to, [("auth_error", safe_error)]),
                cookies=cookies,
            )
            return
        code = first("code")
        if not code:
            self._send_redirect(
                add_query_params(return_to, [("auth_error", "missing_code")]),
                cookies=cookies,
            )
            return
        try:
            access_token = self._oauth_exchange(code)
        except OAuthError as exc:
            LOG.warning("OAuth token exchange failed (%s)", exc.code)
            self._send_redirect(
                add_query_params(return_to, [("auth_error", "oauth_exchange_failed")]),
                cookies=cookies,
            )
            return
        try:
            user = self.app.github.get_user(access_token)
        except GitHubAPIError as exc:
            LOG.warning("OAuth profile lookup failed (%s)", exc.code)
            self._send_redirect(
                add_query_params(return_to, [("auth_error", "profile_failed")]),
                cookies=cookies,
            )
            return
        login = str(user.get("login") or "")
        if not login:
            self._send_redirect(
                add_query_params(return_to, [("auth_error", "profile_failed")]),
                cookies=cookies,
            )
            return
        session = self.app.sessions.create(
            login=login,
            name=str(user.get("name") or login),
            avatar_url=str(user.get("avatar_url") or ""),
            html_url=str(
                user.get("html_url") or f"https://github.com/{login}"
            ),
            access_token=access_token,
        )
        cookies.insert(0, self._session_cookie(session))
        self._send_redirect(
            add_query_params(return_to, [("auth", "ok")]), cookies=cookies
        )

    def _handle_logout(self) -> None:
        session = self._check_state_change()
        self.app.sessions.delete(session.token)
        self._send_empty(
            204,
            headers=[("Set-Cookie", self._clear_session_cookie())],
        )

    def _read_body(self, maximum: int, error_code: str = "invalid_request") -> bytes:
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            raise APIError(
                411,
                "length_required",
                "Content-Length is required; chunked request bodies are not supported.",
            )
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self.close_connection = True
            raise APIError(411, "length_required", "Content-Length is required.")
        try:
            length = int(raw_length, 10)
        except ValueError:
            self.close_connection = True
            raise APIError(400, "invalid_request", "Invalid Content-Length.") from None
        if length < 0:
            self.close_connection = True
            raise APIError(400, "invalid_request", "Invalid Content-Length.")
        if length > maximum:
            self.close_connection = True
            raise APIError(
                413,
                error_code,
                "The request body exceeds the configured limit.",
            )
        body = b""
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 64 * 1024))
            if not chunk:
                raise APIError(400, "invalid_request", "Incomplete request body.")
            body += chunk
            remaining -= len(chunk)
        self._request_body_read = True
        return body

    def _read_json_object(self) -> dict[str, Any]:
        content_type = self.headers.get("Content-Type", "")
        if content_type:
            media_type = content_type.split(";", 1)[0].strip().lower()
            if media_type not in {"application/json", "application/merge-patch+json"}:
                raise APIError(
                    415,
                    "unsupported_media_type",
                    "Content-Type must be application/json.",
                )
        body = self._read_body(MAX_JSON_BODY_BYTES)
        try:
            decoded = body.decode("utf-8")
            payload = json.loads(decoded)
        except (UnicodeDecodeError, ValueError):
            raise APIError(400, "invalid_json", "The request body must be valid JSON.") from None
        if not isinstance(payload, dict):
            raise APIError(400, "invalid_request", "The JSON body must be an object.")
        return payload

    def _origin_allowed(self) -> Optional[str]:
        origin = self.headers.get("Origin")
        if origin and self.app.config.allows_origin(origin):
            return origin
        return None

    def _send_common_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Vary", "Origin")
        if self.close_connection:
            self.send_header("Connection", "close")
        allowed_origin = self._origin_allowed()
        if allowed_origin:
            self.send_header("Access-Control-Allow-Origin", allowed_origin)
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header("Access-Control-Expose-Headers", "Retry-After")

    def _start_response(self, status: int) -> None:
        self._response_started = True
        self.send_response(status)

    def _send_json(
        self,
        status: int,
        payload: Mapping[str, Any],
        *,
        headers: Optional[list[tuple[str, str]]] = None,
    ) -> None:
        data = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        self._start_response(status)
        self._send_common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        for key, value in headers or []:
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _send_empty(
        self, status: int, *, headers: Optional[list[tuple[str, str]]] = None
    ) -> None:
        self._start_response(status)
        self._send_common_headers()
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        for key, value in headers or []:
            self.send_header(key, value)
        self.end_headers()

    def _send_redirect(self, location: str, *, cookies: list[str]) -> None:
        self._start_response(302)
        self._send_common_headers()
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        for cookie in cookies:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def _send_preflight(self) -> None:
        self._start_response(204)
        self._send_common_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token"
        )
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _send_error(self, exc: APIError) -> None:
        if self._response_started:
            self.close_connection = True
            return
        payload = {"error": {"code": exc.code, "message": exc.message}}
        self._send_json(exc.status, payload, headers=exc.headers)


def create_server(config: Config) -> ThreadlineHTTPServer:
    application = Application(config)
    return ThreadlineHTTPServer((config.host, config.port), application)


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Threadline GitHub Issues comments service"
    )
    parser.add_argument(
        "--env-file",
        help="read configuration from a KEY=VALUE file (real environment wins)",
    )
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    env: dict[str, str] = {}
    if args.env_file:
        try:
            env.update(load_env_file(args.env_file))
        except ConfigError as exc:
            print(f"Configuration error: {exc}", file=sys.stderr)
            return 2
    env.update(os.environ)
    try:
        config = Config.from_env(env)
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2
    try:
        server = create_server(config)
    except (OSError, sqlite3.Error):
        print("Could not start server: storage or bind initialization failed.", file=sys.stderr)
        return 1
    LOG.info(
        "Threadline listening on %s:%s (repository=%s, auth=%s, attachments=%s)",
        config.host,
        config.port,
        config.comments_repository,
        "configured" if config.auth_configured else "disabled",
        config.attachments_mode,
    )
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        LOG.info("Shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
