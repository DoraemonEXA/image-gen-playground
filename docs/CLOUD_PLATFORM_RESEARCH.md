# Railway vs. Cloudflare deployment research

Research date: 2026-11-12. Scope: current official Railway and Cloudflare documentation, applied to this repository's existing Docker/Next.js architecture. This is a recommendation only; no account settings were inspected and no deployment was performed.

## Decision

**Deploy the current application on Railway.** Railway can run the existing Docker image and attach one persistent local volume at `/data`, which matches the application's single-process `better-sqlite3` WAL database and filesystem image store. Railway volumes explicitly support SQLite backups and explicitly cannot be used with replicas, so the platform constraint reinforces the application's required singleton topology.

Cloudflare Workers/OpenNext is **not a drop-in target** for the current application. Workers' `node:fs` is a memory-backed virtual filesystem whose writable `/tmp` is isolated to one request and is not persistent. In addition, `better-sqlite3` loads a native C++ Node addon. Moving to Workers would therefore be an application migration: replace `better-sqlite3` and local files with Cloudflare storage bindings, redesign process-local scheduling/concurrency, and revalidate all generation paths.

Cloudflare Containers can run a normal Linux container, but its disk is ephemeral by default and returns to a fresh image after sleep. Durable Object container snapshots are point-in-time and expire after 30 days unless restored; FUSE-to-R2 is available but is not native-SSD-like storage. Neither is equivalent to an always-durable local volume for SQLite WAL. Containers are consequently a possible future redesign, not the lowest-risk home for this build.

## Current project structure

| Location | Responsibility and deployment implication |
| --- | --- |
| `src/app/` | Next.js App Router pages and API routes in one application; no separate frontend/backend services are needed. |
| `src/components/`, `src/lib/` | Shared UI, model definitions, pricing, and image utilities. Preserve these when changing deployment platforms. |
| `src/modules/multi-user/` | Accounts, encrypted TOTP, sessions, shared balance, private history, file persistence, and retention. This is the main stateful boundary. |
| `src/modules/preferences/` | Language and display preferences; does not require a separate service. |
| `src/instrumentation.ts` | Startup configuration checks, database migration, interrupted-request recovery, and retention worker startup. |
| `Dockerfile` | Node 24 Debian build/runtime, native SQLite build tools, an unprivileged runtime user, and a health check. |
| `compose.yaml`, `deploy/Caddyfile` | Existing single-server deployment with HTTPS proxy and named volumes. Railway can provide HTTP ingress/TLS directly; deploy the app Dockerfile as one service. |
| `scripts/admin.ts` | First-admin setup and administrator authenticator recovery; execute against the deployed volume. |

The live data layout is `/data/playground.sqlite` plus SQLite sidecar files and `/data/images/`. The directory must survive replacement of the application container. The existing [multi-user guide](MULTI_USER.md) describes account and recovery behavior. Its explicit single-process requirement also follows from startup recovery marking active database requests as interrupted. A second application process could incorrectly recover requests still running in the first process.

The upstream README's browser IndexedDB/serverless instructions apply only to `APP_MODE=single-user`. Multi-user startup explicitly rejects IndexedDB storage. No Railway/Wrangler/OpenNext configuration is currently checked in.

## Railway: compatibility and required configuration

| Concern | Finding for this app |
| --- | --- |
| Runtime | Railway supports Dockerfile services and injects `PORT`. Next.js should listen on `0.0.0.0` and `PORT`; the existing `next start`/Docker approach is compatible. [Railway application response troubleshooting](https://docs.railway.com/networking/troubleshooting/application-failed-to-respond) |
| Durable state | Attach one volume at **`/data`** and set `APP_DATA_DIR=/data`. Volumes are mounted only at runtime, not during build or pre-deploy commands. [Using volumes](https://docs.railway.com/volumes) |
| Non-root image | Railway mounts volumes as `root`. Its documented workaround for images that run as a non-root UID is **`RAILWAY_RUN_UID=0`**. This repository's Docker image ends with `USER node`, so this variable is required unless the image gains a root entrypoint that prepares `/data` and then drops privileges. Dockerfile-time `chown` cannot prepare a volume that is attached only at runtime. [Using volumes: permissions](https://docs.railway.com/volumes#permissions) |
| Process count | Keep exactly one service instance. Railway states that replicas cannot be used with volumes; volume-backed deploys also have a short downtime because two deployments cannot mount the same volume concurrently. [Volume reference: caveats](https://docs.railway.com/volumes/reference#caveats) |
| Health check | Configure `/api/health`. Railway uses a successful `2xx` only to gate a deployment; it is not continuous monitoring. The default startup health-check window is 300 seconds. [Health checks](https://docs.railway.com/deployments/healthchecks) |
| Backups | Enable scheduled volume backups. Railway explicitly says volume backups cover SQLite, with daily backups retained 6 days, weekly 27 days, and monthly 89 days. Restores create a new mounted volume and retain the prior one unmounted. [Volume backups](https://docs.railway.com/volumes/backups) |
| Sleeping | Leave Serverless/app sleeping **off initially**. A sleeping service may return a `502` on its first request, and in-process retention work cannot run while the container is asleep. Railway detects inactivity from outbound traffic and commonly sleeps after 5-10 minutes without it. [Serverless](https://docs.railway.com/deployments/serverless) |
| Operations | Use `railway ssh` to inspect the deployed container. `railway run` only executes a command **locally** with service variables injected, so it does not inspect the mounted production `/data`. [SSH](https://docs.railway.com/cli/ssh), [run](https://docs.railway.com/cli/run) |

### Request duration, SSE, and a Cloudflare proxy in front

Railway public HTTP requests may run for at most 15 minutes while bytes continue to transfer, but a request is closed after 5 minutes with no data transferred. WebSockets are exempt. [Railway public-network limits](https://docs.railway.com/networking/public-networking/specs-and-limits)

This distinction matters here: an SSE heartbeat helps only **after the response stream has begun**. The image routes can wait for an upstream image call before creating the streaming response, and synchronous paths may also remain silent. A request that receives no upstream response within 5 minutes can therefore still be terminated even if a later SSE phase would have heartbeats. Treat 5 minutes as the direct-Railway silent-response ceiling and test the longest image/edit operation end to end.

If the custom domain is orange-cloud proxied through Cloudflare, the default Cloudflare proxy read timeout is currently **125 seconds**, substantially shorter than Railway's silent timeout. Only Enterprise zones can raise it, up to 6,000 seconds; Cloudflare otherwise recommends moving long-running operations to a DNS-only subdomain or redesigning them as polling. [Cloudflare error 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/), [connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)

### Client IP / forwarded headers

Railway documents `X-Real-IP` as the client's remote IP and `X-Forwarded-Proto` as `https`. [Railway public-network limits](https://docs.railway.com/networking/public-networking/specs-and-limits#technical-specifications) A Railway employee further states that the edge strips client-supplied `X-Forwarded-For`, overwrites `X-Real-IP` with the connecting client IP, and, when trusted Cloudflare infrastructure is in front, overwrites it with `Cf-Connecting-IP`. [Railway staff response](https://station.railway.com/questions/security-critical-questions-on-edge-prox-8fddd775)

For the proposed deployment exclusively through Railway's public HTTP edge, set **`TRUST_PROXY=true`**: this application's flag specifically enables reading `X-Real-IP`. Leaving it false puts all clients in the same `direct` IP-throttle bucket (`src/modules/multi-user/http.ts`). Do not add a TCP-proxy bypass or allow untrusted private services to supply this header. Verify that a forged client `X-Real-IP` is replaced before accepting production traffic; re-test when changing ingress. No application header-parsing change is indicated for the proposed topology.

## Recommended Railway rollout

1. Create a Railway service from the GitHub repository with the repository root as its root directory. Use the checked-in `Dockerfile` and retain its start command. Caddy, PostgreSQL, and Redis are not required for this initial deployment.
2. Attach one volume at `/data`, select one region near the intended users, keep one instance, and disable Serverless sleeping. An initial memory allowance of 1-2 GB is a sizing suggestion, not a measured requirement; monitor peak usage during large image uploads and concurrent generation.
3. Add a Railway-generated or custom HTTPS domain, target port `3000`, and the variables below. Use one canonical browser origin: the app compares mutation request origins exactly against `APP_ORIGIN`. For a custom domain managed by Cloudflare, add the DNS records Railway supplies and initially select DNS-only. Set `APP_ORIGIN` to that final HTTPS origin before setup.
4. Configure Railway's health-check path as `/api/health`. Leave build/pre-deploy migration commands empty: existing runtime instrumentation initializes the database after the volume is mounted. `PORT=3000` also keeps the existing Docker health check, which uses port 3000, consistent.
5. Deploy and inspect startup logs and `/api/health`. From a Railway SSH session in `/app`, run `npm run admin -- setup-link`; open the printed link within 30 minutes, choose the administrator username, and enroll the authenticator. Then add the opening shared balance in Administration and create users. The app starts at zero balance and rejects generation until funded.
6. Verify login/TOTP, ordinary generation, streamed generation, streamed editing, private history/image access, and shared-balance deductions. Exercise slow requests and GIF/SVG output, for which this app disables streaming. The current SSE branches forward provider events but have no periodic heartbeat; `Connection: keep-alive` is not an application heartbeat. If actual workloads approach the silent-response limit, add early response streaming with periodic heartbeats where supported, or implement durable jobs/status polling for long synchronous paths.
7. Restart/redeploy and confirm accounts, balance, and image files survive. Check interrupted-request reconciliation. Schedule deployments when no paid generation is active; a persistent volume does not make in-flight requests survive a restart.
8. Enable volume backups and rehearse a restore into an isolated environment. Keep a separate secure backup of `AUTH_ENCRYPTION_KEY`. For coordinated application backups, quiesce generation and retention and preserve the entire data directory, including SQLite WAL/sidecar files and images, as described in [MULTI_USER.md](MULTI_USER.md). Add ongoing health/disk monitoring; Railway's deploy health check is not continuous monitoring.

Suggested service variables (replace placeholders in Railway's secret/variable settings):

```dotenv
APP_MODE=multi-user
APP_ORIGIN=https://images.example.com
APP_DATA_DIR=/data
OPENAI_API_KEY=<your-server-api-key>
AUTH_ENCRYPTION_KEY=<64-hex-characters>
PORT=3000
RAILWAY_RUN_UID=0
TRUST_PROXY=true
MAX_ACTIVE_PER_USER=1
MAX_ACTIVE_GLOBAL=4
IMAGE_RETENTION_DAYS=0
```

For a new installation, generate the encryption key once locally with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Store the result securely and retain it across redeploys. Set `OPENAI_API_BASE_URL` only when using a custom compatible provider. Leave `NEXT_PUBLIC_IMAGE_STORAGE_MODE` unset (multi-user mode forces server storage); do not set it to `indexeddb`. Retention `0` preserves history indefinitely; choose `30` only if automatic deletion of existing and future content after 30 days is intended. `APP_PASSWORD` has no role in multi-user mode.

`RAILWAY_RUN_UID=0` is the documented no-code workaround and runs the application as root inside the container. To retain the Dockerfile's unprivileged runtime, a future entrypoint can initialize volume ownership as root and drop to UID/GID 1000 before starting Next.js; validate this on Railway before removing the workaround.

After installing/logging into the Railway CLI and linking the intended project, service, and environment, open a remote session with `railway ssh`. Inside it:

```sh
cd /app
npm run admin -- setup-link
```

For an existing installation, migrate a coordinated copy of the complete data directory into an empty destination volume while the destination application is stopped, and retain its original encryption key. Do not create a fresh administrator or merge data into a running database. Verify the restored accounts, balance, and images before switching traffic. Local `.env.local` and `data/` are excluded from the Docker build and will not transfer automatically.

This review did not build/run Docker, exercise Railway volume permissions, test real provider latency, or execute a cloud deployment. These are rollout checks, not completed validation.

### Startup failure: EACCES creating /app/data/images

This error means the application's process cannot create its image directory. The `/app/data` path also shows that the effective data directory is not the Dockerfile's `/data` default. `APP_DATA_DIR=./data` from the local example resolves to `/app/data` inside the container. An unset variable under a different builder, or an explicit `/app/data` value, can produce the same path; the log alone does not distinguish these cases.

In Railway, check the application's service variables and attached volume together:

| Volume mount path | Application variable | Current image permission workaround |
| --- | --- | --- |
| `/data` (recommended for a fresh deployment) | `APP_DATA_DIR=/data` | `RAILWAY_RUN_UID=0` |
| `/app/data` (if this is already the persistent volume) | `APP_DATA_DIR=/app/data` | `RAILWAY_RUN_UID=0` |

Keep an existing populated volume and its encryption key. Select the row matching that volume rather than pointing the app at a new empty directory. Remove conflicting local-development variable overrides, confirm the service uses the repository Dockerfile, and redeploy after saving the variables. Changing `/data` ownership at image build time does not change permissions on a later mounted volume. Railway documents the root-UID workaround in [volume permissions](https://docs.railway.com/volumes#permissions).

Verify that `/api/health` returns HTTP 200 with `{"status":"ready"}`. If startup still fails, inspect the effective `APP_DATA_DIR`, `RAILWAY_VOLUME_MOUNT_PATH`, process UID, and directory ownership inside that deployment; do not print the complete environment, which includes secrets. This troubleshooting procedure is based on the reported error and source inspection; it has not been executed against the user's deployment.

## Cloudflare alternatives in more detail

### Workers with OpenNext or vinext

Cloudflare's current Next.js guidance says OpenNext supports route handlers and response streaming, but recommends vinext for new Next.js applications; `cf init` chooses vinext for Next.js 16+. Either adapter still executes in the Workers runtime and does not solve this application's durability/native-addon mismatch. [OpenNext adapter](https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/), [automatic framework configuration](https://developers.cloudflare.com/workers/framework-guides/automatic-configuration/)

Workers now exposes more Node APIs, including `node:fs`, but the filesystem documentation is explicit that `/tmp` is request-local and nonpersistent. [Workers filesystem](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/) The `better-sqlite3` project documents that it loads a native C++ addon named `better_sqlite3.node`. [better-sqlite3 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)

A Workers port would need at minimum:

- a new database/storage layer using Durable Objects/D1 and R2 rather than a shared local SQLite file and directory;
- lifecycle and retention work moved from a process interval to alarms/queues/cron;
- concurrency/admission semantics redesigned for distributed isolates;
- image privacy, accounting atomicity, TOTP encryption, SSE, and every ordinary/edit/stream result path re-tested.

Workers itself has no hard wall-time limit for an incoming HTTP request while the client stays connected, and a streaming response stays active, but CPU time on Workers Paid defaults to 30 seconds and can be configured up to 5 minutes. That benefit does not offset the required state migration. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

### Cloudflare Containers

Containers are available on Workers Paid and are designed for software that needs a full filesystem or Linux runtime. [Containers overview](https://developers.cloudflare.com/containers/) They could execute the existing image and native addon, but Cloudflare states:

- all container disk is ephemeral by default and is reset after sleep;
- Durable Object-managed filesystem snapshots are immutable point-in-time copies, not continuous durable volumes;
- snapshots are limited to 20 GB and retained for 30 days from creation or last restore;
- FUSE-to-R2 is possible, but should not be expected to provide native SSD-like performance.

Sources: [Containers FAQ](https://developers.cloudflare.com/containers/faq/), [container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/), [container limits](https://developers.cloudflare.com/containers/platform/limits/).

Persisting configuration in Durable Object storage while keeping SQLite and images on ephemeral container disk would not make the database/images durable. Periodically snapshotting a live WAL database also introduces application-level consistency and recovery orchestration that Railway's continuously attached volume avoids. Cloudflare Containers should be reconsidered only alongside an explicit storage redesign (for example, object storage for images and a Cloudflare-native database), not as a direct deployment switch.

## Cost notes (secondary to fit)

Railway Hobby is currently a $5/month minimum usage commitment including $5 usage; Pro is $20 including $20. Published usage rates include $10/GB-month RAM, $20/vCPU-month CPU, $0.15/GB-month volume storage, and $0.05/GB egress. [Railway pricing](https://docs.railway.com/pricing/plans), [billing explanation](https://docs.railway.com/pricing/understanding-your-bill)

Cloudflare Containers usage is included within the $5/month Workers Paid plan up to published allowances, then billed for active memory, CPU, and disk. Scale-to-zero may be economical, but the storage redesign and operational complexity dominate this application's decision. [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)

Prices and platform limits can change; re-check the linked first-party pages immediately before production provisioning.
