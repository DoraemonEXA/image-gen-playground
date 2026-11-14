# MCP image service with OTP-backed OAuth

The optional remote MCP service lets coding agents generate and edit images using existing multi-user accounts. Users authorize a client in their browser using the same username and authenticator OTP as the playground. The agent receives separate OAuth credentials; it never receives the authenticator secret, browser session cookie, or provider API key.

## Enable and connect

1. Use the existing single-process deployment and persistent volume. Set `APP_ORIGIN` to the public HTTPS origin and `MCP_ENABLED=true`, then restart the app. The default is `false`; single-user mode never exposes this service.
2. In an OAuth-capable MCP client, add a remote Streamable HTTP server with URL `https://your-domain/mcp`. No client secret or manually provisioned API key is needed.
3. Follow the client's browser authorization link. Sign in with the existing username and OTP if needed, check the client ID and callback address, and approve access.
4. Ask the agent to generate or edit an image. Results also appear in the authorizing user's browser history.

The server uses the official TypeScript MCP SDK, supports the 2026-07-28 protocol and the SDK's stateless compatibility mode for 2025 clients, and supports both HTTPS client metadata documents and dynamic client registration. Public clients must use Authorization Code with PKCE S256. Callbacks must use HTTPS or HTTP on `localhost`, `127.0.0.1`, or `[::1]`; native HTTP loopback callbacks may vary their port. Custom URI schemes and the old separate HTTP+SSE transport are not supported. A particular agent application's compatibility still requires testing with that application.

Client metadata documents are fetched over public HTTPS on port 443, with pinned DNS resolution, no redirects, a five-second timeout and a 64 KiB limit. Names are self-reported by clients; inspect the identifiers on the consent screen. Registration and authorization endpoints are rate limited. Keep the existing trusted proxy/IP configuration correct. CLI requests can omit `Origin`; a supplied origin must match `APP_ORIGIN`.

## Tools and permissions

| Tool             | Scope             | Result                                                                                                                                 |
| ---------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `generate_image` | `images:generate` | A generation ID; starts a paid operation immediately after admission.                                                                  |
| `edit_image`     | `images:edit`     | A generation ID; accepts one to sixteen input images and optional mask/markup.                                                         |
| `get_generation` | `images:read`     | State, result image IDs, accounting state and estimated cost. Only jobs submitted by this client for this user are visible.            |
| `get_image`      | `images:read`     | An image owned by this user, addressed by its image ID. SVG is returned as an MCP binary resource; raster output is MCP image content. |

Request all three scopes for the complete generation/edit/result flow. `images:read` can read an owned image by ID, including an existing browser image explicitly supplied to an agent, but there is no history listing or administration tool.

Generation/edit inputs use the existing model catalog, default model, image options and provider request construction. Tool schemas describe the supported fields. Both write tools require a unique `request_id`. Persist and reuse it when retrying the **same** operation. Reusing it with different inputs fails. Idempotency is scoped to user + client, survives process restarts and content deletion, and applies to failed/interrupted operations too. Intentionally submitting again requires a new ID and can incur another charge.

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

## Accounting and operation lifetime

MCP uses the same shared balance, per-user/global concurrency limits, owner-scoped files, retention and exactly-once ledger settlement as browser requests. There is no queue. Insufficient balance or capacity rejects admission without calling the provider. Provider SDK automatic retries remain disabled.

The HTTP tool call returns after admission; the image operation continues in the existing application process. Disconnecting a client or revoking a grant does not cancel already admitted work. Those operations may finish and be charged. A process restart marks interrupted work for reconciliation and never automatically resubmits it. Polling or retrying with the same request ID does not repeat the provider call. Provider failures or missing usage remain subject to the existing reconciliation workflow.

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

OAuth grants are scoped to this MCP resource and confer no browser or admin API access. Discovery remains public while enabled; MCP authentication failures return a `WWW-Authenticate` discovery challenge. Logs should not capture Authorization headers, token request bodies, authorization codes, or image prompts. Monitor ordinary HTTP error rates and use the existing administration overview for spending and reconciliation.

## Verification

`npm test` covers the migration, discovery/registration, PKCE/consent, token rotation/replay/revocation, scopes, ownership, request idempotency, provider errors and settlement. It exercises current and legacy MCP protocol versions through the official client SDK using a mock image provider. `npm run test:browser` includes OTP login through browser consent, a real HTTP MCP SDK connection and grant revocation. These checks do not establish compatibility with every coding-agent application or validate a production deployment.
