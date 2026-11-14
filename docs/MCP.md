# MCP image service with OTP-backed OAuth

The optional remote MCP service lets coding agents generate and edit images using existing multi-user accounts. Users authorize a client in their browser using the same username and authenticator OTP as the playground. The agent receives separate OAuth credentials; it never receives the authenticator secret, browser session cookie, or provider API key.

## Enable and connect

1. Use the existing single-process deployment and persistent volume. Set `APP_ORIGIN` to the public HTTPS origin and `MCP_ENABLED=true`, then restart the app. The default is `false`; single-user mode never exposes this service.
2. In an OAuth-capable MCP client, add a remote Streamable HTTP server with URL `https://your-domain/mcp`. No client secret or manually provisioned API key is needed.
3. Follow the client's browser authorization link. Sign in with the existing username and OTP if needed, check the client ID and callback address, and approve access.
4. Ask the agent to generate or edit an image. Results also appear in the authorizing user's browser history.

For Cursor, copy [the sample mcp.json](examples/mcp.json) to `.cursor/mcp.json` in your client project, or merge its `image-playground` entry into an existing configuration. Replace `https://images.example.com` with the server's `APP_ORIGIN`. The client discovers OAuth and the available scopes automatically; sign in with your username and OTP in the browser when prompted. No OTP, API key, client secret, or Authorization header belongs in this sample. Other clients may use a different configuration schema; see the [Cursor MCP configuration documentation](https://cursor.com/docs/mcp) for this format.

The server uses the official TypeScript MCP SDK, supports the 2026-07-28 protocol and the SDK's stateless compatibility mode for 2025 clients, and supports both HTTPS client metadata documents and dynamic client registration. Public clients must use Authorization Code with PKCE S256. Callbacks must use HTTPS or HTTP on `localhost`, `127.0.0.1`, or `[::1]`; native HTTP loopback callbacks may vary their port. Custom URI schemes and the old separate HTTP+SSE transport are not supported. A particular agent application's compatibility still requires testing with that application.

Client metadata documents are fetched over public HTTPS on port 443, with pinned DNS resolution, no redirects, a five-second timeout and a 64 KiB limit. Names are self-reported by clients; inspect the identifiers on the consent screen. Registration and authorization endpoints are rate limited. Keep the existing trusted proxy/IP configuration correct. CLI requests can omit `Origin`; a supplied origin must match `APP_ORIGIN`.

## Tools and permissions

| Tool             | Scope             | Result                                                                                                                                 |
| ---------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `generate_image` | `images:generate` | A generation ID; starts a paid operation immediately after admission.                                                                  |
| `edit_image`     | `images:edit`     | A generation ID; accepts one to sixteen input images and optional mask/markup.                                                         |
| `get_generation` | `images:read`     | State, result image IDs with signed download URLs, accounting state and estimated cost. Only jobs submitted by this client for this user are visible. |
| `get_image`      | `images:read`     | An owned image by ID, plus a signed download URL. SVG remains an MCP binary resource; raster output remains MCP image content. |

Request all three scopes for the complete generation/edit/result flow. `images:read` can read an owned image by ID, including an existing browser image explicitly supplied to an agent, but there is no history listing or administration tool.

Generation/edit inputs use the existing model catalog, default model, image options and provider request construction. Tool schemas describe the supported fields. Both write tools require a unique `request_id`. Persist and reuse it when retrying the **same** operation. Reusing it with different inputs fails. Idempotency is scoped to user + client, survives process restarts and content deletion, and applies to failed/interrupted operations too. Intentionally submitting again requires a new ID and can incur another charge.

### Parameter validation and correcting failures

Prefer omitted options (the defaults), or `quality: "low", size: "1024x1024", output_format: "png", n: 1` for an explicit draft. `low` is supported; `512x512` is too small for a still image. Tools advertise field ranges and conditional constraints through `tools/list`, and the server checks them before creating a job or contacting the provider.

| Field | Contract |
| --- | --- |
| `size` | `auto` or `WIDTHxHEIGHT`. Still-image edges must be multiples of 16 and at most 3840; long/short ratio at most 3; total pixels 655,360–8,294,400. Common sizes: `1024x1024`, `1536x1024`, `1024x1536`. |
| `quality` | `auto`, `low`, `medium`, `high`; `xhigh`/`max` additionally for GPT Image 2.5/2.6. |
| `n` | Integer 1–10; SVG requires 1. |
| `output_format` | PNG/JPEG/WebP for all selectable models. GIF requires 2.6. SVG requires 2.6 and generate mode. JPEG cannot have a transparent background. |
| `output_compression` | Integer 0–100, JPEG/WebP only; otherwise omit. |
| `complexity` | `low`, `medium`, `high`, for 2.6 only; otherwise omit. |
| GIF options | `frame_count`: integer 2–16 (default 9); `frame_duration_ms`: integer 20–2000 (default 200). Omit both for other formats. Frame dimensions are validated against the tiled sheet, not as independent still images; the batch sheet budget is 16,777,216 pixels. |
| SVG options | `svg_model` must be in the writer catalog; `svg_reasoning_effort` must be supported by that writer. Omit both for other formats. |

Local validation returns a tool error with the offending field and correction guidance. No job or idempotency record is created, so the caller can correct an unadmitted request. For admitted jobs, poll `get_generation`: a failed/partial result includes a sanitized `error` object with `status`, `code`, `param`, `message`, and provider `request_id` when available. Raw provider messages are not returned or stored because they can echo secrets and input content. Existing historical failures without recorded details cannot be reconstructed. A corrected resubmission of an **admitted** request requires a new `request_id`; exact retries return the original job, including failures.

Example generation arguments:

```json
{
    "request_id": "project-logo-001",
    "prompt": "A friendly illustrated tree on a transparent background",
    "background": "transparent",
    "output_format": "png"
}
```

Poll `get_generation` with the returned `generation_id` every two seconds while its state is `running`. Once complete, pass a returned `image_id` to `get_image`. Edits accept `images: [{"image_id": "..."}]` (also requires read scope) or `images: [{"data": "BASE64_BYTES", "mime_type": "image/png"}]`. PNG, JPEG and WebP are accepted as inputs. Masks and markup use the same representation. Paths on the agent's computer and arbitrary remote URLs are not fetched by the server. The agent/client must read local files and supply their bytes. MCP JSON requests have a 100 MB ceiling including base64 expansion, and resolved image inputs also have a 100 MB aggregate ceiling.

### Downloading images without a browser login

Each image in `get_generation.images` includes `image_id`, `download_url`, and `download_url_expires_at` (UTC ISO 8601). `get_image` returns the same fields in `structuredContent` and an appended JSON text content item, while preserving its original image/binary content as the first item. Clients can display the URL in an image element or download it with an ordinary HTTP request:

```sh
curl --fail --silent --show-error "<download_url>" --output image.png
```

On Windows PowerShell use `curl.exe`. Replace `<download_url>` with the complete returned URL and use the image's extension. The URL supports repeated `GET` and `HEAD` requests without cookies or an Authorization header. The existing `/api/image/<image_id>` browser endpoint still requires a browser login.

`HEAD` returns the status and image/security headers without a body. Next.js controls HTTP framing and may strip the route's `Content-Length`; clients must not require that header to download or preview an image.

Links last one hour from issuance, capped by the authorizing OAuth grant's expiry. They remain valid across the client's 15-minute access-token expiry, token refresh, and server restarts with the same origin, key, and data. Call authenticated `get_generation` or `get_image` again to obtain a fresh URL; this does not regenerate the image or incur another provider charge. The response's expiry is an upper bound: revoked or expired grants, disabled accounts, authenticator resets, image/history deletion, retention deletion, or disabling MCP stop subsequent downloads immediately. Invalid and unavailable links return `404`, without a login redirect. Already-downloaded copies cannot be revoked.

Treat the complete URL as a bearer credential: anyone who possesses it can read that one image while it is valid. Do not place it in public logs or analytics. Configure reverse proxies, hosting access logs and error trackers to redact the `token` query parameter on `/api/mcp/images/*` (or omit query strings for that route); the application does not log download tokens. Responses use `no-store`, `nosniff`, `no-referrer`, and a sandbox policy for SVG content. These headers do not prevent recipients from saving copies.

Download signatures use an HKDF-derived HMAC key from the existing `AUTH_ENCRYPTION_KEY` and `APP_ORIGIN`; no additional secret, database migration, or storage service is required. Keep the existing encryption key stable because it also protects account authenticator secrets. Use **Connected agents** to revoke access instead of rotating that key.

## Accounting and operation lifetime

MCP uses the same shared balance, per-user/global concurrency limits, owner-scoped files, retention and exactly-once ledger settlement as browser requests. There is no queue. Insufficient balance or capacity rejects admission without calling the provider. Provider SDK automatic retries remain disabled.

The HTTP tool call returns after admission; the image operation continues in the existing application process. Disconnecting a client or revoking a grant does not cancel already admitted work. Those operations may finish and be charged. A process restart marks interrupted work for reconciliation and never automatically resubmits it. Polling or retrying with the same request ID does not repeat the provider call. Provider failures or missing usage remain subject to the existing reconciliation workflow.

Administrators can opt into `AUTO_RECONCILE_INVALID_REQUESTS=true` for providers that guarantee initial parameter-validation rejections are uncharged. Only the narrow initial HTTP 400 classification described in [the accounting guide](MULTI_USER.md#balance-and-accounting) is settled automatically at zero. Unknown charges remain `needs_reconciliation`; failed jobs remain failed. This policy neither regenerates images nor clears old records.

Run one long-lived app process against one local persistent SQLite volume. Do not deploy the job runner as an ephemeral serverless function or scale this service across workers sharing SQLite. Set `MCP_ENABLED=false` and restart to stop new OAuth/MCP access without deleting accounts, images or grants. Database migration version 2 is additive; an older application that understands only version 1 will refuse that database. Back up the volume before upgrading if a binary rollback is needed, and preserve `AUTH_ENCRYPTION_KEY`.

## Tokens, revocation and endpoints

Authorization codes expire after five minutes and are single use. Access tokens last up to 15 minutes; refresh tokens rotate on each use. Grants expire 30 days after approval, without sliding renewal. Credential values are stored hashed. Reusing a spent refresh token revokes the entire grant; clients must serialize refresh requests and save the replacement token. A valid authorization-code replay also revokes its grant.

Use **Connected agents** in the playground header to revoke a grant immediately. Account disabling and authenticator resets revoke all that user's grants. Browser sign-out affects its browser session independently. Signing in or enabling an account again does not restore revoked agent access.

- `GET /.well-known/oauth-protected-resource/mcp` (also available at the root protected-resource discovery path)
- `GET /.well-known/oauth-authorization-server`
- `GET /oauth/authorize`; browser consent at `/oauth/consent`
- `POST /oauth/register` with JSON client metadata
- `POST /oauth/token` with URL-encoded `authorization_code` or `refresh_token` parameters, `client_id`, and `resource=<APP_ORIGIN>/mcp`
- `POST /oauth/revoke` with URL-encoded `client_id` and `token`
- `/mcp` with `Authorization: Bearer <access_token>`
- `GET` / `HEAD /api/mcp/images/<image_id>?token=<signed_download_token>` with the complete URL returned by MCP

OAuth grants are scoped to this MCP resource and confer no browser or admin API access. Discovery remains public while enabled; MCP authentication failures return a `WWW-Authenticate` discovery challenge. Logs should not capture Authorization headers, token request bodies, authorization codes, or image prompts. Monitor ordinary HTTP error rates and use the existing administration overview for spending and reconciliation.

## Verification

`npm test` covers the migration, discovery/registration, PKCE/consent, token rotation/replay/revocation, scopes, ownership, request idempotency, provider errors and settlement. Signed-download checks cover unauthenticated GET/HEAD, tampering, expiry, token refresh, database reopen, deletion/retention, account/grant changes and unchanged billing. It exercises current and legacy MCP protocol versions through the official client SDK using a mock image provider. `npm run test:browser` includes OTP consent, real HTTP MCP generation, an image preview in a browser context without cookies, private browser-route enforcement and download revocation. These checks do not establish compatibility with every coding-agent application or validate a production deployment.
