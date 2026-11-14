# Multi-user deployment

Optional remote MCP access for coding agents uses the same OTP accounts and shared balance. See [MCP setup and OAuth authorization](MCP.md). It is disabled by default (`MCP_ENABLED=false`).

The fork defaults to `APP_MODE=multi-user`. Users sign in with an administrator-assigned username and a six-digit authenticator code. There is no registration, email login, or shared-password bypass. History follows the account across browsers. Sessions expire after 30 days.

## Deploy on one Docker server

Use a Linux server with Docker Compose, a domain pointing to it, and ports 80/443 available. This configuration runs one application process with local SQLite and private files. Do not scale the application service or place its SQLite volume on a network filesystem.

1. Copy `.env.example` to `.env` and set `APP_ORIGIN` to your HTTPS origin and `OPENAI_API_KEY` to the shared server key.
2. Generate `AUTH_ENCRYPTION_KEY` once:

    ```sh
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    ```

    Store it in `.env` and keep a separate secure backup. It encrypts authenticator secrets. Replacing it without migrating those secrets prevents login. Do not commit `.env`.

3. Start the application:

    ```sh
    docker compose up -d --build
    docker compose exec app npm run admin -- setup-link
    ```

4. Open the printed setup link in a browser. Choose an admin username, scan the QR in an authenticator app, and enter its code. The account activates only after verification.
5. In Administration, add the opening shared balance, then create users and distribute their usernames and QR codes privately.

The setup link expires after 30 minutes. Issuing another link invalidates the previous link and its unfinished enrollment. Its token is carried in the URL fragment and removed from browser history when the page loads. After successful activation, initial setup closes permanently. A repeated setup command cannot create another administrator.

The application starts with a zero balance. No generation or editing call is admitted until an admin adds funds. Caddy terminates HTTPS and supplies the trusted client IP. The application port is not published; keep it that way when `TRUST_PROXY=true`. Configure any additional proxy explicitly instead of exposing a path around Caddy.

The container starts as an unprivileged user. Named volumes persist account data, images, and Caddy certificates. The separate `legacy-images` volume is used only in single-user mode. Startup validates configuration, migrates SQLite, checks the encryption key against existing accounts, and marks interrupted requests for review.

## Balance and accounting

All accounts, including the administrator, use the same API key and balance. There are no personal credit allocations.

Automatic balance/session checks run in the background at most once per minute while the page is visible. Returning to a recently checked tab keeps the playground visible without another request; returning after a minute allows a fresh check. Generation and admin balance changes still refresh the balance immediately, and cross-tab sign-out notifications still invalidate the session immediately.

- **Add funds** adds a positive amount. **Set remaining balance** records the difference from the current balance. Both require a reason and create ledger entries. A set operation is rejected if the form's balance revision is stale.
- Charges use the upstream token-cost calculator, including SVG writer usage, and are stored as integer units of $0.0001. The ledger is an application estimate; it is not synchronized with the provider's billing system or spending outside this app.
- Provider usage is recorded before image persistence and response delivery. A paid operation can therefore be charged even if saving or downloading its image fails.
- Each request has one unique settlement. Preview events and duplicate completion handling cannot debit it twice.
- Missing or invalid usage is shown under **Needs reconciliation**. Enter the full verified charge, or `0` when confirmed uncharged, with a reason. Failed requests whose provider charge is uncertain appear here too. Unknown charges are not counted as known spending until reconciled.
- A nonpositive balance blocks new requests. Already admitted calls can finish and make the balance negative. This is not a strict provider-side spending ceiling.
- Deleting or clearing history removes its images and prompts but retains the accounting record. Admin overview and ledger endpoints expose no other user's prompts or images.

Concurrency defaults to one generation per user and four across the server. Change `MAX_ACTIVE_PER_USER` and `MAX_ACTIVE_GLOBAL` to adjust those limits. Excess requests receive HTTP 429 and are not queued. Multi-user API calls disable automatic SDK retries to avoid silently repeating a paid request.

## Language, theme, and automatic retention

The display controls on every screen offer English / 简体中文 and System / Light / Dark themes. New browsers use English and follow the operating system theme. Choices are stored in that browser and shared across its tabs, not synchronized with the account. Prompts, usernames, API model identifiers, and unknown provider errors are preserved. Amounts remain in USD.

To automatically delete old multi-user images and their visible history, set `IMAGE_RETENTION_DAYS` to a positive whole number in your deployment environment, for example `IMAGE_RETENTION_DAYS=30`, then recreate the app container (`docker compose up -d app`). An unset value or `0` disables retention; invalid values prevent startup. Local development reads the same setting from `.env.local` after restarting.

The policy applies to **existing and future** multi-user generations, measured from their creation time in 24-hour days. An initial sweep runs after startup recovery, followed by hourly sweeps while the app runs. A generation becomes eligible strictly after its age exceeds the configured number of days; active requests are skipped. Cleanup works without an open browser and catches up after downtime. The existing single-process deployment requirement still applies.

Expired files and prompts are deleted, and their entries disappear from visible history. Accounting records, shared balance, personal spending, and outstanding reconciliation are retained. Visible-history totals count only remaining images. Failed file removals remain in the garbage queue for the next sweep; tombstoned files remain inaccessible through the app. Logs report expired/removed/failed counts without prompts. Retention does not delete backups or any single-user filesystem/IndexedDB data. Take a coordinated backup before first enabling it if existing images need to be preserved.

## Account recovery

Administrators can disable, enable, and reset regular accounts in the web interface. Disable and reset revoke all sessions. Reset replaces the authenticator secret; the old QR no longer works. QR codes are displayed only during provisioning/reset. The first code used to activate/login cannot be used again during the same accepted time window; wait for the next code if necessary.

For a lost administrator authenticator, run:

```sh
docker compose exec app npm run admin -- recover ADMIN_USERNAME
```

This operator-only command revokes sessions and writes `/data/recovery-ADMIN_USERNAME.png`, also printing the manual setup key. Copy the QR out using `docker compose cp`, scan it, and remove the recovery file from the volume. Recovery does not reopen setup. No default or emergency password exists.

The privacy guarantee is enforced by application ownership checks. Administrators have no content-inspection or impersonation endpoint. Server operators still control the database, encryption key, and filesystem, and account administrators can issue replacement authenticators; this is not end-to-end encryption against those operators.

## Backup, restore, and upgrades

Back up the entire `playground-data` volume and the encryption key separately. Do not copy only a live SQLite main file: it may have committed data in its WAL, and image files must match the database snapshot.

A coordinated backup on the Docker host:

```sh
mkdir -p backups
docker compose stop app
docker compose run --rm --no-deps --user root --entrypoint sh \
  -v "$PWD/backups:/backup" app \
  -c 'umask 077; tar -C /data -czf /backup/playground.tar.gz .'
docker compose up -d app
```

To restore, stop the application and restore that archive into a fresh, empty data volume. Set its ownership to the image's `node` user (UID/GID 1000), restore the same encryption key, and start exactly one app process against it. Verify login, balance, and image retrieval before changing DNS or opening the restored deployment. Never merge restored files into an active database volume. Test restores periodically.

Before an upgrade, take a coordinated backup, then run `docker compose up -d --build`. Migrations run before requests are accepted and reject databases newer than the running application. Rollback requires a compatible database or restoring the pre-upgrade snapshot. Requests interrupted by shutdown are not automatically resubmitted; inspect reconciliation afterward.

`/api/health` reports readiness without exposing account information. Monitor HTTP errors, disk space, a low/negative shared balance, and the reconciliation list. Keep the host clock synchronized for TOTP.

## Local development and compatibility

For multi-user development, copy the example to `.env.local`, set `APP_ORIGIN=http://localhost:3000`, provide the encryption/API keys, then run:

```sh
npm ci
npm run dev
npm run admin -- setup-link
```

The CLI reads `.env.local` and `.env`; already supplied process environment variables take precedence. HTTP cookies are permitted only on localhost development origins. Public deployments require HTTPS. Do not run multiple development/production servers against the same data directory.

To explicitly retain upstream behavior, set `APP_MODE=single-user`. Existing `APP_PASSWORD`, filesystem storage, and IndexedDB storage remain available in that mode. Multi-user mode never reads or imports legacy browser history, IndexedDB images, or `generated-images` files. Switching modes does not migrate or delete either dataset. `NEXT_PUBLIC_IMAGE_STORAGE_MODE=indexeddb` is rejected at multi-user startup.

## Upstream merge map

Most fork code lives in `src/modules/multi-user`. Its internal SQLite, TOTP, ledger, and UI implementation is independent of generation forms and provider parameters.

The intentional upstream integration points are:

- Generation route: create request access, admit before the provider call, settle received usage, store completed images, and finish the request. Both streaming branches follow the same lifecycle. Never charge in a client callback.
- Image read/delete routes: delegate to owner-scoped access in multi-user mode. Filename secrecy is not authorization.
- Auth-status route: announce the server-selected mode without accepting client mode overrides.
- Homepage: mount the account runtime before reading browser storage; use its scoped fetch and server-history adapter. History entries gain stable IDs and server totals.
- History presentation: accept aggregate totals and display partial/reconciliation states.
- Instrumentation/configuration: initialize storage at server startup and package the native SQLite dependency.

Keep upstream OpenAI request construction, model catalogs, pricing functions, and form components as the source of truth. When upstream adds a new result path, call settlement before writing files or emitting success, and ensure the request's authenticated owner is retained. Do not copy the route into a second implementation. Session-bound request headers protect against submitting an old tab's form under a new account's cookie.

Display extensions live in `src/modules/preferences`. Shared components call its translation hook with English source text; missing translations fall back to that text. The root layout mounts the preference controls and the existing theme provider. Form changes are limited to displayed copy and semantic color classes; provider values and validation functions retain their upstream contracts. Known English errors are localized only at presentation boundaries. Keep image overlays, mask/markup canvas colors, and image bytes independent of the theme.

Retention lives in `src/modules/multi-user/retention.ts`, started by the existing runtime initialization hook. It reuses transactional history deletion and the garbage queue, with no database migration or new HTTP endpoint. Configuration also adds one environment variable to Compose and the example environment file.

When merging upstream: review new/changed English copy and add Chinese catalog entries; check new color classes in both themes; exercise generation, streaming, editing, and history in both languages; and rerun the retention/accounting tests. Keep locale, theme, and retention changes in separate commits when integrating. These boundaries reduce conflicts but do not eliminate conflicts in shared UI files.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:browser
npm audit --omit=dev
```

Tests use a local mock provider and temporary SQLite/image directories; they do not spend API credits. Browser tests run a production build on port 3111. They use installed Edge on Windows, or Playwright Chromium elsewhere (`npx playwright install chromium`). Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use another installed Chromium browser. Test artifacts stay under `.cache`, `test-results`, and `playwright-report`.

The operator should also run `docker compose config`, build/start the containers, and exercise backup/restore on the deployment host. Local tests alone do not establish a successful production rollout.
