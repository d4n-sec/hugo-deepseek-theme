"""Deterministic local GitHub/OAuth mock used by the Threadline tests.

This module intentionally implements only the endpoint shapes exercised by the
service.  It makes no external calls and is not a GitHub emulator.
"""

from __future__ import annotations

import http.server
import json
import re
import secrets
import socket
import threading
import urllib.parse
from typing import Any, Optional


OWNER = "acme"
REPO = "comments"
CLIENT_ID = "test-client-id"
CLIENT_SECRET = "test-client-secret"
READ_TOKEN = "read-token"
ATTACHMENT_TOKEN = "attachment-http-secret"


class MockGitHub:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.server: Optional[http.server.ThreadingHTTPServer] = None
        self.thread: Optional[threading.Thread] = None
        self.base_url = ""
        self.users = {
            "alice": {
                "login": "alice",
                "name": "Alice Example",
                "avatar_url": "https://avatars.example/alice.png",
                "html_url": "https://github.example/alice",
            },
            "bob": {
                "login": "bob",
                "name": "Bob Example",
                "avatar_url": "https://avatars.example/bob.png",
                "html_url": "https://github.example/bob",
            },
            "blogger": {
                "login": "blogger",
                "name": "Blog Owner",
                "avatar_url": "https://avatars.example/blogger.png",
                "html_url": "https://github.example/blogger",
            },
            "reader": {
                "login": "reader",
                "name": "Read Bot",
                "avatar_url": "https://avatars.example/reader.png",
                "html_url": "https://github.example/reader",
            },
        }
        self.tokens = {
            "token-alice": "alice",
            "token-bob": "bob",
            "token-blogger": "blogger",
            READ_TOKEN: "reader",
        }
        self.codes: dict[str, str] = {}
        self.issues: dict[int, dict[str, Any]] = {}
        self.comments: dict[int, list[dict[str, Any]]] = {}
        self.reactions: dict[int, list[dict[str, Any]]] = {}
        self.next_issue = 1
        self.next_comment = 1000
        self.next_reaction = 5000
        self.tick = 0
        self.write_requests: list[dict[str, Any]] = []
        self.read_tokens: list[Optional[str]] = []
        self.api_version_headers: list[Optional[str]] = []
        self.failed_write_mode: Optional[str] = None
        self.hold_comment_writes = False
        self.comment_write_started = threading.Event()
        self.comment_write_release = threading.Event()
        self.attachment_uploads: list[dict[str, Any]] = []
        self.comment_write_epoch = 0
        self.fail_comment_lists_next = 0
        self.comment_list_failure_epoch: Optional[int] = None
        self.comment_list_failure_remaining = 0
        self.reaction_write_epoch = 0
        self.fail_reaction_lists_next = 0
        self.reaction_list_failure_epoch: Optional[int] = None
        self.reaction_list_failure_remaining = 0
        self.reaction_list_skip_successes = 0
        self.reaction_list_skip_failures = 0
        self.fail_reaction_add = False
        self.fail_reaction_delete = False
        self.reaction_add_failure_status = 503
        self.reaction_delete_failure_status = 503
        self.lose_reaction_response_mode: Optional[str] = None

    @property
    def oauth_authorize_url(self) -> str:
        return f"{self.base_url}/login/oauth/authorize"

    @property
    def oauth_token_url(self) -> str:
        return f"{self.base_url}/login/oauth/access_token"

    def start(self) -> "MockGitHub":
        server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), MockGitHubHandler
        )
        server.daemon_threads = True
        server.mock = self  # type: ignore[attr-defined]
        self.server = server
        self.base_url = f"http://127.0.0.1:{server.server_address[1]}"
        self.thread = threading.Thread(
            target=server.serve_forever, daemon=True, name="mock-github"
        )
        self.thread.start()
        return self

    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
        if self.thread is not None:
            self.thread.join(timeout=5)
        self.server = None
        self.thread = None

    def set_write_failure(self, mode: Optional[str]) -> None:
        with self.lock:
            self.failed_write_mode = mode

    def fail_next_comment_lists(self, count: int = 1) -> None:
        with self.lock:
            self.fail_comment_lists_next = max(1, count)

    def fail_comment_lists_after_write(self, count: Optional[int] = 1) -> None:
        """Fail lists only after a comment write made since arming.

        ``count=None`` keeps failing until explicitly cleared.
        """
        with self.lock:
            self.comment_list_failure_epoch = self.comment_write_epoch
            self.comment_list_failure_remaining = (
                -1 if count is None else max(1, count)
            )

    def clear_comment_list_failures(self) -> None:
        with self.lock:
            self.fail_comment_lists_next = 0
            self.comment_list_failure_epoch = None
            self.comment_list_failure_remaining = 0

    def fail_next_reaction_lists(self, count: int = 1) -> None:
        with self.lock:
            self.fail_reaction_lists_next = max(1, count)

    def fail_reaction_lists_after_write(self, count: Optional[int] = 1) -> None:
        """Fail lists only after a reaction write made since arming."""
        with self.lock:
            self.reaction_list_failure_epoch = self.reaction_write_epoch
            self.reaction_list_failure_remaining = (
                -1 if count is None else max(1, count)
            )

    def fail_reaction_lists_after_successes(
        self, successes: int = 1, count: int = 1
    ) -> None:
        """Allow some reaction-list reads, then fail the next ones."""
        with self.lock:
            self.reaction_list_skip_successes = max(0, successes)
            self.reaction_list_skip_failures = max(1, count)

    def clear_reaction_list_failures(self) -> None:
        with self.lock:
            self.fail_reaction_lists_next = 0
            self.reaction_list_failure_epoch = None
            self.reaction_list_failure_remaining = 0
            self.reaction_list_skip_successes = 0
            self.reaction_list_skip_failures = 0

    def set_reaction_failure(self, mode: Optional[str]) -> None:
        """Fail only reaction adds or deletes.

        ``add`` / ``delete`` return an ambiguous 503. The ``*_forbidden``
        variants return a definitive 403 before applying the mutation.
        """
        with self.lock:
            self.fail_reaction_add = mode in {"add", "add_forbidden"}
            self.fail_reaction_delete = mode in {
                "delete",
                "delete_forbidden",
            }
            self.reaction_add_failure_status = (
                403 if mode == "add_forbidden" else 503
            )
            self.reaction_delete_failure_status = (
                403 if mode == "delete_forbidden" else 503
            )

    def set_reaction_lost_response(self, mode: Optional[str]) -> None:
        """Apply a reaction write, then drop the connection without a reply."""
        if mode not in {None, "add", "delete"}:
            raise ValueError("mode must be None, add, or delete")
        with self.lock:
            self.lose_reaction_response_mode = mode

    def _consume_comment_list_failure(self) -> bool:
        with self.lock:
            if self.fail_comment_lists_next > 0:
                self.fail_comment_lists_next -= 1
                return True
            if (
                self.comment_list_failure_epoch is not None
                and self.comment_write_epoch > self.comment_list_failure_epoch
                and self.comment_list_failure_remaining != 0
            ):
                if self.comment_list_failure_remaining > 0:
                    self.comment_list_failure_remaining -= 1
                    if self.comment_list_failure_remaining == 0:
                        self.comment_list_failure_epoch = None
                return True
            return False

    def _consume_reaction_list_failure(self) -> bool:
        with self.lock:
            if self.reaction_list_skip_failures > 0:
                if self.reaction_list_skip_successes > 0:
                    self.reaction_list_skip_successes -= 1
                    return False
                self.reaction_list_skip_failures -= 1
                return True
            if self.fail_reaction_lists_next > 0:
                self.fail_reaction_lists_next -= 1
                return True
            if (
                self.reaction_list_failure_epoch is not None
                and self.reaction_write_epoch > self.reaction_list_failure_epoch
                and self.reaction_list_failure_remaining != 0
            ):
                if self.reaction_list_failure_remaining > 0:
                    self.reaction_list_failure_remaining -= 1
                    if self.reaction_list_failure_remaining == 0:
                        self.reaction_list_failure_epoch = None
                return True
            return False

    def hold_next_comment_write(self) -> None:
        with self.lock:
            self.comment_write_started.clear()
            self.comment_write_release.clear()
            self.hold_comment_writes = True

    def release_comment_write(self) -> None:
        self.comment_write_release.set()

    def finish_comment_hold(self) -> None:
        with self.lock:
            self.hold_comment_writes = False
        self.comment_write_release.set()

    def add_issue(
        self,
        title: str,
        body: str = "",
        number: Optional[int] = None,
    ) -> int:
        with self.lock:
            if number is None:
                number = self.next_issue
                self.next_issue += 1
            else:
                self.next_issue = max(self.next_issue, number + 1)
            issue = {
                "number": number,
                "title": title,
                "body": body,
                "state": "open",
                "html_url": f"https://github.example/{OWNER}/{REPO}/issues/{number}",
                "labels": [],
                "user": self._public_user("blogger"),
            }
            self.issues[number] = issue
            self.comments.setdefault(number, [])
            self.reactions.setdefault(number, [])
            return number

    def add_comment(
        self,
        issue_number: int,
        login: str,
        body: str,
        *,
        created_at: Optional[str] = None,
    ) -> dict[str, Any]:
        with self.lock:
            if issue_number not in self.issues:
                raise KeyError(issue_number)
            timestamp = created_at or self._next_timestamp()
            comment = {
                "id": self.next_comment,
                "body": body,
                "user": self._public_user(login),
                "created_at": timestamp,
                "updated_at": timestamp,
                "html_url": f"https://github.example/{OWNER}/{REPO}/issues/"
                f"{issue_number}#issuecomment-{self.next_comment}",
            }
            self.next_comment += 1
            self.comments[issue_number].append(comment)
            return comment

    def add_reaction(
        self, issue_number: int, login: str, content: str
    ) -> dict[str, Any]:
        with self.lock:
            if issue_number not in self.issues:
                raise KeyError(issue_number)
            reaction = {
                "id": self.next_reaction,
                "user": self._public_user(login),
                "content": content,
                "created_at": self._next_timestamp(),
            }
            self.next_reaction += 1
            self.reactions[issue_number].append(reaction)
            return reaction

    def issue_numbers_for(self, comment_id: str) -> list[int]:
        prefix = f"[threadline:{comment_id}]"
        with self.lock:
            return sorted(
                number
                for number, issue in self.issues.items()
                if issue["title"].startswith(prefix)
            )

    def _next_timestamp(self) -> str:
        self.tick += 1
        return (
            f"2026-01-01T00:"
            f"{(self.tick // 60) % 60:02d}:{self.tick % 60:02d}Z"
        )

    def _public_user(self, login: str) -> dict[str, Any]:
        user = self.users[login]
        return {
            "login": user["login"],
            "name": user["name"],
            "avatar_url": user["avatar_url"],
            "html_url": user["html_url"],
        }


class MockGitHubHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MockGitHub/1.0"
    sys_version = ""

    @property
    def mock(self) -> MockGitHub:
        return self.server.mock  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        self._handle("GET")

    def do_POST(self) -> None:
        self._handle("POST")

    def do_DELETE(self) -> None:
        self._handle("DELETE")

    def _handle(self, method: str) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        length_header = self.headers.get("Content-Length")
        length = int(length_header) if length_header else 0
        raw_body = self.rfile.read(length) if length else b""
        try:
            if path == "/login/oauth/authorize" and method == "GET":
                self._authorize(query)
                return
            if path == "/login/oauth/access_token" and method == "POST":
                self._token(raw_body)
                return
            if path == "/upload" and method == "POST":
                self._upload(raw_body)
                return
            if path.startswith("/repos/") or path in {"/user", "/search/issues"}:
                if path == "/user" and method == "GET":
                    token, login = self._require_token()
                    if token is None:
                        return
                    self._send_json(200, self.mock._public_user(login))
                    return
                if path == "/search/issues" and method == "GET":
                    if not self._authorize_read():
                        return
                    self._search(query)
                    return
                repo_match = self._repo_route(path)
                if repo_match is None:
                    self._send_json(404, {"message": "Not Found"})
                    return
                kind, rest = repo_match
                if kind == "issues" and method == "POST":
                    self._create_issue(raw_body)
                    return
                if kind == "issue" and method == "GET":
                    if not self._authorize_read():
                        return
                    self._get_issue(rest)
                    return
                if kind == "comments" and method == "GET":
                    if not self._authorize_read():
                        return
                    self._list_comments(rest, query)
                    return
                if kind == "comments" and method == "POST":
                    self._create_comment(rest, raw_body)
                    return
                if kind == "reactions" and method == "GET":
                    if not self._authorize_read():
                        return
                    self._list_reactions(rest, query)
                    return
                if kind == "reactions" and method == "POST":
                    self._create_reaction(rest, raw_body)
                    return
                if kind == "reaction" and method == "DELETE":
                    assert rest is not None
                    self._delete_reaction(rest[0], rest[1])
                    return
            self._send_json(404, {"message": "Not Found"})
        except Exception:
            self._send_json(500, {"message": "Mock failure"})

    def _repo_route(
        self, path: str
    ) -> Optional[tuple[str, Any]]:
        prefix = f"/repos/{OWNER}/{REPO}"
        if path == prefix + "/issues":
            return "issues", None
        match = re.fullmatch(re.escape(prefix) + r"/issues/(\d+)", path)
        if match:
            return "issue", int(match.group(1))
        match = re.fullmatch(
            re.escape(prefix) + r"/issues/(\d+)/comments", path
        )
        if match:
            return "comments", int(match.group(1))
        match = re.fullmatch(
            re.escape(prefix) + r"/issues/(\d+)/reactions", path
        )
        if match:
            return "reactions", int(match.group(1))
        match = re.fullmatch(
            re.escape(prefix) + r"/issues/(\d+)/reactions/(\d+)", path
        )
        if match:
            return "reaction", (int(match.group(1)), int(match.group(2)))
        return None

    def _authorize(self, query: dict[str, list[str]]) -> None:
        def first(name: str) -> str:
            return (query.get(name) or [""])[0]

        login = first("login") or "alice"
        if (
            first("client_id") != CLIENT_ID
            or not first("redirect_uri")
            or not first("state")
        ):
            self._send_json(400, {"message": "Invalid OAuth request"})
            return
        if login not in self.mock.users:
            self._send_json(400, {"message": "Unknown mock user"})
            return
        code = "code-" + secrets.token_urlsafe(16)
        with self.mock.lock:
            self.mock.codes[code] = login
        redirect = first("redirect_uri")
        query_string = urllib.parse.urlencode({"code": code, "state": first("state")})
        separator = "&" if "?" in redirect else "?"
        self._send_redirect(f"{redirect}{separator}{query_string}")

    def _token(self, raw_body: bytes) -> None:
        try:
            form = urllib.parse.parse_qs(raw_body.decode("utf-8"))
        except UnicodeDecodeError:
            self._send_json(400, {"error": "invalid_request"})
            return

        def first(name: str) -> str:
            return (form.get(name) or [""])[0]

        if (
            first("client_id") != CLIENT_ID
            or first("client_secret") != CLIENT_SECRET
            or not first("redirect_uri")
        ):
            self._send_json(400, {"error": "invalid_client"})
            return
        with self.mock.lock:
            login = self.mock.codes.pop(first("code"), None)
        if login is None:
            self._send_json(400, {"error": "invalid_grant"})
            return
        self._send_json(
            200,
            {
                "access_token": f"token-{login}",
                "token_type": "bearer",
                "scope": "",
            },
        )

    def _upload(self, raw_body: bytes) -> None:
        if self.headers.get("Authorization") != f"Bearer {ATTACHMENT_TOKEN}":
            self._send_json(401, {"message": "Unauthorized"})
            return
        if b'name="file"' not in raw_body or b"Content-Type:" not in raw_body:
            self._send_json(400, {"message": "Missing file"})
            return
        with self.mock.lock:
            self.mock.attachment_uploads.append(
                {"authorization": self.headers.get("Authorization")}
            )
        self._send_json(201, {"url": "https://cdn.example/files/uploaded.png"})

    def _api_version(self) -> None:
        version = self.headers.get("X-GitHub-Api-Version")
        with self.mock.lock:
            self.mock.api_version_headers.append(version)
        if version != "2022-11-28":
            raise _BadRequest("Missing API version")

    def _authorize_read(self) -> bool:
        self._api_version()
        authorization = self.headers.get("Authorization", "")
        if not authorization:
            with self.mock.lock:
                self.mock.read_tokens.append(None)
            return True
        if not authorization.startswith("Bearer "):
            self._send_json(401, {"message": "Bad credentials"})
            return False
        token = authorization[7:]
        with self.mock.lock:
            login = self.mock.tokens.get(token)
            self.mock.read_tokens.append(token)
        if login is None:
            self._send_json(401, {"message": "Bad credentials"})
            return False
        return True

    def _require_token(self) -> tuple[Optional[str], Optional[str]]:
        self._api_version()
        authorization = self.headers.get("Authorization", "")
        if not authorization.startswith("Bearer "):
            self._send_json(401, {"message": "Bad credentials"})
            return None, None
        token = authorization[7:]
        with self.mock.lock:
            login = self.mock.tokens.get(token)
        if login is None:
            self._send_json(401, {"message": "Bad credentials"})
            return None, None
        return token, login

    def _require_write(self) -> tuple[Optional[str], Optional[str]]:
        token, login = self._require_token()
        if token is None:
            return None, None
        if token == READ_TOKEN:
            self._send_json(403, {"message": "Resource not accessible by integration"})
            return None, None
        with self.mock.lock:
            self.mock.write_requests.append(
                {
                    "method": self.command,
                    "path": urllib.parse.urlsplit(self.path).path,
                    "token": token,
                    "login": login,
                }
            )
            failure = self.mock.failed_write_mode
        if failure == "rate_limit":
            self._send_json(
                429,
                {"message": "API rate limit exceeded"},
                headers={
                    "Retry-After": "7",
                    "X-RateLimit-Remaining": "0",
                },
            )
            return None, None
        if failure == "permission":
            self._send_json(
                403, {"message": "Resource not accessible by integration"}
            )
            return None, None
        if failure == "unavailable":
            self._send_json(503, {"message": "Service unavailable"})
            return None, None
        if failure == "unauthorized":
            self._send_json(401, {"message": "Bad credentials"})
            return None, None
        if failure == "validation":
            self._send_json(422, {"message": "Validation Failed"})
            return None, None
        if failure == "not_found":
            self._send_json(404, {"message": "Not Found"})
            return None, None
        return token, login

    def _search(self, query: dict[str, list[str]]) -> None:
        search_query = (query.get("q") or [""])[0]
        match = re.search(r'in:title\s+"([^"]+)"', search_query)
        if not match:
            self._send_json(200, {"total_count": 0, "items": []})
            return
        phrase = match.group(1)
        with self.mock.lock:
            items = [
                dict(issue)
                for _, issue in sorted(self.mock.issues.items())
                if phrase in issue["title"]
            ]
        self._send_json(
            200,
            {
                "total_count": len(items),
                "incomplete_results": False,
                "items": items[:100],
            },
        )

    def _create_issue(self, raw_body: bytes) -> None:
        token, login = self._require_write()
        if token is None:
            return
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self._send_json(422, {"message": "Invalid JSON"})
            return
        title = payload.get("title") if isinstance(payload, dict) else None
        if not isinstance(title, str) or not title:
            self._send_json(422, {"message": "title is required"})
            return
        with self.mock.lock:
            number = self.mock.next_issue
            self.mock.next_issue += 1
            issue = {
                "number": number,
                "title": title,
                "body": payload.get("body", ""),
                "state": "open",
                "html_url": f"https://github.example/{OWNER}/{REPO}/issues/{number}",
                "labels": payload.get("labels", []),
                "user": self.mock._public_user(login),
            }
            self.mock.issues[number] = issue
            self.mock.comments[number] = []
            self.mock.reactions[number] = []
        self._send_json(201, issue)

    def _get_issue(self, number: int) -> None:
        with self.mock.lock:
            issue = self.mock.issues.get(number)
        if issue is None:
            self._send_json(404, {"message": "Not Found"})
        else:
            self._send_json(200, issue)

    def _list_comments(
        self, number: int, query: dict[str, list[str]]
    ) -> None:
        if self.mock._consume_comment_list_failure():
            self._send_json(503, {"message": "Comment listing unavailable"})
            return
        with self.mock.lock:
            if number not in self.mock.issues:
                self._send_json(404, {"message": "Not Found"})
                return
            comments = list(self.mock.comments[number])
        self._send_page(comments, query)

    def _create_comment(self, number: int, raw_body: bytes) -> None:
        token, login = self._require_write()
        if token is None:
            return
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self._send_json(422, {"message": "Invalid JSON"})
            return
        body = payload.get("body") if isinstance(payload, dict) else None
        if not isinstance(body, str) or not body:
            self._send_json(422, {"message": "body is required"})
            return
        with self.mock.lock:
            hold = self.mock.hold_comment_writes
        if hold:
            self.mock.comment_write_started.set()
            self.mock.comment_write_release.wait(timeout=5)
        with self.mock.lock:
            if number not in self.mock.issues:
                self._send_json(404, {"message": "Not Found"})
                return
            comment = self.mock.add_comment(number, login, body)
            self.mock.comment_write_epoch += 1
        self._send_json(201, comment)

    def _list_reactions(
        self, number: int, query: dict[str, list[str]]
    ) -> None:
        if self.mock._consume_reaction_list_failure():
            self._send_json(503, {"message": "Reaction listing unavailable"})
            return
        with self.mock.lock:
            if number not in self.mock.issues:
                self._send_json(404, {"message": "Not Found"})
                return
            reactions = list(self.mock.reactions[number])
        self._send_page(reactions, query)

    def _create_reaction(self, number: int, raw_body: bytes) -> None:
        token, login = self._require_write()
        if token is None:
            return
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self._send_json(422, {"message": "Invalid JSON"})
            return
        content = payload.get("content") if isinstance(payload, dict) else None
        if content not in {"+1", "-1"}:
            self._send_json(422, {"message": "invalid content"})
            return
        with self.mock.lock:
            fail_add = self.mock.fail_reaction_add
            failure_status = self.mock.reaction_add_failure_status
        if fail_add:
            self._send_json(
                failure_status, {"message": "Reaction add unavailable"}
            )
            return
        with self.mock.lock:
            if number not in self.mock.issues:
                self._send_json(404, {"message": "Not Found"})
                return
            reaction = self.mock.add_reaction(number, login, content)
            self.mock.reaction_write_epoch += 1
            lose_response = self.mock.lose_reaction_response_mode == "add"
        if lose_response:
            self._drop_response()
            return
        self._send_json(201, reaction)

    def _delete_reaction(self, number: int, reaction_id: int) -> None:
        token, login = self._require_write()
        if token is None:
            return
        with self.mock.lock:
            fail_delete = self.mock.fail_reaction_delete
            failure_status = self.mock.reaction_delete_failure_status
        if fail_delete:
            self._send_json(
                failure_status, {"message": "Reaction delete unavailable"}
            )
            return
        with self.mock.lock:
            found = None
            for reaction in self.mock.reactions.get(number, []):
                if reaction["id"] == reaction_id:
                    found = reaction
                    break
            if found is None:
                self._send_json(404, {"message": "Not Found"})
                return
            if found["user"]["login"] != login:
                self._send_json(403, {"message": "Forbidden"})
                return
            self.mock.reactions[number].remove(found)
            self.mock.reaction_write_epoch += 1
            lose_response = self.mock.lose_reaction_response_mode == "delete"
        if lose_response:
            self._drop_response()
            return
        self._send_json(204, None)

    def _send_page(
        self, items: list[dict[str, Any]], query: dict[str, list[str]]
    ) -> None:
        try:
            per_page = int((query.get("per_page") or ["30"])[0])
            page = int((query.get("page") or ["1"])[0])
        except ValueError:
            per_page, page = 30, 1
        per_page = max(1, min(per_page, 100))
        page = max(1, page)
        start = (page - 1) * per_page
        self._send_json(200, items[start : start + per_page])

    def _drop_response(self) -> None:
        """Close the socket after an applied write to simulate a lost reply."""
        self.close_connection = True
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.connection.close()
        except OSError:
            pass

    def _send_json(
        self,
        status: int,
        payload: Any,
        headers: Optional[dict[str, str]] = None,
    ) -> None:
        if status == 204 or payload is None:
            data = b""
        else:
            data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-GitHub-Api-Version", "2022-11-28")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if data:
            self.wfile.write(data)

    def _send_redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()


class _BadRequest(Exception):
    pass
