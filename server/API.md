# Threadline HTTP API

This is the exact API implemented by `app.py`. All paths are below `/api`.
The browser frontend is served as a static Hugo site and calls this service
cross-origin with credentials.

## Conventions

- Responses are JSON (`application/json; charset=utf-8`) unless noted.
- Errors always have this shape:

  ```json
  {"error":{"code":"invalid_request","message":"Human-readable explanation."}}
  ```

  A response may also include `Retry-After` for GitHub rate limiting.
- API responses set `Cache-Control: no-store` and `Pragma: no-cache`.
  `/uploads/{token}` is the intentional exception: those public files are
  served with long-lived cache headers.
- `Vary: Origin` is set on all responses. CORS is enabled only for the exact
  origins listed in `SITE_ORIGINS`; the response echoes that origin in
  `Access-Control-Allow-Origin` and sets
  `Access-Control-Allow-Credentials: true`. Preflight requests return `204`
  with `Access-Control-Allow-Methods: GET, POST, OPTIONS` and
  `Access-Control-Allow-Headers: Content-Type, X-CSRF-Token`.
- State-changing requests are `POST`. They require:
  1. a valid session cookie;
  2. `X-CSRF-Token` equal to the token returned by `GET /api/session`;
  3. if an `Origin` header is present, an exact match in `SITE_ORIGINS`.
- The session token exists only in the `HttpOnly` cookie. The CSRF token is
  returned in JSON. Neither OAuth access tokens nor OAuth authorization codes
  are returned in JSON or redirect URLs by this service. Sessions and access
  tokens are held in server memory and disappear on logout or restart.
- Request bodies require `Content-Length`. Chunked request bodies are rejected.
- JSON request bodies are limited to 64 KiB. Comment text is limited to 5000
  Unicode characters after trimming; NUL is rejected.
- Optional selection metadata (`quote`) is limited to 800 characters of quoted
  text, 120 characters each for `prefix`/`suffix`, and 200 characters for
  `heading`; `offset` is an integer from 0 to 10,000,000. NUL and control
  characters are stripped, normal Unicode and internal newlines are preserved.
  Selection metadata is stored publicly in the GitHub Issue comment marker.
- `commentId` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.
- Comment `submissionId`, when present, must be a string matching
  `^[A-Za-z0-9_-]{16,128}$`. The comment field is invalid rather than ignored
  when it is `null` or another type. It is a client-generated idempotency
  token, not a secret.
- Reaction `expectedViewer`, when present, must be `like`, `dislike`, or
  `null`.
- `title` is optional, but when present must be at most 200 characters and
  contain no control characters. If absent/blank, the backend uses a generic
  title for a newly created Issue.
- `articleUrl` is optional, but when present must be an absolute `http(s)` URL
  of at most 2048 characters with no credentials. If absent/blank, the first
  configured site origin is used for a newly created Issue.
- Unknown values for `visibility`, `effect`, or `reaction` are rejected.
- `Retry-After` is included when GitHub reports a retry delay.

## Sessions and authentication

### `GET /api/session`

Returns the current viewer, CSRF token, and public configuration. No
authentication is required.

```json
{
  "authenticated": true,
  "viewer": {
    "login": "octocat",
    "name": "The Octocat",
    "avatarUrl": "https://avatars.githubusercontent.com/u/583231?v=4",
    "url": "https://github.com/octocat"
  },
  "csrfToken": "opaque-random-token",
  "config": {
    "repository": "owner/repo",
    "blogger": "owner-login",
    "commentsEnabled": true,
    "authConfigured": true,
    "attachments": {
      "enabled": false,
      "maxBytes": 5242880,
      "allowedTypes": [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "application/pdf",
        "text/plain"
      ],
      "scope": "public"
    }
  }
}
```

Anonymous response:

```json
{
  "authenticated": false,
  "viewer": null,
  "csrfToken": null,
  "config": { "...": "same as above" }
}
```

`config.commentsEnabled` is true when the service has a repository configured.
`config.authConfigured` is false when OAuth client credentials are absent; in
that case sign-in and all writes are unavailable, but public reads can still
work if GitHub permits them. Attachment scope is always `public`.

### `GET /api/auth/github?returnTo=<absolute site URL>`

Starts GitHub OAuth. `returnTo` is required and must be an absolute URL whose
origin exactly matches a configured `SITE_ORIGINS` entry. The service creates
a server-side state record valid for 10 minutes and a separate `HttpOnly` state
cookie, then returns `302` to the configured GitHub authorization URL.

If sign-in is not configured: `503 auth_not_configured`.
If `returnTo` is absent, malformed, or not allowed: `400 invalid_return_to`.

### `GET /api/auth/callback?code=<code>&state=<state>`

GitHub redirects here. The service validates `state` against both the
server-side record and the `HttpOnly` state cookie, exchanges the code with
GitHub server-side, fetches `/user`, creates an in-memory session, and returns
`302` to the validated `returnTo` with a safe query result:

- success: `auth=ok`
- failure: `auth_error=<code>` (for example `access_denied`,
  `oauth_exchange_failed`, `profile_failed`, or `missing_code`)

Existing `returnTo` query parameters are preserved, except any old `auth` or
`auth_error` values are replaced. The state is single-use.

An invalid, expired, missing, or cookie-mismatched state cannot be trusted to
name a redirect target, so it returns `400 invalid_state` instead of redirecting.
No OAuth token is put in a URL.

### `POST /api/auth/logout`

Requires session, CSRF token, and allowed Origin (when present). Returns `204`
with an empty body and an expired session cookie. The in-memory access token is
discarded.

## Articles, comments, and reactions

### `GET /api/articles/{commentId}`

Optional session. Reads use `GITHUB_READ_TOKEN` when configured (otherwise a
signed-in viewer's token, otherwise unauthenticated GitHub reads).

No Issue exists yet:

```json
{
  "commentId": "hello-world",
  "available": true,
  "issueNumber": null,
  "issueUrl": null,
  "comments": [],
  "commentCount": 0,
  "reactions": {"like": 0, "dislike": 0, "viewer": null}
}
```

Issue exists:

```json
{
  "commentId": "hello-world",
  "available": true,
  "issueNumber": 42,
  "issueUrl": "https://github.com/owner/repo/issues/42",
  "comments": [
    {
      "id": 123456,
      "author": {
        "login": "octocat",
        "name": "The Octocat",
        "avatarUrl": "https://avatars.githubusercontent.com/u/583231?v=4",
        "url": "https://github.com/octocat"
      },
      "body": "Hello",
      "createdAt": "2026-01-02T03:04:05Z",
      "updatedAt": "2026-01-02T03:04:05Z",
      "visibility": "commenter",
      "effect": "subtle",
      "quote": {
        "text": "selected text",
        "prefix": "text before",
        "suffix": "text after",
        "offset": 42,
        "heading": "Section title"
      },
      "isAuthor": true
    }
  ],
  "commentCount": 1,
  "reactions": {"like": 2, "dislike": 0, "viewer": "like"}
}
```

- Comments are sorted ascending by `createdAt`.
- `commentCount` is the number of comments visible to the current viewer, not
  the raw GitHub comment count.
- `isAuthor` compares the session login with the GitHub comment author.
- `reactions` is computed from real Issue reactions. `viewer` is `like`,
  `dislike`, or `null`.
- `quote` is the stored selection object, or `null` when the comment has no
  selection metadata. Its `offset` is a character offset supplied by the
  client; it is not a byte offset.
- Metadata HTML comments are stripped from `body`. The marker is hidden from
  the rendered comment but remains public on GitHub.
- In practice GitHub does not include a display name in embedded issue-comment
  user objects; `name` falls back to the login.
- Up to 1000 Issue comments and 1000 Issue reactions are fetched using pages of
  100. If either collection exceeds that cap, the oldest fetched page data is
  used and counts can be lower than GitHub's total. The response has no
  truncation flag by design.

#### Visibility

`visibility` is presentation filtering only, never access control:

- `public`: returned to everyone (including anonymous visitors).
- `commenter`: returned only when the viewer is the comment's author.
- `blogger`: returned only when the viewer login matches
  `BLOGGER_GITHUB_LOGIN`.

Every comment, marker, attachment link, and reaction in the GitHub Issue is
publicly readable on GitHub and through the GitHub API. Do not call these
options private.

### `POST /api/articles/{commentId}/comments`

Requires session, CSRF, and allowed Origin when present.

```json
{
  "body": "Comment text",
  "visibility": "public",
  "effect": "off",
  "title": "Article title",
  "articleUrl": "https://blog.example.com/posts/hello/",
  "submissionId": "client_8f3c2a1b9d7e4f60",
  "quote": {
    "text": "selected text",
    "prefix": "text before",
    "suffix": "text after",
    "offset": 42,
    "heading": "Section title"
  }
}
```

- `body`: required, string, 1–5000 characters after trim, no NUL.
- `visibility`: required, `public`, `commenter`, or `blogger`.
- `effect`: required, `off`, `subtle`, or `strong`.
- `submissionId`: optional client-generated idempotency token matching
  `^[A-Za-z0-9_-]{16,128}$`. Omit it to use the legacy payload-derived key.
  Invalid values return `400 invalid_request`. It is public once embedded in
  the metadata marker (as a hash), so do not use sensitive data.
- `title` / `articleUrl`: optional as documented above; used when an Issue must
  be created.
- `quote`: optional selection metadata. It must be an object or `null` when
  present. `text` is required for an object and must be 1–800 characters after
  trimming. `prefix` and `suffix` are optional strings of at most 120
  characters; `heading` is an optional string of at most 200 characters;
  `offset` is an optional integer from 0 to 10,000,000 (default `0`). NUL and
  control characters are stripped, line breaks inside `text` are preserved,
  and normal Unicode is accepted. Invalid types or ranges return
  `400 invalid_request`. The response always contains `quote` as an object or
  `null`.

Selection metadata is public. It is stored in the GitHub Issue comment and can
be read by anyone who can read the Issue.

The Issue is created on the signed-in user's own token if needed. The GitHub
comment body is:

```text
<trimmed body>

<!-- threadline-meta {"version":1,"visibility":"public","effect":"off","submission":"<64 hex chars>","quote":{"text":"...","prefix":"...","suffix":"...","offset":42,"heading":"..."}} -->
```

`submission` is a stable SHA-256-derived idempotency id. When `submissionId` is
provided, it is derived from that id plus the authenticated viewer, article,
and normalized payload (including `visibility`, `effect`, `quote`, `title`, and
`articleUrl`). When `submissionId` is absent, the legacy payload-derived key is
computed exactly as before, so existing public metadata and old clients remain
idempotent. The JSON is ASCII-encoded and escapes `<`, `>`, and `&`, so quoted
text cannot terminate the HTML comment. Existing version-1 markers without
`submission` or `quote` remain readable.

Response `201` (the write completed and the count was refreshed):

```json
{
  "comment": {
    "id": 123456,
    "author": {
      "login": "octocat",
      "name": "The Octocat",
      "avatarUrl": "https://avatars.githubusercontent.com/u/583231?v=4",
      "url": "https://github.com/octocat"
    },
    "body": "Comment text",
    "createdAt": "2026-01-02T03:04:05Z",
    "updatedAt": "2026-01-02T03:04:05Z",
    "visibility": "public",
    "effect": "off",
    "quote": {
      "text": "selected text",
      "prefix": "text before",
      "suffix": "text after",
      "offset": 42,
      "heading": "Section title"
    },
    "isAuthor": true
  },
  "commentCount": 3,
  "duplicate": false,
  "refreshFailed": false
}
```

`commentCount` is the viewer-visible count from the comment list used for the
response (the post-write refresh, or the pre-write list for a duplicate). If
the viewer posted a comment whose display rule hides it from them (for example
a non-blogger choosing `blogger`), the comment is still returned from this POST
but is not included in their subsequent article list or count. It is `null`
only when the write succeeded but the follow-up refresh failed.

If the comment write succeeds but the follow-up comment-list refresh fails, the
write is still successful:

```json
{
  "comment": {"...": "the created comment, including quote"},
  "commentCount": null,
  "duplicate": false,
  "refreshFailed": true,
  "warning": "The comment was saved, but the comment list could not be refreshed. Reload the article to update the comment count."
}
```

The response is `201`, not an error. A client retry is idempotent and must not
show this as a failed publish. Retrying with the same `submissionId` and payload
(including after this refresh failure) returns `200` with the existing comment
and the refreshed count. The client may also reload the article to obtain the
count.

#### Idempotent retries

Before writing a comment, the service resolves or creates the Issue and lists
its comments while holding the per-article lock. (A newly created Issue is
expected to return an empty list.) If the same authenticated login already has
a comment whose valid metadata `submission` equals the current submission id,
the service returns `200` with the existing comment and does not write again:

```json
{
  "comment": {"...": "the existing comment, including quote"},
  "commentCount": 1,
  "duplicate": true,
  "refreshFailed": false
}
```

A failure of this pre-write read returns `502 github_unavailable` and no
comment is written. If the Issue had to be created in the same request, that
empty Issue may remain and is reused by a later retry. This is deliberate:
without the read, the service cannot prove that a retry is safe. A genuinely
concurrent identical request may return
`409 duplicate_submission` while the first request is still in flight; retrying
after it completes returns the `200` duplicate result. Idempotency is based on
the public metadata marker, so it also works after a restart. It is not limited
to a time window.

Different users and different articles are always distinct. With an explicit
`submissionId`:

- the same `submissionId` with the same payload returns `200` with the existing
  comment and does not write again;
- a different `submissionId` with an identical payload creates a new comment
  (`201`), so deliberate duplicate text is supported;
- the same `submissionId` with a changed payload hashes to a different
  submission, creates a new comment (`201`), and cannot return an unrelated
  earlier comment.

Without `submissionId`, the legacy key still includes the login, article, body,
`visibility`, `effect`, `quote`, `title`, and `articleUrl`, so an identical
payload from the same viewer is treated as a retry. A client that intentionally
wants to publish the exact same text again without changing any field should
send a fresh `submissionId`.

### `POST /api/articles/{commentId}/reaction`

Requires session, CSRF, and allowed Origin when present. Updates this viewer's
article reaction; sending the currently active reaction normally toggles it off
and `null` removes the viewer's reactions. If a previous partial switch left
both reactions, retrying the requested target keeps that target and removes the
stale reaction instead of toggling it off.

```json
{
  "reaction": "like",
  "expectedViewer": "like",
  "title": "Article title",
  "articleUrl": "https://blog.example.com/posts/hello/"
}
```

- `reaction`: required; `like`, `dislike`, or `null`.
- `expectedViewer`: optional; `like`, `dislike`, or `null`. It is the reaction
  the client believes the viewer currently has. If it differs from the actual
  state read from GitHub, the service does not mutate reactions and returns
  `200` with the actual snapshot, `partial: false`, `conflict: true`, and a
  warning. Omit it to keep the legacy toggle behavior.
- `title` / `articleUrl`: optional; used to create the Issue if it does not
  exist. A new Issue is created before the response even for `null` / removal.
- Only the signed-in user's token adds or removes reactions. Reads may use the
  optional read-only token.
- At most one of `+1` / `-1` from this viewer is normally maintained:
  - same reaction again toggles it off;
  - when switching to the other reaction, the target reaction is added first;
    the previous reaction is deleted only after the add succeeds;
  - `null` removes the viewer's reactions.
- Counts and viewer state are re-read from GitHub Issue reactions after the
  mutation. The service never reports a state that was not read back from
  GitHub.

Response `200` after a fully completed operation:

```json
{
  "reactions": {"like":1,"dislike":0,"viewer":"like"},
  "partial": false,
  "conflict": false
}
```

If an add or delete fails but the follow-up reaction-list refresh succeeds, the
service returns `200` with the actual GitHub state and `partial: true`:

```json
{
  "reactions": {"like":1,"dislike":1,"viewer":"like"},
  "partial": true,
  "conflict": false,
  "warning": "The reaction change could not be completed cleanly. The returned state reflects GitHub's current reactions; retry to finish the change."
}
```

The returned snapshot is trusted pending GitHub data, not the intended state.
For example, a failed switch can leave the old reaction in place, and a failed
delete after a successful add can leave both reactions. Retrying the same
request is safe and converges to the requested state; a retry removes stale
reactions instead of treating the partial state as a fresh toggle.

If `expectedViewer` does not match, no reaction mutation is attempted:

```json
{
  "reactions": {"like":0,"dislike":1,"viewer":"dislike"},
  "partial": false,
  "conflict": true,
  "warning": "The reaction changed elsewhere before this request was applied. The returned state reflects GitHub's current reaction; no change was made."
}
```

This protects a retry that still carries the browser's stale pre-write state.
For example, after a like-to-dislike switch whose post-write read was lost, a
retry with `expectedViewer: "like"` refreshes to the actual dislike instead of
toggling the new dislike off. An explicit follow-up with
`expectedViewer: "dislike"` and `reaction: "dislike"` then toggles it off
intentionally under the normal toggle rule.

If any add or delete may have been applied but the follow-up reaction-list
refresh also fails, the endpoint returns `502 reaction_state_unknown` and no
reaction snapshot. A write may have been applied when it returned successfully,
or when its outcome was ambiguous: a lost HTTP response, a timeout, a GitHub 5xx
response, or a `github_unavailable` / `github_error` mapping. Definitive
pre-write rejections (for example `401`, `403`, `404`, `422`, or rate limiting)
are not treated as applied by themselves.

```json
{
  "error": {
    "code": "reaction_state_unknown",
    "message": "The reaction change may have been applied, but the current reaction state could not be read. Reload the article to confirm your reaction."
  }
}
```

The mutation may have fully or partially completed, even though the service
never received a usable write response. The client should reload the article
before retrying. If no mutation may have applied (for example the add was
definitively rejected and the refresh also failed), the endpoint keeps
returning `502 github_unavailable`.

## Attachments

Attachments and returned links are public. There is no authentication on the
local `/uploads/{token}` URL. Do not upload secrets or private files.

### `POST /api/attachments`

Requires session, CSRF, and allowed Origin when present. Body is
`multipart/form-data` with a single field named `file`.

When `ATTACHMENTS_MODE=disabled` (the default), returns
`503 attachments_disabled`.

Success `201`:

```json
{
  "attachment": {
    "url": "https://comments.example.com/uploads/randomPublicToken",
    "name": "diagram.png",
    "size": 12345,
    "mime": "image/png",
    "scope": "public"
  }
}
```

Validation:

- the complete multipart request has a separate bounded read limit (at least
  8 MiB) so ordinary over-limit files receive a JSON `413` response;
- file size is bounded by `ATTACHMENTS_MAX_BYTES`;
- declared MIME must be in `ATTACHMENTS_ALLOWED_TYPES`;
- the filename extension must match the declared MIME;
- file magic bytes must match the declared type;
- `text/plain` must be valid UTF-8 and contain no NUL;
- SVG, HTML, XHTML, scripts, and all unsupported types are rejected.

Implemented safe types: `image/png`, `image/jpeg`, `image/gif`,
`image/webp`, `application/pdf`, `text/plain`. Unknown types are a
configuration error at startup, not an invitation to treat arbitrary content
as safe.

Errors: `400 invalid_request` / `invalid_multipart`, `413 too_large`,
`415 invalid_type`, `502 upload_failed`, `503 attachments_disabled`.

`local` driver:

- stores random token + metadata in SQLite and bytes under `ATTACHMENTS_DIR`;
- returns `<ATTACHMENTS_PUBLIC_BASE_URL or PUBLIC_BASE_URL>/uploads/<token>`;
- `GET /uploads/{token}` is public, sets
  `X-Content-Type-Options: nosniff`, a safe `Content-Type`, and a safe
  `Content-Disposition` (`inline` for images/text, `attachment` for PDF), with
  a long public cache lifetime.

`http` driver:

- forwards the multipart field to `ATTACHMENTS_HTTP_URL` with
  `Authorization: Bearer <ATTACHMENTS_HTTP_TOKEN>` when the token is set;
- expects a `2xx` JSON response with a public `http(s)` URL in `url`,
  `attachment.url`, or `data.url`;
- any HTTP error, invalid JSON, or invalid URL becomes `502 upload_failed`;
- the service returns the same attachment metadata object, with that URL.

## Health

### `GET /api/health`

```json
{"ok": true}
```

No authentication is required. It only indicates that the HTTP process is
running; it does not prove GitHub or attachment storage is reachable.

## GitHub storage and identity

Issues in `COMMENTS_REPOSITORY` are the source of truth. New Issues are titled:

```text
[threadline:<commentId>] <sanitized title>
```

The title prefix is deterministic and limited so the complete title is at most
256 characters. The Issue body contains the hidden marker:

```text
<!-- threadline-comment-id: <commentId> -->
```

It also contains the article URL and a public-storage notice. Each comment
appended to the Issue contains a version-1 metadata marker with its display
filter, effect, stable `submission` id, and optional public `quote` object.
Markers are public on GitHub even though the service strips them from `body`.

When no SQLite mapping exists, the service searches:

```text
repo:<owner>/<repo> is:issue in:title "threadline:<commentId>"
```

and chooses the lowest matching Issue number whose title starts with
`[threadline:<commentId>]`. The SQLite `article_issues` table has a primary key
on `comment_id` and an in-process lock prevents duplicate creation inside one
process.

Stable `commentId` values keep the same Issue when an article path or title
changes. Changing `commentId` creates a new Issue. Multiple service instances
can race between search and create; use one instance (recommended) or add an
external lock. The service never uses `GITHUB_READ_TOKEN` for writes.

## Errors

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Invalid body, value, title, URL, quote, or content |
| 400 | `invalid_json` | Body is not valid JSON |
| 400 | `invalid_comment_id` | `commentId` does not match the required pattern |
| 400 | `invalid_return_to` | OAuth return URL is absent or not in `SITE_ORIGINS` |
| 400 | `invalid_state` | OAuth state is missing, expired, replayed, or cookie-mismatched |
| 400 | `invalid_multipart` | Malformed multipart payload |
| 401 | `authentication_required` | No valid session |
| 401 | `session_expired` | GitHub rejected the user token; sign in again |
| 403 | `csrf_invalid` | Missing/wrong `X-CSRF-Token` |
| 403 | `origin_not_allowed` | Origin is outside `SITE_ORIGINS` |
| 403 | `permission` | GitHub denied repository/Issue permission |
| 404 | `not_found` | Endpoint, repository, or Issue not found |
| 405 | `method_not_allowed` | Unsupported HTTP method |
| 409 | `duplicate_submission` | Identical request is currently in flight; retry for the idempotent `200` result |
| 411 | `length_required` | Missing `Content-Length` or chunked body |
| 413 | `too_large` | Body or attachment exceeds configured limit |
| 415 | `invalid_type` | Attachment type/extension/magic or media type rejected |
| 415 | `unsupported_media_type` | JSON endpoint received another content type |
| 422 | `validation` | GitHub rejected the write during validation |
| 429 | `rate_limited` | GitHub rate limit; check `Retry-After` |
| 500 | `internal_error` | Unexpected local server failure |
| 502 | `github_unavailable` | GitHub could not be reached / returned 5xx, or a reaction read failed without any mutation possibly applied |
| 502 | `reaction_state_unknown` | A reaction mutation may have been applied (including a lost response, timeout, or 5xx) but the follow-up read failed; reload before retrying |
| 502 | `github_error` | Other unexpected GitHub API failure |
| 502 | `upload_failed` | Configured attachment storage failed |
| 503 | `attachments_disabled` | Attachment storage is disabled |
| 503 | `auth_not_configured` | GitHub OAuth client credentials are missing |

Authentication error precedence for writes is: session (`401`), then CSRF
(`403`), then Origin (`403`). Unknown values are rejected before any GitHub
write. All error bodies have only `code` and `message` inside `error`; optional
retry information is conveyed in headers.
