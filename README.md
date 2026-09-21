# ERP API Debug Center

Standalone QA dashboard for sanitized server-side ERP API logs.

## Run Locally

```bash
npm install
npm run dev -- -p 3002
```

Create `.env.local`:

```bash
ERP_API_DEBUG_SHARED_SECRET=change-me
DEBUG_CENTER_MAX_LOGS=300
DEBUG_CENTER_DASHBOARD_USER=qa
DEBUG_CENTER_DASHBOARD_PASSWORD=qa-local
```

Use the same secret in the ERP frontend:

```bash
ERP_RUNTIME_ENV=development
ERP_API_DEBUG_LOGGING_ENABLED=true
ERP_API_DEBUG_CENTER_URL=http://localhost:3002
ERP_API_DEBUG_SHARED_SECRET=change-me
ERP_API_DEBUG_SOURCE=petra-erp-frontend
```

Open `http://localhost:3002`.

## API

- `POST /api/logs` receives sanitized logs. Requires `x-erp-debug-secret`.
- `GET /api/logs?status=all|success|failed` returns stored logs. Requires dashboard auth.
- `DELETE /api/logs` clears the log buffer. Requires dashboard auth.

## Log Storage

Logs live in Redis, keyed per developer session (`DEBUG_CENTER_REDIS_KEY:<sessionId>`) with a
24-hour TTL. Three backends are picked in this order:

1. **Self-hosted Redis** — used whenever `REDIS_URL` or `REDIS_HOST` is set. Spoken over the
   normal Redis protocol (`ioredis`), so there is no per-command quota.
2. **Vercel KV / Upstash** — the HTTP REST client, used only when no self-hosted Redis is
   configured. Its free tier caps monthly commands, which this app can exhaust.
3. **In-memory** — the fallback with nothing configured. Per-process only, so it is suitable for
   local development, not for a multi-instance deploy.

If a configured Redis is unreachable, the app does **not** fail the request: it degrades to the
in-memory store, retries the connection every 30 seconds, and switches back on its own once Redis
answers. So `npm run dev` works on a machine with no Redis installed, even with `REDIS_URL` set in
`.env`. The two buffers are separate — logs written while degraded do not appear after recovery.

Only connection failures degrade this way. A real Redis error — bad password, out of memory, an
exhausted managed quota — still returns 503 with the reason, because those need fixing.

The active backend is shown in the dashboard header: `redis`, `in-memory`, or
`in-memory (redis unreachable)`.

## Deploy On Your Own Server (self-hosted Redis)

```bash
ERP_API_DEBUG_SHARED_SECRET=use-a-long-random-shared-secret
DEBUG_CENTER_DASHBOARD_USER=qa
DEBUG_CENTER_DASHBOARD_PASSWORD=use-a-long-random-dashboard-password
DEBUG_CENTER_MAX_LOGS=300
DEBUG_CENTER_REDIS_KEY=erp-api-debug-center:logs

REDIS_URL=redis://127.0.0.1:6379
```

Instead of a URL, the parts can be given separately — they apply only when `REDIS_URL` is unset:

```bash
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=          # blank means the server has no auth
REDIS_USERNAME=          # optional, for Redis 6+ ACL users
REDIS_DB=0               # optional, defaults to 0
```

Use `rediss://` in `REDIS_URL` for a TLS-terminated Redis. Then:

```bash
npm ci
npm run build
npm start                # sets NODE_ENV=production for you
```

`127.0.0.1` only works when the app and Redis run on the same host. A serverless deploy
(Vercel) cannot reach it — that needs a network-reachable Redis or the managed option below.

## Deploy On Vercel (managed Redis)

Set the same `ERP_API_DEBUG_*` / `DEBUG_CENTER_*` variables, plus either:

```bash
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
```

or:

```bash
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

When the free-tier command budget runs out, the dashboard reports a 503 naming the exhausted
quota; moving to a self-hosted Redis is the way out.

Dashboard pages and `GET`/`DELETE /api/logs` are protected with HTTP Basic Auth. The ERP log ingest
endpoint still uses the separate `x-erp-debug-secret` header.
