# Threadline comments service

A deployable, zero-third-party-dependency Python service for a static Hugo
blog. It stores comments and per-article reactions in GitHub Issues and signs
visitors in with GitHub so every comment/reaction is authored with that
visitor's own token.

The Hugo site remains static. The browser calls this service cross-origin,
sends credentials, and obtains a short-lived server-side session. OAuth client
secrets, GitHub App credentials, and optional read tokens live only on this
server and must never be placed in the theme or generated site.

This service was validated with a deterministic local mock of GitHub OAuth and
the GitHub API. The theme author's live deployment has also exercised owner
login and comment writes using a GitHub App. A second, non-collaborator GitHub
account and a real external attachment backend have not yet been verified
end to end.

## What it does

- GitHub OAuth authorization-code sign-in (GitHub App user-to-server tokens are
  recommended; an OAuth App is also supported).
- GitHub Issues as the durable store for comments and article reactions.
- One stable Issue per article `comment_id`, with SQLite issue mappings and a
  search fallback.
- Public / commenter-only / blogger-only **page display filters** stored in
  comment metadata. These are not privacy controls and do not hide data on
  GitHub.
- Optional public selection metadata (quoted text, prefix/suffix, offset, and
  heading) stored in the same comment marker.
- Durable idempotent comment writes: the public marker records a stable
  submission id, so a retry returns the existing comment after a lost response
  or a failed count refresh instead of posting a duplicate. An optional
  client-generated `submissionId` lets intentional identical comments coexist
  while still making retries of one submission idempotent.
- Article like/dislike backed by real GitHub Issue `+1` / `-1` reactions.
  Switches add the target first; partial failures return the actual GitHub
  state with `partial: true` instead of pretending the write was atomic.
  Optional `expectedViewer` turns a stale retry into a non-mutating `conflict`
  response. If a write may have been applied but the follow-up read fails (a
  lost response, timeout, or 5xx), the result is `reaction_state_unknown`
  rather than a generic failure.
- CSRF protection, strict CORS, HttpOnly cookie sessions, and nullable origin
  checks.
- Optional local or HTTP attachment storage. Attachments are public.
- No pip packages: Python 3.11+ standard library only.

## Requirements

- Python 3.11 or newer (tested here with Python 3.11.15, 3.12.14, and 3.14.9).
- A GitHub repository for Issues.
- Either:
  - a GitHub App installed on that repository with **Repository permissions →
    Issues: Read and write** (recommended), or
  - an OAuth App with an appropriate scope.
- A public HTTPS URL for this service (or local HTTP during development).
- A reverse proxy for TLS and, ideally, request rate limiting in production.

## Quick start

```bash
cd hugo-deepseek-theme/server
cp .env.example .env
# Edit .env: repository, blogger login, OAuth client, public URL, and origins.
python3 app.py --env-file .env
```

The process logs a line like:

```text
Threadline listening on 127.0.0.1:8787 (repository=..., auth=configured, attachments=disabled)
```

It never logs request bodies, cookies, Authorization headers, OAuth codes, or
query strings. Startup configuration errors print a non-secret message and
exit with status 2.

Health check:

```bash
curl http://127.0.0.1:8787/api/health
# {"ok":true}
```

`--env-file` is a deliberately tiny parser for `KEY=VALUE`, optional `export`,
quotes, blank lines, and `#` comments. Existing process environment variables
override the file. Dotenv packages and shell evaluation are not used.

## GitHub App setup (recommended)

1. In GitHub, create a GitHub App under **Settings → Developer settings →
   GitHub Apps → New GitHub App**.
2. Set its callback URL to:
   `PUBLIC_BASE_URL` + `/api/auth/callback`
   (for example `https://comments.example.com/api/auth/callback`).
3. Disable webhook delivery unless you separately need it.
4. Under **Repository permissions**, set **Issues: Read and write**.
   GitHub supplies the necessary metadata access automatically.
5. To allow visitors outside the app owner's account to sign in, make the
   GitHub App **public**. A private App only permits authorization by its
   owner or members of the owning organization. Public visibility also lets
   other accounts choose to install it; it does not expand the repositories
   selected in your own installation. See
   [GitHub's App visibility documentation](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private).
6. Leave **Request user authorization (OAuth) during installation** enabled if
   desired. User authorization is what this service uses; no GitHub App private
   key is needed for the user-to-server authorization-code flow.
7. Create the App, copy its **Client ID**, generate a **Client secret**, and
   install the App on **only the comments repository**.
8. Set:

   ```dotenv
   GITHUB_CLIENT_ID=<client-id>
   GITHUB_CLIENT_SECRET=<client-secret>
   GITHUB_OAUTH_SCOPE=
   ```

The App must be installed on `COMMENTS_REPOSITORY`. A signed-in user needs
permission to create/write Issues in that repository; for a public repository,
normal GitHub accounts can write Issues unless the repository's settings
prevent it. GitHub remains the authority and may still reject a write with
`403 permission`.

GitHub's user authorization URLs for a GitHub App are the standard GitHub URLs
used by default here. They can be overridden for tests or GitHub Enterprise:

```dotenv
GITHUB_OAUTH_AUTHORIZE_URL=https://github.com/login/oauth/authorize
GITHUB_OAUTH_TOKEN_URL=https://github.com/login/oauth/access_token
```

## OAuth App alternative

Create an OAuth App under **Settings → Developer settings → OAuth Apps**, set
its callback URL to `PUBLIC_BASE_URL/api/auth/callback`, and set the client ID
and secret.

- Public comments repository: `GITHUB_OAUTH_SCOPE=public_repo`. This is broader
  than an empty GitHub App scope.
- Private comments repository: the OAuth App would need the broader `repo`
  scope. Review whether exposing a private repository's contents is acceptable;
  the service does not need private repository content.
- OAuth Apps are not installed on a repository the way GitHub Apps are; the
  signed-in user's own repository permissions govern writes.

The recommended GitHub App flow avoids requesting `public_repo`.

## Configuration

All variables are read from the process environment or from a file passed to
`--env-file`.

| Variable | Default / required | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only inside a container or trusted network. |
| `PORT` | `8787` | HTTP port. No TLS listener is built in. |
| `PUBLIC_BASE_URL` | required | Public base used for the OAuth callback. Usually the HTTPS reverse-proxy URL. A path prefix is supported when the proxy routes it here. No query/fragment. |
| `SITE_ORIGINS` | required | Comma-separated exact browser origins for CORS and safe OAuth `returnTo` URLs, e.g. `https://blog.example.com,http://127.0.0.1:1313`. No paths or wildcards. |
| `COOKIE_SECURE` | `false` | Set `true` in production HTTPS. |
| `COOKIE_SAMESITE` | `Lax` | `Lax`, `Strict`, or `None`. `None` requires Secure. `Strict` can prevent the OAuth state cookie from accompanying GitHub's redirect; `Lax` is recommended. |
| `COMMENTS_REPOSITORY` | required | `owner/repo` containing public comments Issues. |
| `BLOGGER_GITHUB_LOGIN` | required | GitHub login whose account can see blogger-display comments. Case-insensitive. |
| `ISSUE_LABEL` | empty | Optional existing label to add to newly created Issues. |
| `DATABASE_PATH` | required | SQLite path for issue mappings and local attachment metadata. Create/mount its parent writable by the service user. |
| `GITHUB_API_BASE` | `https://api.github.com` | Override for tests/GitHub Enterprise API. |
| `GITHUB_OAUTH_AUTHORIZE_URL` | GitHub default | Authorization URL, override for tests/Enterprise. |
| `GITHUB_OAUTH_TOKEN_URL` | GitHub default | Token exchange URL, override for tests/Enterprise. |
| `GITHUB_CLIENT_ID` | empty | OAuth/GitHub App client ID. Must be paired with the secret. |
| `GITHUB_CLIENT_SECRET` | empty | OAuth/GitHub App client secret. Server-only. |
| `GITHUB_OAUTH_SCOPE` | empty | Empty for a GitHub App; an OAuth App may use `public_repo` (or `repo` when necessary). |
| `GITHUB_READ_TOKEN` | empty | Optional read-only token for public GitHub reads/rate limits. **Never used for writes.** |
| `SESSION_TTL_SECONDS` | `28800` | In-memory session lifetime (min 1 second, max 365 days). |
| `ATTACHMENTS_MODE` | `disabled` | `disabled`, `local`, or `http`. |
| `ATTACHMENTS_DIR` | required for local | Writable directory for random-token files. Persist it. |
| `ATTACHMENTS_PUBLIC_BASE_URL` | `PUBLIC_BASE_URL` | Base for returned local URLs: `<base>/uploads/<token>`. |
| `ATTACHMENTS_HTTP_URL` | required for http | Multipart upload endpoint for the external driver. |
| `ATTACHMENTS_HTTP_TOKEN` | empty | Bearer token sent to `ATTACHMENTS_HTTP_URL`. |
| `ATTACHMENTS_MAX_BYTES` | `5242880` | Per-file limit, 1 byte–100 MiB. |
| `ATTACHMENTS_ALLOWED_TYPES` | safe six types | Comma-separated subset of implemented safe MIME types. |

The only implemented attachment MIME types are `image/png`, `image/jpeg`,
`image/gif`, `image/webp`, `application/pdf`, and `text/plain`. SVG, HTML,
XHTML, scripts, and unsupported types are rejected at startup if configured.
This is deliberately restrictive; arbitrary operator-defined validators would
be unsafe.

`DATABASE_PATH` is required rather than silently placing a database in the
current directory. Set it to a persistent volume in production.

## API

The complete contract is in [`API.md`](API.md). Base paths are `/api`; public
local files are under `/uploads/{token}`. The most important frontend points:

- `GET /api/session` — viewer, CSRF token, public configuration.
- `GET /api/auth/github?returnTo=...` — start OAuth (top-level navigation).
- `POST /api/auth/logout` — CSRF-protected logout.
- `GET /api/articles/{commentId}` — visible comments (including public `quote`
  metadata) + real reactions.
- `POST /api/articles/{commentId}/comments` — create a comment as the viewer;
  accepts optional `quote` selection metadata and an optional client-generated
  `submissionId`, and is idempotent on retry.
- `POST /api/articles/{commentId}/reaction` — like/dislike/remove as the viewer;
  accepts optional `expectedViewer` (send the last known `reactions.viewer`) to
  reject stale toggles with `conflict: true`, and may return `partial: true`
  with the actual state.
- `POST /api/attachments` — optional public attachment upload.

The frontend must use `credentials: "include"` for cross-origin requests and
send `X-CSRF-Token` for every state-changing POST. The browser supplies
`Origin`; the service validates it when present. URL-encode the complete
`returnTo` value when starting OAuth.

The `returnTo` URL sent to the OAuth start endpoint must be an absolute URL on
an origin from `SITE_ORIGINS`. OAuth errors are delivered back as
`auth_error=<code>`; no OAuth token is put in a URL.

## Cookies, CORS, and reverse proxy

Recommended production topology:

```text
static Hugo site (https://blog.example.com)
        │  fetch(..., credentials: "include", X-CSRF-Token)
        ▼
TLS reverse proxy (https://comments.example.com)
        │  loopback HTTP
        ▼
Threadline 127.0.0.1:8787
```

Caddy example:

```caddyfile
comments.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Key points:

- Set `PUBLIC_BASE_URL` to the externally visible service URL.
- If that URL has a path prefix such as `/threadline`, configure the proxy to
  strip the prefix before forwarding `/api/` and `/uploads/` to this process.
- Set `SITE_ORIGINS` to exact frontend origins, including the port for local
  development (`http://127.0.0.1:1313`).
- Set `COOKIE_SECURE=true` and terminate TLS in production.
- Keep `COOKIE_SAMESITE=Lax` when the blog and comments service are
  same-site (different ports/subdomains are same-site for this purpose). If
  they are genuinely cross-site, a modern browser needs `SameSite=None;
  Secure` and may still block third-party cookies. Hosting the service on a
  subdomain of the blog is the safer arrangement.
- Do not strip `Origin` at the proxy; do not rewrite it to the backend host.
  Forward `X-CSRF-Token` unchanged.
- Do not enable proxy caching for `/api`. The service sends `no-store` itself.
- The proxy's request-body limit must allow
  `ATTACHMENTS_MAX_BYTES + 256 KiB` for multipart uploads.
- The service's health endpoint is `GET /api/health`.
- The service does not trust `X-Forwarded-*` for security decisions. Bind it
  to loopback/private networking and let the proxy own TLS and public access.

CORS allows only exact configured origins and always uses
`Access-Control-Allow-Credentials: true` for them, with `Vary: Origin`.
State-changing POSTs still require a session and CSRF token; CORS is not used
as authorization.

## Attachments

Attachment storage is **disabled by default**. When enabled, uploaded files and
their URLs are public and unauthenticated, like the GitHub Issues that contain
their links. Do not store secrets or private material. There is no virus
scanning, moderation, deletion API, or automatic expiry.

### Local driver

```dotenv
ATTACHMENTS_MODE=local
ATTACHMENTS_DIR=/var/lib/threadline/attachments
ATTACHMENTS_PUBLIC_BASE_URL=https://comments.example.com
ATTACHMENTS_MAX_BYTES=5242880
ATTACHMENTS_ALLOWED_TYPES=image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain
```

The service writes random-token files under `ATTACHMENTS_DIR`, records metadata
in SQLite, and serves `GET /uploads/<token>` publicly. Ensure the directory is
writable by the non-root service user and backed up if attachments matter.
Images and plain text are served inline with `nosniff`; PDFs are served as
attachments. The local route is public; a reverse proxy must forward
`/uploads/` as well as `/api/`.

### HTTP driver

```dotenv
ATTACHMENTS_MODE=http
ATTACHMENTS_HTTP_URL=https://files.example.com/threadline/upload
ATTACHMENTS_HTTP_TOKEN=<server-only-bearer-token>
```

The service sends `multipart/form-data` with field `file`, the validated MIME
type, filename, and optional bearer token. The backend must return a `2xx` JSON
object containing a public `http(s)` URL at one of:

```json
{"url":"https://files.example.com/public/abc"}
```

```json
{"attachment":{"url":"https://files.example.com/public/abc"}}
```

```json
{"data":{"url":"https://files.example.com/public/abc"}}
```

An error, timeout, invalid JSON, or non-http(s) URL becomes
`502 upload_failed`. The service does not expose the bearer token to clients.

## Storage and session model

- **SQLite** (`DATABASE_PATH`): durable `article_issues` mapping
  (comment_id → issue number/URL) and local attachment metadata. It is not a
  session store.
- **Server memory**: sessions, GitHub user access tokens, CSRF tokens, OAuth
  state records, an in-flight submission set, and process issue locks. The
  durable duplicate check uses the public comment marker, not memory.
- Logging out deletes the current session. Restarting the process invalidates
  every session and access token. Users sign in again.
- Issue mappings make path/title changes harmless while `comment_id` stays
  stable. Changing the front-matter `comment_id` creates a distinct Issue.
- If the mapping is lost, the service searches GitHub for the deterministic
  title prefix and chooses the lowest matching Issue number. A manually renamed
  Issue is still found through the SQLite mapping but is not found by the title
  search.

## Deploy with Docker

The Dockerfile is non-root and performs no `pip install`. It uses the
`python:3.12-slim` base image; this repository does not vendor that image. A
local offline build/run was verified here with a pre-present base image. On a
machine without that image, `docker build` needs registry access to pull it.

```bash
cd hugo-deepseek-theme/server
docker build -t threadline-comments .
docker run --rm \
  --name threadline-comments \
  -p 8787:8787 \
  --env-file .env \
  -e HOST=0.0.0.0 \
  -e DATABASE_PATH=/data/threadline.db \
  -e ATTACHMENTS_DIR=/data/attachments \
  -v threadline-data:/data \
  threadline-comments
```

The container runs as UID/GID 10001. `/data` is writable and declared as a
volume. If local attachments are enabled, ensure both SQLite and
`ATTACHMENTS_DIR` live on the persisted volume. The healthcheck uses only the
Python standard library to call `/api/health`.

Do not run multiple container replicas sharing only a volume: sessions are
in-memory per process, and concurrent Issue creation can race. Use one
instance, or add a shared session store and an external creation lock.

## Security notes and limits

- **GitHub data is public.** Every comment body, display/selection marker,
  article URL, attachment link, and reaction is visible on GitHub and through
  the GitHub API. Page visibility filters only change what this backend returns
  to a browser. They are not access control. Use a public comments repository;
  do not use a private repository expecting the service to keep comments
  private. Quoted selection metadata is public too.
- Comments are posted with the signed-in user's own GitHub token. A shared
  blogger token is never used to impersonate a commenter. `GITHUB_READ_TOKEN`
  is read-only and never used for writes.
- The service strips its own metadata markers and returns raw GitHub Markdown.
  It does not sanitize HTML inside Markdown. The frontend must escape raw HTML
  or use a Markdown renderer configured to do so; do not `innerHTML` untrusted
  comment text without sanitization.
- No moderation, comment editing, reaction administration, deletion, spam
  scoring, email verification, or built-in rate limiting exists. Add those at
  the edge or as a separate feature.
- GitHub API limits apply: unauthenticated reads have a much smaller quota than
  authenticated calls. Configure `GITHUB_READ_TOKEN` for predictable public
  reads. GitHub may return 429/403; the service maps those to an actionable
  error and may include `Retry-After`.
- HTTP comments/reactions are fetched in pages of 100 up to 1000 items.
  Collections above that cap can produce truncated counts. The API has no
  truncation flag in order to keep the documented shape stable.
- The service has no TLS listener and no proxy-header trust. Put it behind a
  TLS reverse proxy and keep the backend on loopback/private networking.
- ThreadingHTTPServer uses a thread per request and no application-level
  connection/rate limits. Use reverse-proxy timeouts and limits. Upload files
  are bounded, but the server should still be treated as internet-facing code
  requiring normal operational hardening.
- Comment idempotency is based on the public `submission` field in the comment
  marker plus a process-local in-flight set. A retry after a completed write
  returns the existing comment (HTTP `200`, `duplicate: true`) and does not
  write again; a truly concurrent identical request can still return `409`.
  With `submissionId`, the key includes the client token and the normalized
  payload: the same token plus the same payload is a retry, while a new token
  permits a deliberate identical comment. Without it, the legacy key derived
  from the viewer, article, and payload applies. The pre-write list read is
  required for safety, so if it fails the service returns `502` without writing
  the comment. Multi-instance
  deployments still need an external issue-creation lock; the marker prevents
  duplicate comments but does not make Issue creation atomic across processes.
- If a comment write succeeds but the follow-up count refresh fails, the
  service returns `201` with `commentCount: null`, `refreshFailed: true`, and a
  warning. The write is authoritative and a retry with the same submission id
  returns the existing comment.
- Reaction switches are not atomic. The target is added before the old reaction
  is deleted. If an operation fails, the service refreshes GitHub reactions and
  returns `200` with `partial: true` and a warning; retrying the partial state
  converges by keeping the target and cleaning stale reactions. A write is
  considered possibly applied when it succeeds or fails ambiguously (lost
  response, timeout, GitHub 5xx, `github_unavailable`, or `github_error`). If
  any such write exists but that refresh also fails, the service returns
  `502 reaction_state_unknown` without a fabricated snapshot; clients should
  reload before retrying. Definitive pre-write rejections (authentication,
  permission, not-found, validation, rate limit) do not trigger the unknown
  state; if no write may have applied and the refresh fails, the service keeps
  `502 github_unavailable`. Sending `expectedViewer` makes a retry based on
  stale browser state return `200` with `conflict: true` and the actual
  snapshot without changing reactions.
- OAuth state is valid for 10 minutes and single-use. An invalid state returns a
  `400` JSON error rather than trusting an unvalidated `returnTo`.
- Attachment validation is allow-list based (MIME + extension + magic); this is
  not a guarantee that an allowed file is benign. PDFs and images can contain
  active or malicious content. Serve from a hardened/download-only setup if
  your threat model requires it.
- Local attachment URLs are unguessable random tokens but are not private once
  shared. There is no deletion endpoint; remove files and database rows manually
  if needed.
- The service does not expose OAuth tokens, client secrets, read tokens, or
  attachment bearer tokens in JSON. It does set its own session cookie, which is
  a credential and is `HttpOnly`.
- Access logs include method, path without query string, and status code. They
  do not include cookies, headers, bodies, OAuth codes, or tokens.

## Tests

From `hugo-deepseek-theme/server`:

```bash
python3 -m unittest discover -s tests -v
```

The suite starts real local HTTP servers and uses a persistent cookie jar. It
uses `tests/mock_github.py` for OAuth authorize/token endpoints, the GitHub REST
API, writes, reactions, pagination, deterministic comment/reaction list
failures, selective reaction add/delete failures, applied-but-lost reaction
write responses, and the attachment HTTP upload endpoint.

Coverage includes login/callback/logout, state and return-URL validation,
CSRF/Origin rejection, issue creation/idempotency/search fallback, viewer-token
comment creation, metadata stripping, all visibility filters, comment refresh
failure and idempotent retry behavior, `submissionId` validation and deliberate
duplicate submissions, pre-write read failure safety, quote metadata round
trips and marker escaping, reaction switch/partial-failure recovery,
`expectedViewer` conflict handling, `reaction_state_unknown` after a lost
post-write read, applied-but-lost add/delete responses, definitive pre-write
failure handling, GitHub 401/403/404/422/429/5xx mapping, disabled/local/HTTP
attachments, file type/magic/size rejection, public attachment serving, no
read-token writes, and secret-free responses.

Testing notes from this development environment:

- 51 tests passed with `python3 -m unittest discover -s tests -v`.
- Python syntax checks pass (`python3 -m py_compile app.py tests/*.py`).
- The mock tests do not contact GitHub or an external attachment service. An
  owner account was separately used for live GitHub login and comment writes;
  non-collaborator writes and an external attachment service remain unverified.
