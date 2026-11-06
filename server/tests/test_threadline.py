"""End-to-end HTTP tests for the Threadline service.

The tests use a local mock for both GitHub OAuth and the GitHub REST API.  All
service interactions go through real HTTP sockets and a persistent cookiejar.
"""

from __future__ import annotations

import contextlib
import json
import pathlib
import re
import sqlite3
import tempfile
import threading
import unittest
import urllib.parse

from tests.mock_github import (
    ATTACHMENT_TOKEN,
    CLIENT_SECRET,
    READ_TOKEN,
    MockGitHub,
)
from tests.support import (
    SITE_ORIGIN,
    SITE_RETURN,
    Client,
    RunningService,
    auth_headers,
    login,
    make_png,
)


class ServiceTestBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory()
        cls.temp_path = pathlib.Path(cls.temp.name)
        cls.mock = MockGitHub().start()
        cls.service = RunningService(cls.mock, cls.temp_path)
        cls.article_counter = 0

    @classmethod
    def tearDownClass(cls) -> None:
        cls.service.stop()
        cls.mock.stop()
        cls.temp.cleanup()

    def setUp(self) -> None:
        self.mock.set_write_failure(None)
        self.mock.clear_comment_list_failures()
        self.mock.clear_reaction_list_failures()
        self.mock.set_reaction_failure(None)
        self.mock.set_reaction_lost_response(None)

    def tearDown(self) -> None:
        self.mock.set_write_failure(None)
        self.mock.clear_comment_list_failures()
        self.mock.clear_reaction_list_failures()
        self.mock.set_reaction_failure(None)
        self.mock.set_reaction_lost_response(None)
        self.mock.finish_comment_hold()

    def unique(self, prefix: str) -> str:
        type(self).article_counter += 1
        return f"{prefix}-{type(self).article_counter}"

    def client_with(self, user: str) -> tuple[Client, dict]:
        client = self.service.client()
        session = login(client, self.mock, user)
        return client, session

    def post_comment(
        self,
        client: Client,
        session: dict,
        comment_id: str,
        body: str,
        *,
        visibility: str = "public",
        effect: str = "off",
        title: str = "Test article",
        article_url: str = SITE_ORIGIN + "/posts/test",
        quote=None,
        submission_id=None,
        headers: dict | None = None,
    ):
        request_headers = auth_headers(session)
        if headers is not None:
            request_headers = headers
        payload = {
            "body": body,
            "visibility": visibility,
            "effect": effect,
            "title": title,
            "articleUrl": article_url,
        }
        if quote is not None:
            payload["quote"] = quote
        if submission_id is not None:
            payload["submissionId"] = submission_id
        return client.post(
            f"/api/articles/{comment_id}/comments",
            json_body=payload,
            headers=request_headers,
        )

    def get_article(self, client: Client, comment_id: str):
        return client.get(f"/api/articles/{comment_id}")


class CoreServiceTests(ServiceTestBase):
    def test_health_and_cors_preflight(self) -> None:
        client = self.service.client()
        health = client.get("/api/health")
        self.assertEqual(health.status, 200)
        self.assertEqual(health.json(), {"ok": True})

        preflight = client.request(
            "OPTIONS",
            "/api/session",
            headers={
                "Origin": SITE_ORIGIN,
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "X-CSRF-Token",
            },
        )
        self.assertEqual(preflight.status, 204)
        self.assertEqual(preflight.header("Access-Control-Allow-Origin"), SITE_ORIGIN)
        self.assertEqual(
            preflight.header("Access-Control-Allow-Credentials"), "true"
        )
        self.assertIn("Origin", preflight.header("Vary", ""))
        self.assertIn(
            "X-CSRF-Token", preflight.header("Access-Control-Allow-Headers", "")
        )
        self.assertIn(
            "Content-Type", preflight.header("Access-Control-Allow-Headers", "")
        )

        rejected = client.request(
            "OPTIONS",
            "/api/session",
            headers={"Origin": "https://evil.example"},
        )
        self.assertEqual(rejected.status, 403)
        self.assertIsNone(rejected.header("Access-Control-Allow-Origin"))
        self.assertEqual(rejected.json()["error"]["code"], "origin_not_allowed")

        session = client.get("/api/session", headers={"Origin": SITE_ORIGIN})
        self.assertEqual(session.header("Access-Control-Allow-Origin"), SITE_ORIGIN)
        self.assertEqual(session.header("Cache-Control"), "no-store")
        self.assertIn("Origin", session.header("Vary", ""))

    def test_session_anonymous_contract(self) -> None:
        client = self.service.client()
        response = client.get("/api/session")
        self.assertEqual(response.status, 200)
        payload = response.json()
        self.assertEqual(
            set(payload),
            {"authenticated", "viewer", "csrfToken", "config"},
        )
        self.assertFalse(payload["authenticated"])
        self.assertIsNone(payload["viewer"])
        self.assertIsNone(payload["csrfToken"])
        config = payload["config"]
        self.assertEqual(config["repository"], "acme/comments")
        self.assertEqual(config["blogger"], "blogger")
        self.assertTrue(config["commentsEnabled"])
        self.assertTrue(config["authConfigured"])
        self.assertEqual(config["attachments"]["enabled"], False)
        self.assertEqual(config["attachments"]["maxBytes"], 5242880)
        self.assertEqual(config["attachments"]["scope"], "public")
        self.assertIsInstance(config["attachments"]["allowedTypes"], list)
        self.assertNotIn("access_token", response.text())
        self.assertNotIn("csrf_token", response.text())
        self.assertEqual(response.header("Cache-Control"), "no-store")

    def test_oauth_login_callback_and_logout(self) -> None:
        client = self.service.client()
        start = client.get(
            "/api/auth/github?returnTo=" + urllib.parse.quote(SITE_RETURN, safe="")
        )
        self.assertEqual(start.status, 302)
        authorize_location = start.header("Location")
        self.assertTrue(authorize_location)
        authorize = urllib.parse.urlsplit(authorize_location)
        query = urllib.parse.parse_qs(authorize.query)
        self.assertEqual(query["client_id"], ["test-client-id"])
        self.assertEqual(query["redirect_uri"], [self.service.base_url + "/api/auth/callback"])
        self.assertEqual(query["response_type"], ["code"])
        self.assertIn("state", query)
        self.assertNotIn("scope", query)
        self.assertNotIn(CLIENT_SECRET, authorize_location)
        state_cookie_header = start.header("Set-Cookie")
        self.assertIn("threadline_oauth_state=", state_cookie_header or "")
        self.assertIn("HttpOnly", state_cookie_header or "")
        state_cookie_value = client.cookie_value("threadline_oauth_state")
        self.assertTrue(state_cookie_value)

        authorize_response = client.get(authorize_location + "&login=alice")
        self.assertEqual(authorize_response.status, 302)
        callback_location = authorize_response.header("Location")
        self.assertTrue(callback_location)
        callback = client.get(callback_location)
        self.assertEqual(callback.status, 302)
        returned = callback.header("Location")
        self.assertTrue(returned)
        self.assertTrue(returned.startswith(SITE_ORIGIN + "/posts/example?"))
        returned_query = urllib.parse.parse_qs(urllib.parse.urlsplit(returned).query)
        self.assertEqual(returned_query["auth"], ["ok"])
        self.assertEqual(returned_query["from"], ["oauth"])
        self.assertNotIn("access_token", returned)
        self.assertNotIn("code=", returned)
        callback_cookies = callback.header_all("Set-Cookie")
        session_cookie_header = next(
            (value for value in callback_cookies if "threadline_session=" in value),
            "",
        )
        self.assertIn("threadline_session=", session_cookie_header)
        self.assertIn("HttpOnly", session_cookie_header)
        self.assertIn("SameSite=Lax", session_cookie_header)
        self.assertIsNone(client.cookie_value("threadline_oauth_state"))
        session_cookie_value = client.cookie_value("threadline_session")
        self.assertTrue(session_cookie_value)

        session = client.get("/api/session").json()
        self.assertTrue(session["authenticated"])
        self.assertEqual(session["viewer"]["login"], "alice")
        self.assertEqual(session["viewer"]["name"], "Alice Example")
        self.assertIsInstance(session["csrfToken"], str)
        self.assertNotIn("access_token", json.dumps(session))
        self.assertNotIn("token-alice", json.dumps(session))

        logout = client.post(
            "/api/auth/logout",
            headers=auth_headers(session),
        )
        self.assertEqual(logout.status, 204)
        self.assertEqual(logout.body, b"")
        clear_cookie = logout.header("Set-Cookie")
        self.assertIn("Max-Age=0", clear_cookie or "")
        self.assertIsNone(client.cookie_value("threadline_session"))
        self.assertFalse(client.get("/api/session").json()["authenticated"])

        # A copied cookie value is useless after logout because the session is
        # held only in server memory.
        replay = client.get(
            "/api/session",
            headers={"Cookie": f"threadline_session={session_cookie_value}"},
        )
        self.assertFalse(replay.json()["authenticated"])

    def test_oauth_invalid_return_to_and_state(self) -> None:
        client = self.service.client()
        evil = client.get(
            "/api/auth/github?returnTo="
            + urllib.parse.quote("https://evil.example/steal", safe="")
        )
        self.assertEqual(evil.status, 400)
        self.assertEqual(evil.json()["error"]["code"], "invalid_return_to")
        self.assertIsNone(evil.header("Location"))

        backslash = client.get(
            "/api/auth/github?returnTo="
            + urllib.parse.quote(
                "http://127.0.0.1:1313\\@evil.example/steal", safe=""
            )
        )
        self.assertEqual(backslash.status, 400)
        self.assertEqual(backslash.json()["error"]["code"], "invalid_return_to")

        missing = client.get("/api/auth/github")
        self.assertEqual(missing.status, 400)
        self.assertEqual(missing.json()["error"]["code"], "invalid_return_to")

        callback = client.get("/api/auth/callback?code=fake&state=not-a-state")
        self.assertEqual(callback.status, 400)
        self.assertEqual(callback.json()["error"]["code"], "invalid_state")
        self.assertIsNone(callback.header("Location"))

        # A state is bound to both the server-side record and its HttpOnly
        # cookie.  A different client cannot complete the flow.
        start = client.get(
            "/api/auth/github?returnTo=" + urllib.parse.quote(SITE_RETURN, safe="")
        )
        state = urllib.parse.parse_qs(
            urllib.parse.urlsplit(start.header("Location") or "").query
        )["state"][0]
        other_client = self.service.client()
        other = other_client.get(f"/api/auth/callback?code=fake&state={state}")
        self.assertEqual(other.status, 400)
        self.assertEqual(other.json()["error"]["code"], "invalid_state")

    def test_state_changes_require_csrf_and_origin(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("csrf")
        payload = {
            "body": "CSRF test",
            "visibility": "public",
            "effect": "off",
            "title": "CSRF",
            "articleUrl": SITE_ORIGIN + "/posts/csrf",
        }
        missing_csrf = client.post(
            f"/api/articles/{comment_id}/comments",
            json_body=payload,
            headers={"Origin": SITE_ORIGIN},
        )
        self.assertEqual(missing_csrf.status, 403)
        self.assertEqual(missing_csrf.json()["error"]["code"], "csrf_invalid")

        bad_csrf = client.post(
            f"/api/articles/{comment_id}/comments",
            json_body=payload,
            headers={"X-CSRF-Token": "wrong", "Origin": SITE_ORIGIN},
        )
        self.assertEqual(bad_csrf.status, 403)
        self.assertEqual(bad_csrf.json()["error"]["code"], "csrf_invalid")

        bad_origin = client.post(
            f"/api/articles/{comment_id}/comments",
            json_body=payload,
            headers={
                "X-CSRF-Token": session["csrfToken"],
                "Origin": "https://evil.example",
            },
        )
        self.assertEqual(bad_origin.status, 403)
        self.assertEqual(bad_origin.json()["error"]["code"], "origin_not_allowed")
        self.assertIsNone(bad_origin.header("Access-Control-Allow-Origin"))

        anonymous = self.service.client()
        unauth = anonymous.post(
            f"/api/articles/{comment_id}/comments",
            json_body=payload,
            headers={"X-CSRF-Token": "anything", "Origin": SITE_ORIGIN},
        )
        self.assertEqual(unauth.status, 401)
        self.assertEqual(unauth.json()["error"]["code"], "authentication_required")

        # Origin is required only when the browser sends it.  Non-browser
        # clients still need the CSRF token.
        no_origin = client.post(
            f"/api/articles/{comment_id}/comments",
            json_body=payload,
            headers={"X-CSRF-Token": session["csrfToken"]},
        )
        self.assertEqual(no_origin.status, 201, no_origin.text())

    def test_article_without_issue(self) -> None:
        client = self.service.client()
        comment_id = self.unique("empty")
        response = self.get_article(client, comment_id)
        self.assertEqual(response.status, 200)
        payload = response.json()
        self.assertEqual(
            payload,
            {
                "commentId": comment_id,
                "available": True,
                "issueNumber": None,
                "issueUrl": None,
                "comments": [],
                "commentCount": 0,
                "reactions": {"like": 0, "dislike": 0, "viewer": None},
            },
        )
        self.assertEqual(response.header("Cache-Control"), "no-store")
        self.assertEqual(self.mock.issue_numbers_for(comment_id), [])

        invalid = self.get_article(client, "-bad-id")
        self.assertEqual(invalid.status, 400)
        self.assertEqual(invalid.json()["error"]["code"], "invalid_comment_id")

    def test_issue_creation_idempotency_and_search_fallback(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("idempotent")
        first = self.post_comment(
            client,
            session,
            comment_id,
            "first comment",
            title="Stable article title",
        )
        self.assertEqual(first.status, 201, first.text())
        issue_numbers = self.mock.issue_numbers_for(comment_id)
        self.assertEqual(len(issue_numbers), 1)
        issue = self.mock.issues[issue_numbers[0]]
        self.assertTrue(issue["title"].startswith(f"[threadline:{comment_id}] "))
        self.assertIn("<!-- threadline-comment-id: " + comment_id + " -->", issue["body"])
        self.assertIn("public", issue["body"].lower())
        self.assertLessEqual(len(issue["title"]), 256)

        second = self.post_comment(
            client, session, comment_id, "second comment"
        )
        self.assertEqual(second.status, 201, second.text())
        self.assertEqual(len(self.mock.issue_numbers_for(comment_id)), 1)

        with contextlib.closing(
            sqlite3.connect(self.service.config.database_path)
        ) as connection:
            connection.execute(
                "DELETE FROM article_issues WHERE comment_id = ?", (comment_id,)
            )
            connection.commit()
        article = self.get_article(self.service.client(), comment_id)
        self.assertEqual(article.status, 200)
        self.assertEqual(article.json()["issueNumber"], issue_numbers[0])
        self.assertEqual(len(self.mock.issue_numbers_for(comment_id)), 1)
        with contextlib.closing(
            sqlite3.connect(self.service.config.database_path)
        ) as connection:
            row = connection.execute(
                "SELECT issue_number FROM article_issues WHERE comment_id = ?",
                (comment_id,),
            ).fetchone()
        self.assertEqual(row[0], issue_numbers[0])

        # Fallback search picks the lowest matching issue number.
        seeded_id = self.unique("lowest")
        high = self.mock.add_issue(
            f"[threadline:{seeded_id}] High", number=900
        )
        low = self.mock.add_issue(
            f"[threadline:{seeded_id}] Low", number=50
        )
        self.assertLess(low, high)
        seeded = self.get_article(self.service.client(), seeded_id)
        self.assertEqual(seeded.status, 200)
        self.assertEqual(seeded.json()["issueNumber"], low)

    def test_comment_metadata_stripping_and_viewer_token(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("metadata")
        response = self.post_comment(
            client,
            session,
            comment_id,
            "A formatted comment",
            visibility="public",
            effect="subtle",
            title="Metadata article",
        )
        self.assertEqual(response.status, 201, response.text())
        payload = response.json()
        self.assertEqual(payload["comment"]["body"], "A formatted comment")
        self.assertEqual(payload["comment"]["visibility"], "public")
        self.assertEqual(payload["comment"]["effect"], "subtle")
        self.assertTrue(payload["comment"]["isAuthor"])
        self.assertEqual(payload["comment"]["author"]["login"], "alice")
        self.assertEqual(payload["commentCount"], 1)
        self.assertFalse(payload["duplicate"])
        self.assertFalse(payload["refreshFailed"])
        self.assertIsNone(payload["comment"]["quote"])
        self.assertNotIn("threadline-meta", response.text())

        issue_number = self.mock.issue_numbers_for(comment_id)[0]
        raw_body = self.mock.comments[issue_number][-1]["body"]
        marker = re.search(
            r"<!-- threadline-meta (\{.*?\}) -->", raw_body, re.DOTALL
        )
        self.assertIsNotNone(marker)
        metadata = json.loads(marker.group(1))
        self.assertEqual(metadata["version"], 1)
        self.assertEqual(metadata["visibility"], "public")
        self.assertEqual(metadata["effect"], "subtle")
        self.assertRegex(metadata["submission"], r"^[0-9a-f]{64}$")
        self.assertNotIn("quote", metadata)
        self.assertTrue(raw_body.endswith("-->"))
        self.assertIn("A formatted comment\n\n", raw_body)

        # A malformed or manually-added marker is stripped and defaults back to
        # public/off.  The service always takes the last valid marker.
        self.mock.add_comment(
            issue_number,
            "bob",
            "plain text\n\n<!-- threadline-meta not-json -->",
        )
        self.mock.add_comment(
            issue_number,
            "bob",
            "bad metadata\n\n<!-- threadline-meta "
            '{"version":1,"visibility":[],"effect":{}} -->',
        )
        article = self.get_article(self.service.client(), comment_id).json()
        bob_comments = [
            item for item in article["comments"] if item["author"]["login"] == "bob"
        ]
        self.assertEqual(len(bob_comments), 2)
        self.assertEqual(bob_comments[0]["body"], "plain text")
        self.assertEqual(bob_comments[0]["visibility"], "public")
        self.assertEqual(bob_comments[0]["effect"], "off")
        self.assertEqual(bob_comments[1]["body"], "bad metadata")
        self.assertEqual(bob_comments[1]["visibility"], "public")
        self.assertEqual(bob_comments[1]["effect"], "off")

        writes = [
            write
            for write in self.mock.write_requests
            if f"/issues/{issue_number}" in write["path"]
            or write["path"].endswith("/issues")
        ]
        self.assertTrue(writes)
        self.assertTrue(
            all(write["token"] in {"token-alice"} for write in writes),
            writes,
        )
        self.assertNotIn(READ_TOKEN, [write["token"] for write in writes])
        self.assertIn(READ_TOKEN, self.mock.read_tokens)
        self.assertTrue(
            all(
                version == "2022-11-28"
                for version in self.mock.api_version_headers
                if version is not None
            )
        )

    def test_public_commenter_blogger_visibility_filtering(self) -> None:
        alice, alice_session = self.client_with("alice")
        bob, bob_session = self.client_with("bob")
        blogger, blogger_session = self.client_with("blogger")
        anonymous = self.service.client()
        comment_id = self.unique("visibility")

        author_only = self.post_comment(
            alice,
            alice_session,
            comment_id,
            "author only",
            visibility="commenter",
        )
        self.assertEqual(author_only.status, 201, author_only.text())
        public = self.post_comment(
            bob, bob_session, comment_id, "public body", visibility="public"
        )
        self.assertEqual(public.status, 201, public.text())
        blogger_only = self.post_comment(
            blogger,
            blogger_session,
            comment_id,
            "blogger only",
            visibility="blogger",
        )
        self.assertEqual(blogger_only.status, 201, blogger_only.text())

        anon_article = self.get_article(anonymous, comment_id).json()
        self.assertEqual(
            [item["body"] for item in anon_article["comments"]], ["public body"]
        )
        self.assertEqual(anon_article["commentCount"], 1)
        self.assertFalse(anon_article["comments"][0]["isAuthor"])

        alice_article = self.get_article(alice, comment_id).json()
        self.assertEqual(
            [item["body"] for item in alice_article["comments"]],
            ["author only", "public body"],
        )
        self.assertTrue(alice_article["comments"][0]["isAuthor"])
        self.assertEqual(alice_article["commentCount"], 2)

        bob_article = self.get_article(bob, comment_id).json()
        self.assertEqual(
            [item["body"] for item in bob_article["comments"]], ["public body"]
        )

        blogger_article = self.get_article(blogger, comment_id).json()
        self.assertEqual(
            [item["body"] for item in blogger_article["comments"]],
            ["public body", "blogger only"],
        )
        self.assertTrue(blogger_article["comments"][1]["isAuthor"])
        self.assertEqual(blogger_article["commentCount"], 2)
        created_values = [
            item["createdAt"] for item in blogger_article["comments"]
        ]
        self.assertEqual(created_values, sorted(created_values))

    def test_duplicate_submission(self) -> None:
        client, session = self.client_with("alice")
        other, other_session = self.client_with("bob")
        comment_id = self.unique("duplicate")
        payload = dict(
            body="identical submission",
            visibility="public",
            effect="off",
            title="Duplicate",
            article_url=SITE_ORIGIN + "/posts/duplicate",
        )
        first = self.post_comment(
            client,
            session,
            comment_id,
            payload["body"],
            visibility=payload["visibility"],
            effect=payload["effect"],
            title=payload["title"],
            article_url=payload["article_url"],
        )
        self.assertEqual(first.status, 201, first.text())
        duplicate = self.post_comment(
            client,
            session,
            comment_id,
            payload["body"],
            visibility=payload["visibility"],
            effect=payload["effect"],
            title=payload["title"],
            article_url=payload["article_url"],
        )
        self.assertEqual(duplicate.status, 200, duplicate.text())
        duplicate_payload = duplicate.json()
        self.assertTrue(duplicate_payload["duplicate"])
        self.assertFalse(duplicate_payload["refreshFailed"])
        self.assertEqual(duplicate_payload["commentCount"], 1)
        self.assertEqual(
            duplicate_payload["comment"]["id"],
            first.json()["comment"]["id"],
        )
        issue_number = self.mock.issue_numbers_for(comment_id)[0]
        self.assertEqual(len(self.mock.comments[issue_number]), 1)

        # Completed retries stay idempotent; they are not time-windowed.
        again = self.post_comment(
            client,
            session,
            comment_id,
            payload["body"],
            visibility=payload["visibility"],
            effect=payload["effect"],
            title=payload["title"],
            article_url=payload["article_url"],
        )
        self.assertEqual(again.status, 200, again.text())
        self.assertTrue(again.json()["duplicate"])
        self.assertEqual(len(self.mock.comments[issue_number]), 1)

        other_user = self.post_comment(
            other,
            other_session,
            comment_id,
            payload["body"],
            visibility=payload["visibility"],
            effect=payload["effect"],
            title=payload["title"],
            article_url=payload["article_url"],
        )
        self.assertEqual(other_user.status, 201, other_user.text())

        different = self.post_comment(
            client, session, comment_id, "a different body"
        )
        self.assertEqual(different.status, 201, different.text())

    def test_submission_id_distinguishes_intentional_duplicates(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("submission-intent")
        body = "the same text on purpose"
        first_id = f"intent_{comment_id}_one"
        second_id = f"intent_{comment_id}_two"

        first = self.post_comment(
            client, session, comment_id, body, submission_id=first_id
        )
        self.assertEqual(first.status, 201, first.text())
        second = self.post_comment(
            client, session, comment_id, body, submission_id=second_id
        )
        self.assertEqual(second.status, 201, second.text())
        self.assertNotEqual(
            first.json()["comment"]["id"], second.json()["comment"]["id"]
        )
        issue_number = self.mock.issue_numbers_for(comment_id)[0]
        self.assertEqual(len(self.mock.comments[issue_number]), 2)

        repeated = self.post_comment(
            client, session, comment_id, body, submission_id=first_id
        )
        self.assertEqual(repeated.status, 200, repeated.text())
        self.assertTrue(repeated.json()["duplicate"])
        self.assertEqual(
            repeated.json()["comment"]["id"], first.json()["comment"]["id"]
        )
        self.assertEqual(len(self.mock.comments[issue_number]), 2)

        changed = self.post_comment(
            client,
            session,
            comment_id,
            "changed payload with the same submission id",
            submission_id=first_id,
        )
        self.assertEqual(changed.status, 201, changed.text())
        self.assertNotEqual(
            changed.json()["comment"]["id"], first.json()["comment"]["id"]
        )
        self.assertEqual(len(self.mock.comments[issue_number]), 3)

        original_retry = self.post_comment(
            client, session, comment_id, body, submission_id=first_id
        )
        self.assertEqual(original_retry.status, 200, original_retry.text())
        self.assertEqual(
            original_retry.json()["comment"]["id"],
            first.json()["comment"]["id"],
        )
        self.assertEqual(len(self.mock.comments[issue_number]), 3)

    def test_submission_id_retry_after_refresh_failure_is_idempotent(
        self,
    ) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("submission-refresh-retry")
        submission_id = f"refresh_{comment_id}"
        self.mock.fail_comment_lists_after_write()
        first = self.post_comment(
            client,
            session,
            comment_id,
            "saved with a submission id",
            submission_id=submission_id,
        )
        self.assertEqual(first.status, 201, first.text())
        self.assertTrue(first.json()["refreshFailed"])
        first_id = first.json()["comment"]["id"]
        issue_number = self.mock.issue_numbers_for(comment_id)[0]

        retry = self.post_comment(
            client,
            session,
            comment_id,
            "saved with a submission id",
            submission_id=submission_id,
        )
        self.assertEqual(retry.status, 200, retry.text())
        payload = retry.json()
        self.assertTrue(payload["duplicate"])
        self.assertFalse(payload["refreshFailed"])
        self.assertEqual(payload["commentCount"], 1)
        self.assertEqual(payload["comment"]["id"], first_id)
        self.assertEqual(len(self.mock.comments[issue_number]), 1)

    def test_invalid_submission_id_is_rejected(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("submission-invalid")
        invalid_values = [
            "",
            "short",
            "a" * 15,
            "a" * 129,
            "bad id",
            "bad/id",
            "bad.id",
            "返回" * 8,
            None,
            42,
            [],
            True,
            {},
        ]
        for value in invalid_values:
            with self.subTest(value=repr(value)[:40]):
                response = client.post(
                    f"/api/articles/{comment_id}/comments",
                    json_body={
                        "body": "invalid submission id",
                        "visibility": "public",
                        "effect": "off",
                        "submissionId": value,
                    },
                    headers=auth_headers(session),
                )
                self.assertEqual(response.status, 400, response.text())
                self.assertEqual(
                    response.json()["error"]["code"], "invalid_request"
                )
                self.assertIn(
                    "submissionId", response.json()["error"]["message"]
                )
        self.assertEqual(self.mock.issue_numbers_for(comment_id), [])

    def test_duplicate_inflight_guard(self) -> None:
        first_client, first_session = self.client_with("alice")
        second_client, second_session = self.client_with("alice")
        comment_id = self.unique("inflight")
        payload = dict(
            body="same concurrent comment",
            visibility="public",
            effect="off",
            title="Concurrent",
            article_url=SITE_ORIGIN + "/posts/inflight",
        )
        self.mock.hold_next_comment_write()
        first_result: dict = {}

        def send_first() -> None:
            try:
                first_result["response"] = self.post_comment(
                    first_client,
                    first_session,
                    comment_id,
                    payload["body"],
                    visibility=payload["visibility"],
                    effect=payload["effect"],
                    title=payload["title"],
                    article_url=payload["article_url"],
                )
            except Exception as exc:  # pragma: no cover - diagnostic path
                first_result["error"] = exc

        worker = threading.Thread(target=send_first)
        worker.start()
        try:
            self.assertTrue(
                self.mock.comment_write_started.wait(timeout=3),
                "first comment never reached the mock",
            )
            concurrent = self.post_comment(
                second_client,
                second_session,
                comment_id,
                payload["body"],
                visibility=payload["visibility"],
                effect=payload["effect"],
                title=payload["title"],
                article_url=payload["article_url"],
            )
            self.assertEqual(concurrent.status, 409, concurrent.text())
            self.assertEqual(
                concurrent.json()["error"]["code"], "duplicate_submission"
            )
        finally:
            self.mock.finish_comment_hold()
            worker.join(timeout=5)
        self.assertFalse(worker.is_alive())
        self.assertNotIn("error", first_result)
        self.assertEqual(first_result["response"].status, 201)
        self.assertEqual(len(self.mock.issue_numbers_for(comment_id)), 1)
        immediate = self.post_comment(
            first_client,
            first_session,
            comment_id,
            payload["body"],
            visibility=payload["visibility"],
            effect=payload["effect"],
            title=payload["title"],
            article_url=payload["article_url"],
        )
        self.assertEqual(immediate.status, 200, immediate.text())
        self.assertTrue(immediate.json()["duplicate"])
        self.assertEqual(
            immediate.json()["comment"]["id"],
            first_result["response"].json()["comment"]["id"],
        )
        issue_number = self.mock.issue_numbers_for(comment_id)[0]
        self.assertEqual(len(self.mock.comments[issue_number]), 1)

    def test_reaction_toggle_switch_and_persistence(self) -> None:
        alice, alice_session = self.client_with("alice")
        bob, bob_session = self.client_with("bob")
        anonymous = self.service.client()
        comment_id = self.unique("reaction")
        context = {
            "title": "Reaction article",
            "articleUrl": SITE_ORIGIN + "/posts/reaction",
        }

        self.assertEqual(
            self.get_article(anonymous, comment_id).json()["reactions"],
            {"like": 0, "dislike": 0, "viewer": None},
        )

        like = alice.post(
            f"/api/articles/{comment_id}/reaction",
            json_body={"reaction": "like", **context},
            headers=auth_headers(alice_session),
        )
        self.assertEqual(like.status, 200, like.text())
        self.assertFalse(like.json()["partial"])
        self.assertEqual(
            like.json()["reactions"], {"like": 1, "dislike": 0, "viewer": "like"}
        )
        issue_numbers = self.mock.issue_numbers_for(comment_id)
        self.assertEqual(len(issue_numbers), 1)
        issue_number = issue_numbers[0]
        self.assertEqual(
            [item["content"] for item in self.mock.reactions[issue_number]],
            ["+1"],
        )

        anon_snapshot = self.get_article(anonymous, comment_id).json()["reactions"]
        self.assertEqual(anon_snapshot, {"like": 1, "dislike": 0, "viewer": None})
        alice_snapshot = self.get_article(alice, comment_id).json()["reactions"]
        self.assertEqual(
            alice_snapshot, {"like": 1, "dislike": 0, "viewer": "like"}
        )

        toggle_off = alice.post(
            f"/api/articles/{comment_id}/reaction",
            json_body={"reaction": "like", **context},
            headers=auth_headers(alice_session),
        )
        self.assertEqual(toggle_off.status, 200, toggle_off.text())
        self.assertEqual(
            toggle_off.json()["reactions"],
            {"like": 0, "dislike": 0, "viewer": None},
        )
        self.assertEqual(self.mock.reactions[issue_number], [])

        dislike = alice.post(
            f"/api/articles/{comment_id}/reaction",
            json_body={"reaction": "dislike", **context},
            headers=auth_headers(alice_session),
        )
        self.assertEqual(
            dislike.json()["reactions"],
            {"like": 0, "dislike": 1, "viewer": "dislike"},
        )

        switch = alice.post(
            f"/api/articles/{comment_id}/reaction",
            json_body={"reaction": "like", **context},
            headers=auth_headers(alice_session),
        )
        self.assertEqual(switch.status, 200, switch.text())
        self.assertEqual(
            switch.json()["reactions"],
            {"like": 1, "dislike": 0, "viewer": "like"},
        )
        alice_reactions = [
            item
            for item in self.mock.reactions[issue_number]
            if item["user"]["login"] == "alice"
        ]
        self.assertEqual([item["content"] for item in alice_reactions], ["+1"])

        bob_like = bob.post(
            f"/api/articles/{comment_id}/reaction",
            json_body={"reaction": "like", **context},
            headers=auth_headers(bob_session),
        )
        self.assertEqual(
            bob_like.json()["reactions"],
            {"like": 2, "dislike": 0, "viewer": "like"},
        )
        persisted = self.get_article(alice, comment_id).json()["reactions"]
        self.assertEqual(persisted, {"like": 2, "dislike": 0, "viewer": "like"})

        removed = alice.post(
            f"/api/articles/{comment_id}/reaction",
            json_body={"reaction": None, **context},
            headers=auth_headers(alice_session),
        )
        self.assertEqual(
            removed.json()["reactions"],
            {"like": 1, "dislike": 0, "viewer": None},
        )

        reaction_writes = [
            write
            for write in self.mock.write_requests
            if "/reactions" in write["path"]
        ]
        self.assertTrue(reaction_writes)
        self.assertTrue(
            all(write["token"] in {"token-alice", "token-bob"} for write in reaction_writes)
        )
        self.assertNotIn(READ_TOKEN, [write["token"] for write in reaction_writes])

    def _assert_github_failure(
        self, mode: str, expected_status: int, expected_code: str
    ) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique(f"failure-{mode}")
        self.mock.set_write_failure(mode)
        response = self.post_comment(
            client, session, comment_id, f"failure {mode}"
        )
        self.assertEqual(response.status, expected_status, response.text())
        self.assertEqual(response.json()["error"]["code"], expected_code)
        self.assertNotIn("token-alice", response.text())
        self.assertNotIn(READ_TOKEN, response.text())
        if mode == "rate_limit":
            self.assertEqual(response.header("Retry-After"), "7")
            self.assertIn("rate limit", response.json()["error"]["message"].lower())
        if mode == "permission":
            self.assertIn("permission", response.json()["error"]["message"].lower())
        if mode == "unavailable":
            self.assertIn("unavailable", response.json()["error"]["message"].lower())
        if mode == "unauthorized":
            self.assertIn("authorization", response.json()["error"]["message"].lower())
        if mode == "validation":
            self.assertIn("validation", response.json()["error"]["message"].lower())
        if mode == "not_found":
            self.assertIn("not found", response.json()["error"]["message"].lower())
        self.mock.set_write_failure(None)
        # Failed requests must not poison duplicate detection or create issues.
        self.assertEqual(self.mock.issue_numbers_for(comment_id), [])
        retry = self.post_comment(
            client, session, comment_id, f"failure {mode}"
        )
        self.assertEqual(retry.status, 201, retry.text())

    def test_github_rate_limit_mapping(self) -> None:
        self._assert_github_failure("rate_limit", 429, "rate_limited")

    def test_github_permission_mapping(self) -> None:
        self._assert_github_failure("permission", 403, "permission")

    def test_github_unavailable_mapping(self) -> None:
        self._assert_github_failure("unavailable", 502, "github_unavailable")

    def test_github_session_expired_mapping(self) -> None:
        self._assert_github_failure("unauthorized", 401, "session_expired")

    def test_github_validation_mapping(self) -> None:
        self._assert_github_failure("validation", 422, "validation")

    def test_github_not_found_mapping(self) -> None:
        self._assert_github_failure("not_found", 404, "not_found")

    def test_no_secrets_in_responses(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("secrets")
        post = self.post_comment(client, session, comment_id, "secret scan")
        session_response = client.get("/api/session")
        article = self.get_article(client, comment_id)
        bodies = "\n".join(
            [post.text(), session_response.text(), article.text()]
        )
        observed_cookie = client.cookie_value("threadline_session") or ""
        for forbidden in (
            CLIENT_SECRET,
            "token-alice",
            READ_TOKEN,
            ATTACHMENT_TOKEN,
            observed_cookie,
        ):
            self.assertNotIn(forbidden, bodies)
        self.assertNotIn("access_token", bodies)
        self.assertNotIn("accessToken", bodies)
        self.assertNotIn("client_secret", bodies)
        self.assertNotIn("authorization", bodies.lower())

    def test_comment_validation_limits(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("validation")
        for payload, expected in [
            (
                {
                    "body": "   ",
                    "visibility": "public",
                    "effect": "off",
                },
                400,
            ),
            (
                {
                    "body": "x" * 5001,
                    "visibility": "public",
                    "effect": "off",
                },
                400,
            ),
            (
                {
                    "body": "bad\u0000body",
                    "visibility": "public",
                    "effect": "off",
                },
                400,
            ),
            (
                {
                    "body": "bad visibility",
                    "visibility": "private",
                    "effect": "off",
                },
                400,
            ),
            (
                {
                    "body": "unhashable visibility",
                    "visibility": [],
                    "effect": "off",
                },
                400,
            ),
            (
                {
                    "body": "bad effect",
                    "visibility": "public",
                    "effect": "extreme",
                },
                400,
            ),
            (
                {
                    "body": "unhashable effect",
                    "visibility": "public",
                    "effect": {},
                },
                400,
            ),
            (
                {
                    "body": "bad title",
                    "visibility": "public",
                    "effect": "off",
                    "title": "x" * 201,
                },
                400,
            ),
            (
                {
                    "body": "bad url",
                    "visibility": "public",
                    "effect": "off",
                    "articleUrl": "javascript:alert(1)",
                },
                400,
            ),
        ]:
            with self.subTest(payload=str(payload)[:40]):
                response = client.post(
                    f"/api/articles/{comment_id}/comments",
                    json_body=payload,
                    headers=auth_headers(session),
                )
                self.assertEqual(response.status, expected, response.text())
        reaction_response = client.post(
            f"/api/articles/{comment_id}/reaction",
            json_body={"reaction": []},
            headers=auth_headers(session),
        )
        self.assertEqual(reaction_response.status, 400)
        self.assertEqual(
            reaction_response.json()["error"]["code"], "invalid_request"
        )
        self.assertEqual(self.mock.issue_numbers_for(comment_id), [])

    def test_comment_pagination_over_one_hundred(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("pagination")
        created = self.post_comment(
            client, session, comment_id, "first page"
        )
        self.assertEqual(created.status, 201, created.text())
        issue_number = self.mock.issue_numbers_for(comment_id)[0]
        for index in range(115):
            self.mock.add_comment(
                issue_number, "bob", f"paged comment {index:03d}"
            )
        article = self.get_article(self.service.client(), comment_id)
        self.assertEqual(article.status, 200, article.text())
        payload = article.json()
        self.assertEqual(payload["commentCount"], 116)
        self.assertEqual(len(payload["comments"]), 116)
        timestamps = [comment["createdAt"] for comment in payload["comments"]]
        self.assertEqual(timestamps, sorted(timestamps))


class CommentReliabilityTests(ServiceTestBase):
    def test_refresh_failure_after_write_returns_201(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("refresh-failure")
        quote = {
            "text": "刷新失败时仍保留",
            "prefix": "前文",
            "suffix": "后文",
            "offset": 3,
            "heading": "章节",
        }
        self.mock.fail_comment_lists_after_write()
        response = self.post_comment(
            client,
            session,
            comment_id,
            "saved despite a failed refresh",
            quote=quote,
        )
        self.assertEqual(response.status, 201, response.text())
        payload = response.json()
        self.assertFalse(payload["duplicate"])
        self.assertTrue(payload["refreshFailed"])
        self.assertIsNone(payload["commentCount"])
        self.assertIn("saved", payload["warning"].lower())
        self.assertEqual(
            payload["comment"]["body"], "saved despite a failed refresh"
        )
        self.assertEqual(payload["comment"]["quote"], quote)
        issue_number = self.mock.issue_numbers_for(comment_id)[0]
        self.assertEqual(len(self.mock.comments[issue_number]), 1)

    def test_retry_after_refresh_failure_is_idempotent(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("refresh-retry")
        self.mock.fail_comment_lists_after_write()
        first = self.post_comment(
            client, session, comment_id, "idempotent after refresh failure"
        )
        self.assertEqual(first.status, 201, first.text())
        self.assertTrue(first.json()["refreshFailed"])
        first_id = first.json()["comment"]["id"]
        issue_number = self.mock.issue_numbers_for(comment_id)[0]

        retry = self.post_comment(
            client, session, comment_id, "idempotent after refresh failure"
        )
        self.assertEqual(retry.status, 200, retry.text())
        payload = retry.json()
        self.assertTrue(payload["duplicate"])
        self.assertFalse(payload["refreshFailed"])
        self.assertEqual(payload["commentCount"], 1)
        self.assertEqual(payload["comment"]["id"], first_id)
        self.assertEqual(len(self.mock.comments[issue_number]), 1)

    def test_retry_after_mock_read_recovers(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("read-recovery")
        self.mock.fail_comment_lists_after_write(None)
        first = self.post_comment(
            client, session, comment_id, "write survives a read outage"
        )
        self.assertEqual(first.status, 201, first.text())
        self.assertTrue(first.json()["refreshFailed"])
        issue_number = self.mock.issue_numbers_for(comment_id)[0]
        self.assertEqual(len(self.mock.comments[issue_number]), 1)

        blocked = self.post_comment(
            client, session, comment_id, "write survives a read outage"
        )
        self.assertEqual(blocked.status, 502, blocked.text())
        self.assertEqual(
            blocked.json()["error"]["code"], "github_unavailable"
        )
        self.assertEqual(len(self.mock.comments[issue_number]), 1)

        self.mock.clear_comment_list_failures()
        retry = self.post_comment(
            client, session, comment_id, "write survives a read outage"
        )
        self.assertEqual(retry.status, 200, retry.text())
        self.assertTrue(retry.json()["duplicate"])
        self.assertEqual(
            retry.json()["comment"]["id"], first.json()["comment"]["id"]
        )
        self.assertEqual(len(self.mock.comments[issue_number]), 1)

    def test_prewrite_list_failure_writes_nothing(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("prewrite-failure")
        first = self.post_comment(client, session, comment_id, "seed comment")
        self.assertEqual(first.status, 201, first.text())
        issue_number = self.mock.issue_numbers_for(comment_id)[0]
        before = list(self.mock.comments[issue_number])

        self.mock.fail_next_comment_lists()
        response = self.post_comment(
            client, session, comment_id, "must not be written"
        )
        self.assertEqual(response.status, 502, response.text())
        self.assertEqual(
            response.json()["error"]["code"], "github_unavailable"
        )
        self.assertEqual(self.mock.comments[issue_number], before)
        self.assertFalse(
            any(
                "must not be written" in comment["body"]
                for comment in self.mock.comments[issue_number]
            )
        )

        retry = self.post_comment(
            client, session, comment_id, "must not be written"
        )
        self.assertEqual(retry.status, 201, retry.text())
        self.assertEqual(len(self.mock.comments[issue_number]), 2)

    def test_prewrite_list_failure_on_new_article_writes_no_comment(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("prewrite-new")
        self.mock.fail_next_comment_lists()
        response = self.post_comment(
            client, session, comment_id, "new article must not be written"
        )
        self.assertEqual(response.status, 502, response.text())
        for issue_number in self.mock.issue_numbers_for(comment_id):
            self.assertEqual(self.mock.comments[issue_number], [])

        self.mock.clear_comment_list_failures()
        retry = self.post_comment(
            client, session, comment_id, "new article must not be written"
        )
        self.assertEqual(retry.status, 201, retry.text())
        issue_numbers = self.mock.issue_numbers_for(comment_id)
        self.assertEqual(len(issue_numbers), 1)
        self.assertEqual(len(self.mock.comments[issue_numbers[0]]), 1)

    def test_legacy_v1_marker_without_submission_still_parses(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("legacy-marker")
        created = self.post_comment(client, session, comment_id, "new marker")
        self.assertEqual(created.status, 201, created.text())
        issue_number = self.mock.issue_numbers_for(comment_id)[0]
        self.mock.add_comment(
            issue_number,
            "alice",
            "legacy body\n\n<!-- threadline-meta "
            '{"version":1,"visibility":"commenter","effect":"strong"} -->',
        )
        article = self.get_article(client, comment_id)
        self.assertEqual(article.status, 200, article.text())
        legacy = next(
            comment
            for comment in article.json()["comments"]
            if comment["body"] == "legacy body"
        )
        self.assertEqual(legacy["visibility"], "commenter")
        self.assertEqual(legacy["effect"], "strong")
        self.assertIsNone(legacy["quote"])


class QuoteMetadataTests(ServiceTestBase):
    def test_unicode_multiline_quote_round_trip(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("quote-round-trip")
        quote = {
            "text": "  第一行\n第二行 --> <script>&中文  ",
            "prefix": "前文",
            "suffix": "后文",
            "offset": 1234,
            "heading": "章节标题",
        }
        expected = {
            "text": "第一行\n第二行 --> <script>&中文",
            "prefix": "前文",
            "suffix": "后文",
            "offset": 1234,
            "heading": "章节标题",
        }
        response = self.post_comment(
            client, session, comment_id, "quoted comment", quote=quote
        )
        self.assertEqual(response.status, 201, response.text())
        self.assertEqual(response.json()["comment"]["quote"], expected)
        self.assertNotIn("threadline-meta", response.text())

        article = self.get_article(self.service.client(), comment_id)
        self.assertEqual(article.status, 200, article.text())
        self.assertEqual(article.json()["comments"][0]["quote"], expected)

        issue_number = self.mock.issue_numbers_for(comment_id)[0]
        raw_body = self.mock.comments[issue_number][-1]["body"]
        self.assertEqual(raw_body.count("-->"), 1)
        marker = re.search(
            r"<!-- threadline-meta (\{.*?\}) -->", raw_body, re.DOTALL
        )
        self.assertIsNotNone(marker)
        metadata = json.loads(marker.group(1))
        self.assertEqual(metadata["quote"], expected)
        marker_text = marker.group(0)
        self.assertNotIn("<script>", marker_text)
        self.assertIn("\\u003c", marker_text)
        self.assertIn("\\u003e", marker_text)
        self.assertIn("\\u0026", marker_text)

    def test_quote_cannot_terminate_the_metadata_marker(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("quote-breakout")
        text = 'safe --> <!-- threadline-meta {"version":1} --> end'
        response = self.post_comment(
            client,
            session,
            comment_id,
            "marker breakout attempt",
            quote={"text": text, "prefix": "a-->b", "suffix": "c<d", "offset": 0},
        )
        self.assertEqual(response.status, 201, response.text())
        self.assertEqual(response.json()["comment"]["quote"]["text"], text)
        issue_number = self.mock.issue_numbers_for(comment_id)[0]
        raw_body = self.mock.comments[issue_number][-1]["body"]
        self.assertEqual(raw_body.count("-->"), 1)
        self.assertEqual(raw_body.count("<!--"), 1)
        marker = re.search(
            r"<!-- threadline-meta (\{.*?\}) -->", raw_body, re.DOTALL
        )
        self.assertIsNotNone(marker)
        metadata = json.loads(marker.group(1))
        self.assertEqual(metadata["quote"]["text"], text)
        self.assertEqual(metadata["quote"]["prefix"], "a-->b")
        self.assertEqual(metadata["quote"]["suffix"], "c<d")

    def test_same_quote_text_with_different_context_is_distinct(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("quote-context")
        first_quote = {
            "text": "重复的文本",
            "prefix": "前文 A",
            "suffix": "后文 A",
            "offset": 10,
            "heading": "第一节",
        }
        second_quote = {
            "text": "重复的文本",
            "prefix": "前文 B",
            "suffix": "后文 B",
            "offset": 20,
            "heading": "第二节",
        }
        first = self.post_comment(
            client, session, comment_id, "first selection", quote=first_quote
        )
        second = self.post_comment(
            client, session, comment_id, "second selection", quote=second_quote
        )
        self.assertEqual(first.status, 201, first.text())
        self.assertEqual(second.status, 201, second.text())
        self.assertNotEqual(
            first.json()["comment"]["id"], second.json()["comment"]["id"]
        )
        repeated = self.post_comment(
            client, session, comment_id, "first selection", quote=first_quote
        )
        self.assertEqual(repeated.status, 200, repeated.text())
        self.assertTrue(repeated.json()["duplicate"])
        self.assertEqual(
            repeated.json()["comment"]["id"],
            first.json()["comment"]["id"],
        )
        self.assertEqual(repeated.json()["comment"]["quote"], first_quote)

        article = self.get_article(client, comment_id).json()
        quotes = [comment["quote"] for comment in article["comments"]]
        self.assertIn(first_quote, quotes)
        self.assertIn(second_quote, quotes)
        issue_number = self.mock.issue_numbers_for(comment_id)[0]
        self.assertEqual(len(self.mock.comments[issue_number]), 2)

    def test_quote_control_characters_are_stripped(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("quote-controls")
        response = self.post_comment(
            client,
            session,
            comment_id,
            "control characters",
            quote={
                "text": "hello\x00\x01\x85\ud800\nworld\t!",
                "prefix": "pre\x00fix",
                "suffix": "suf\x7f\x9ffix",
                "offset": 0,
                "heading": "head\x00ing",
            },
        )
        self.assertEqual(response.status, 201, response.text())
        quote = response.json()["comment"]["quote"]
        self.assertEqual(quote["text"], "hello\nworld!")
        self.assertEqual(quote["prefix"], "prefix")
        self.assertEqual(quote["suffix"], "suffix")
        self.assertEqual(quote["heading"], "heading")

    def test_invalid_quote_is_rejected_before_issue_creation(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("quote-invalid")
        invalid_quotes = [
            "not an object",
            [],
            {},
            {"text": ""},
            {"text": "   "},
            {"text": "x" * 801},
            {"text": 5},
            {"text": "ok", "prefix": "x" * 121},
            {"text": "ok", "suffix": "x" * 121},
            {"text": "ok", "heading": "x" * 201},
            {"text": "ok", "offset": -1},
            {"text": "ok", "offset": 10_000_001},
            {"text": "ok", "offset": "1"},
            {"text": "ok", "offset": True},
        ]
        for quote in invalid_quotes:
            with self.subTest(quote=str(quote)[:50]):
                response = self.post_comment(
                    client,
                    session,
                    comment_id,
                    "invalid quote",
                    quote=quote,
                )
                self.assertEqual(response.status, 400, response.text())
                self.assertEqual(
                    response.json()["error"]["code"], "invalid_request"
                )
        self.assertEqual(self.mock.issue_numbers_for(comment_id), [])

        null_quote = client.post(
            f"/api/articles/{comment_id}/comments",
            json_body={
                "body": "null quote is allowed",
                "visibility": "public",
                "effect": "off",
                "title": "Test article",
                "articleUrl": SITE_ORIGIN + "/posts/test",
                "quote": None,
            },
            headers=auth_headers(session),
        )
        self.assertEqual(null_quote.status, 201, null_quote.text())
        self.assertIsNone(null_quote.json()["comment"]["quote"])


_NO_EXPECTED_VIEWER = object()


class ReactionReliabilityTests(ServiceTestBase):
    def react(
        self,
        client: Client,
        session: dict,
        comment_id: str,
        reaction,
        expected_viewer=_NO_EXPECTED_VIEWER,
    ):
        payload = {
            "reaction": reaction,
            "title": "Reaction reliability",
            "articleUrl": SITE_ORIGIN + "/posts/reaction-reliability",
        }
        if expected_viewer is not _NO_EXPECTED_VIEWER:
            payload["expectedViewer"] = expected_viewer
        return client.post(
            f"/api/articles/{comment_id}/reaction",
            json_body=payload,
            headers=auth_headers(session),
        )

    def own_reactions(self, issue_number: int, login: str = "alice"):
        return [
            item
            for item in self.mock.reactions[issue_number]
            if item["user"]["login"] == login
        ]

    def test_add_failure_during_switch_keeps_old_and_retry_converges(
        self,
    ) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("reaction-add-failure")
        seeded = self.react(client, session, comment_id, "like")
        self.assertEqual(seeded.status, 200, seeded.text())
        issue_number = self.mock.issue_numbers_for(comment_id)[0]

        self.mock.set_reaction_failure("add")
        response = self.react(client, session, comment_id, "dislike")
        self.assertEqual(response.status, 200, response.text())
        payload = response.json()
        self.assertTrue(payload["partial"])
        self.assertIn("retry", payload["warning"].lower())
        self.assertEqual(
            payload["reactions"], {"like": 1, "dislike": 0, "viewer": "like"}
        )
        self.assertEqual(
            [item["content"] for item in self.own_reactions(issue_number)],
            ["+1"],
        )

        self.mock.set_reaction_failure(None)
        retry = self.react(client, session, comment_id, "dislike")
        self.assertEqual(retry.status, 200, retry.text())
        self.assertFalse(retry.json()["partial"])
        self.assertEqual(
            retry.json()["reactions"],
            {"like": 0, "dislike": 1, "viewer": "dislike"},
        )
        self.assertEqual(
            [item["content"] for item in self.own_reactions(issue_number)],
            ["-1"],
        )

    def test_delete_failure_after_add_reports_both_then_retry_cleans(
        self,
    ) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("reaction-delete-failure")
        seeded = self.react(client, session, comment_id, "like")
        self.assertEqual(seeded.status, 200, seeded.text())
        issue_number = self.mock.issue_numbers_for(comment_id)[0]

        self.mock.set_reaction_failure("delete")
        response = self.react(client, session, comment_id, "dislike")
        self.assertEqual(response.status, 200, response.text())
        payload = response.json()
        self.assertTrue(payload["partial"])
        self.assertIn("retry", payload["warning"].lower())
        self.assertEqual(payload["reactions"]["like"], 1)
        self.assertEqual(payload["reactions"]["dislike"], 1)
        self.assertIn(payload["reactions"]["viewer"], {"like", "dislike"})
        self.assertEqual(
            {item["content"] for item in self.own_reactions(issue_number)},
            {"+1", "-1"},
        )
        recent_writes = [
            write
            for write in self.mock.write_requests
            if f"/issues/{issue_number}/reactions" in write["path"]
        ]
        self.assertEqual(
            [write["method"] for write in recent_writes[-2:]],
            ["POST", "DELETE"],
        )

        self.mock.set_reaction_failure(None)
        retry = self.react(client, session, comment_id, "dislike")
        self.assertEqual(retry.status, 200, retry.text())
        self.assertFalse(retry.json()["partial"])
        self.assertEqual(
            retry.json()["reactions"],
            {"like": 0, "dislike": 1, "viewer": "dislike"},
        )
        self.assertEqual(
            [item["content"] for item in self.own_reactions(issue_number)],
            ["-1"],
        )

    def test_delete_failure_when_toggling_off_reports_actual_state(
        self,
    ) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("reaction-off-failure")
        seeded = self.react(client, session, comment_id, "like")
        self.assertEqual(seeded.status, 200, seeded.text())
        issue_number = self.mock.issue_numbers_for(comment_id)[0]

        self.mock.set_reaction_failure("delete")
        response = self.react(client, session, comment_id, "like")
        self.assertEqual(response.status, 200, response.text())
        payload = response.json()
        self.assertTrue(payload["partial"])
        self.assertEqual(
            payload["reactions"], {"like": 1, "dislike": 0, "viewer": "like"}
        )
        self.assertEqual(
            [item["content"] for item in self.own_reactions(issue_number)],
            ["+1"],
        )

        self.mock.set_reaction_failure(None)
        retry = self.react(client, session, comment_id, "like")
        self.assertEqual(retry.status, 200, retry.text())
        self.assertFalse(retry.json()["partial"])
        self.assertEqual(
            retry.json()["reactions"],
            {"like": 0, "dislike": 0, "viewer": None},
        )
        self.assertEqual(self.own_reactions(issue_number), [])

    def test_refresh_failure_after_mutation_reports_unknown_state(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("reaction-refresh-failure")
        seeded = self.react(client, session, comment_id, "like")
        self.assertEqual(seeded.status, 200, seeded.text())
        issue_number = self.mock.issue_numbers_for(comment_id)[0]

        self.mock.fail_reaction_lists_after_write()
        response = self.react(client, session, comment_id, "like")
        self.assertEqual(response.status, 502, response.text())
        error = response.json()["error"]
        self.assertEqual(error["code"], "reaction_state_unknown")
        self.assertIn("may have been applied", error["message"].lower())
        self.assertNotIn("reactions", response.json())
        self.assertEqual(self.own_reactions(issue_number), [])

        self.mock.clear_reaction_list_failures()
        article = self.get_article(client, comment_id)
        self.assertEqual(article.status, 200, article.text())
        self.assertEqual(
            article.json()["reactions"],
            {"like": 0, "dislike": 0, "viewer": None},
        )
        self.assertEqual(self.own_reactions(issue_number), [])

    def test_refresh_failure_without_mutation_keeps_github_unavailable(
        self,
    ) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("reaction-refresh-no-mutation")
        seeded = self.react(client, session, comment_id, "like")
        self.assertEqual(seeded.status, 200, seeded.text())
        issue_number = self.mock.issue_numbers_for(comment_id)[0]

        # A definitive pre-write rejection cannot have applied, so even a
        # failed follow-up read must not be reported as an unknown state.
        self.mock.set_reaction_failure("add_forbidden")
        self.mock.fail_reaction_lists_after_successes()
        response = self.react(client, session, comment_id, "dislike")
        self.assertEqual(response.status, 502, response.text())
        self.assertEqual(
            response.json()["error"]["code"], "github_unavailable"
        )
        self.assertNotIn("reactions", response.json())
        self.assertEqual(
            [item["content"] for item in self.own_reactions(issue_number)],
            ["+1"],
        )

        self.mock.set_reaction_failure(None)
        self.mock.clear_reaction_list_failures()
        retry = self.react(client, session, comment_id, "dislike")
        self.assertEqual(retry.status, 200, retry.text())
        self.assertEqual(
            retry.json()["reactions"],
            {"like": 0, "dislike": 1, "viewer": "dislike"},
        )

    def test_uncertain_switch_then_stale_retry_conflicts_without_mutation(
        self,
    ) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("reaction-uncertain-switch")
        seeded = self.react(client, session, comment_id, "like")
        self.assertEqual(seeded.status, 200, seeded.text())
        issue_number = self.mock.issue_numbers_for(comment_id)[0]

        self.mock.fail_reaction_lists_after_write()
        response = self.react(client, session, comment_id, "dislike")
        self.assertEqual(response.status, 502, response.text())
        error = response.json()["error"]
        self.assertEqual(error["code"], "reaction_state_unknown")
        self.assertIn("may have been applied", error["message"].lower())
        self.assertEqual(
            [item["content"] for item in self.own_reactions(issue_number)],
            ["-1"],
        )

        writes_before_stale = list(self.mock.write_requests)
        stale = self.react(
            client,
            session,
            comment_id,
            "dislike",
            expected_viewer="like",
        )
        self.assertEqual(stale.status, 200, stale.text())
        payload = stale.json()
        self.assertFalse(payload["partial"])
        self.assertTrue(payload["conflict"])
        self.assertEqual(
            payload["reactions"],
            {"like": 0, "dislike": 1, "viewer": "dislike"},
        )
        self.assertIn("warning", payload)
        self.assertEqual(self.mock.write_requests, writes_before_stale)
        self.assertEqual(
            [item["content"] for item in self.own_reactions(issue_number)],
            ["-1"],
        )

        explicit = self.react(
            client,
            session,
            comment_id,
            "dislike",
            expected_viewer="dislike",
        )
        self.assertEqual(explicit.status, 200, explicit.text())
        self.assertFalse(explicit.json()["conflict"])
        self.assertFalse(explicit.json()["partial"])
        self.assertEqual(
            explicit.json()["reactions"],
            {"like": 0, "dislike": 0, "viewer": None},
        )
        self.assertEqual(self.own_reactions(issue_number), [])

    def test_lost_delete_response_then_refresh_failure_is_unknown(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("reaction-lost-delete")
        seeded = self.react(client, session, comment_id, "like")
        self.assertEqual(seeded.status, 200, seeded.text())
        issue_number = self.mock.issue_numbers_for(comment_id)[0]

        self.mock.set_reaction_lost_response("delete")
        self.mock.fail_reaction_lists_after_write()
        response = self.react(client, session, comment_id, "like")
        self.assertEqual(response.status, 502, response.text())
        error = response.json()["error"]
        self.assertEqual(error["code"], "reaction_state_unknown")
        self.assertIn("may have been applied", error["message"].lower())
        self.assertNotIn("reactions", response.json())
        self.assertEqual(self.own_reactions(issue_number), [])

        self.mock.set_reaction_lost_response(None)
        self.mock.clear_reaction_list_failures()
        article = self.get_article(client, comment_id)
        self.assertEqual(article.status, 200, article.text())
        self.assertEqual(
            article.json()["reactions"],
            {"like": 0, "dislike": 0, "viewer": None},
        )
        self.assertEqual(self.own_reactions(issue_number), [])

    def test_lost_add_response_then_refresh_failure_is_unknown(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("reaction-lost-add")

        self.mock.set_reaction_lost_response("add")
        self.mock.fail_reaction_lists_after_write()
        response = self.react(client, session, comment_id, "like")
        self.assertEqual(response.status, 502, response.text())
        error = response.json()["error"]
        self.assertEqual(error["code"], "reaction_state_unknown")
        self.assertIn("may have been applied", error["message"].lower())
        self.assertNotIn("reactions", response.json())

        issue_number = self.mock.issue_numbers_for(comment_id)[0]
        self.assertEqual(
            [item["content"] for item in self.own_reactions(issue_number)],
            ["+1"],
        )

        self.mock.set_reaction_lost_response(None)
        self.mock.clear_reaction_list_failures()
        article = self.get_article(client, comment_id)
        self.assertEqual(article.status, 200, article.text())
        self.assertEqual(
            article.json()["reactions"],
            {"like": 1, "dislike": 0, "viewer": "like"},
        )

    def test_lost_delete_stale_retry_conflicts_then_explicit_retry_converges(
        self,
    ) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("reaction-lost-delete-retry")
        seeded = self.react(client, session, comment_id, "like")
        self.assertEqual(seeded.status, 200, seeded.text())
        issue_number = self.mock.issue_numbers_for(comment_id)[0]

        self.mock.set_reaction_lost_response("delete")
        self.mock.fail_reaction_lists_after_write()
        unknown = self.react(client, session, comment_id, "like")
        self.assertEqual(unknown.status, 502, unknown.text())
        self.assertEqual(
            unknown.json()["error"]["code"], "reaction_state_unknown"
        )

        self.mock.set_reaction_lost_response(None)
        self.mock.clear_reaction_list_failures()
        writes_before_stale = list(self.mock.write_requests)
        stale = self.react(
            client,
            session,
            comment_id,
            "like",
            expected_viewer="like",
        )
        self.assertEqual(stale.status, 200, stale.text())
        payload = stale.json()
        self.assertTrue(payload["conflict"])
        self.assertFalse(payload["partial"])
        self.assertEqual(
            payload["reactions"],
            {"like": 0, "dislike": 0, "viewer": None},
        )
        self.assertEqual(self.mock.write_requests, writes_before_stale)
        self.assertEqual(self.own_reactions(issue_number), [])

        explicit = self.react(
            client,
            session,
            comment_id,
            "like",
            expected_viewer=None,
        )
        self.assertEqual(explicit.status, 200, explicit.text())
        self.assertFalse(explicit.json()["conflict"])
        self.assertEqual(
            explicit.json()["reactions"],
            {"like": 1, "dislike": 0, "viewer": "like"},
        )
        self.assertEqual(
            [item["content"] for item in self.own_reactions(issue_number)],
            ["+1"],
        )

    def test_definitive_prewrite_failures_still_return_partial_actual_state(
        self,
    ) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("reaction-definitive-prewrite")
        seeded = self.react(client, session, comment_id, "like")
        self.assertEqual(seeded.status, 200, seeded.text())
        issue_number = self.mock.issue_numbers_for(comment_id)[0]

        self.mock.set_reaction_failure("add_forbidden")
        add_blocked = self.react(client, session, comment_id, "dislike")
        self.assertEqual(add_blocked.status, 200, add_blocked.text())
        add_payload = add_blocked.json()
        self.assertTrue(add_payload["partial"])
        self.assertFalse(add_payload["conflict"])
        self.assertEqual(
            add_payload["reactions"],
            {"like": 1, "dislike": 0, "viewer": "like"},
        )
        self.assertEqual(
            [item["content"] for item in self.own_reactions(issue_number)],
            ["+1"],
        )

        self.mock.set_reaction_failure("delete_forbidden")
        delete_blocked = self.react(client, session, comment_id, "dislike")
        self.assertEqual(delete_blocked.status, 200, delete_blocked.text())
        delete_payload = delete_blocked.json()
        self.assertTrue(delete_payload["partial"])
        self.assertFalse(delete_payload["conflict"])
        self.assertEqual(delete_payload["reactions"]["like"], 1)
        self.assertEqual(delete_payload["reactions"]["dislike"], 1)
        self.assertEqual(
            {item["content"] for item in self.own_reactions(issue_number)},
            {"+1", "-1"},
        )

        self.mock.set_reaction_failure(None)
        retry = self.react(client, session, comment_id, "dislike")
        self.assertEqual(retry.status, 200, retry.text())
        self.assertFalse(retry.json()["partial"])
        self.assertEqual(
            retry.json()["reactions"],
            {"like": 0, "dislike": 1, "viewer": "dislike"},
        )
        self.assertEqual(
            [item["content"] for item in self.own_reactions(issue_number)],
            ["-1"],
        )

    def test_expected_viewer_validation_and_explicit_null(self) -> None:
        client, session = self.client_with("alice")
        comment_id = self.unique("reaction-expected-validation")
        for value in ("up", 1, True, [], {}):
            with self.subTest(value=value):
                response = self.react(
                    client,
                    session,
                    comment_id,
                    "like",
                    expected_viewer=value,
                )
                self.assertEqual(response.status, 400, response.text())
                self.assertEqual(
                    response.json()["error"]["code"], "invalid_request"
                )
        self.assertEqual(self.mock.issue_numbers_for(comment_id), [])

        explicit_null = self.react(
            client,
            session,
            comment_id,
            "like",
            expected_viewer=None,
        )
        self.assertEqual(explicit_null.status, 200, explicit_null.text())
        self.assertFalse(explicit_null.json()["conflict"])
        self.assertEqual(
            explicit_null.json()["reactions"],
            {"like": 1, "dislike": 0, "viewer": "like"},
        )


class AttachmentServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory()
        cls.temp_path = pathlib.Path(cls.temp.name)
        cls.mock = MockGitHub().start()
        cls.disabled = RunningService(cls.mock, cls.temp_path)
        cls.local = RunningService(
            cls.mock,
            cls.temp_path,
            attachments_mode="local",
            attachments_max_bytes=512,
        )
        cls.http = RunningService(
            cls.mock,
            cls.temp_path,
            attachments_mode="http",
        )

    @classmethod
    def tearDownClass(cls) -> None:
        for service in (cls.disabled, cls.local, cls.http):
            service.stop()
        cls.mock.stop()
        cls.temp.cleanup()

    def test_attachments_disabled(self) -> None:
        client = self.disabled.client()
        session = login(client, self.mock, "alice")
        response = client.multipart(
            "/api/attachments",
            filename="pixel.png",
            content=make_png(),
            content_type="image/png",
            headers=auth_headers(session),
        )
        self.assertEqual(response.status, 503, response.text())
        self.assertEqual(response.json()["error"]["code"], "attachments_disabled")
        self.assertIn("disabled", response.json()["error"]["message"].lower())

    def test_local_upload_and_public_serve(self) -> None:
        client = self.local.client()
        session = login(client, self.mock, "alice")
        png = make_png()
        response = client.multipart(
            "/api/attachments",
            filename="pixel.png",
            content=png,
            content_type="image/png",
            headers=auth_headers(session),
        )
        self.assertEqual(response.status, 201, response.text())
        attachment = response.json()["attachment"]
        self.assertEqual(attachment["name"], "pixel.png")
        self.assertEqual(attachment["size"], len(png))
        self.assertEqual(attachment["mime"], "image/png")
        self.assertEqual(attachment["scope"], "public")
        self.assertTrue(attachment["url"].startswith(self.local.base_url + "/uploads/"))
        token = attachment["url"].rsplit("/", 1)[-1]
        self.assertGreaterEqual(len(token), 24)

        public = self.local.client().get(attachment["url"])
        self.assertEqual(public.status, 200)
        self.assertEqual(public.body, png)
        self.assertEqual(public.header("Content-Type"), "image/png")
        self.assertEqual(public.header("X-Content-Type-Options"), "nosniff")
        self.assertIn("inline", public.header("Content-Disposition", ""))
        self.assertIn("max-age=31536000", public.header("Cache-Control", ""))

        missing = self.local.client().get("/uploads/not-a-real-token")
        self.assertEqual(missing.status, 404)

    def test_local_rejects_invalid_type_and_magic(self) -> None:
        client = self.local.client()
        session = login(client, self.mock, "alice")
        headers = auth_headers(session)
        html = client.multipart(
            "/api/attachments",
            filename="page.html",
            content=b"<html><script>alert(1)</script></html>",
            content_type="text/html",
            headers=headers,
        )
        self.assertEqual(html.status, 415)
        self.assertEqual(html.json()["error"]["code"], "invalid_type")

        svg = client.multipart(
            "/api/attachments",
            filename="image.svg",
            content=b'<svg xmlns="http://www.w3.org/2000/svg"></svg>',
            content_type="image/svg+xml",
            headers=headers,
        )
        self.assertEqual(svg.status, 415)
        self.assertEqual(svg.json()["error"]["code"], "invalid_type")

        disguised = client.multipart(
            "/api/attachments",
            filename="fake.png",
            content=b"<html>not a png</html>",
            content_type="image/png",
            headers=headers,
        )
        self.assertEqual(disguised.status, 415)
        self.assertEqual(disguised.json()["error"]["code"], "invalid_type")

        extension_mismatch = client.multipart(
            "/api/attachments",
            filename="pixel.txt",
            content=make_png(),
            content_type="image/png",
            headers=headers,
        )
        self.assertEqual(extension_mismatch.status, 415)
        self.assertEqual(extension_mismatch.json()["error"]["code"], "invalid_type")

    def test_local_oversize(self) -> None:
        client = self.local.client()
        session = login(client, self.mock, "alice")
        response = client.multipart(
            "/api/attachments",
            filename="too-big.txt",
            content=b"a" * 600,
            content_type="text/plain",
            headers=auth_headers(session),
        )
        self.assertEqual(response.status, 413, response.text())
        self.assertEqual(response.json()["error"]["code"], "too_large")

    def test_http_driver_forwards_to_mock(self) -> None:
        client = self.http.client()
        session = login(client, self.mock, "alice")
        before = len(self.mock.attachment_uploads)
        response = client.multipart(
            "/api/attachments",
            filename="pixel.png",
            content=make_png(),
            content_type="image/png",
            headers=auth_headers(session),
        )
        self.assertEqual(response.status, 201, response.text())
        attachment = response.json()["attachment"]
        self.assertEqual(attachment["url"], "https://cdn.example/files/uploaded.png")
        self.assertEqual(attachment["scope"], "public")
        self.assertEqual(len(self.mock.attachment_uploads), before + 1)
        self.assertEqual(
            self.mock.attachment_uploads[-1]["authorization"],
            f"Bearer {ATTACHMENT_TOKEN}",
        )
        self.assertNotIn(ATTACHMENT_TOKEN, response.text())
        self.assertNotIn("Authorization", response.text())


if __name__ == "__main__":
    unittest.main()
