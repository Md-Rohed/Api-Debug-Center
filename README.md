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

## Deploy On Vercel

Set these environment variables in the Vercel project:

```bash
ERP_API_DEBUG_SHARED_SECRET=use-a-long-random-shared-secret
DEBUG_CENTER_DASHBOARD_USER=qa
DEBUG_CENTER_DASHBOARD_PASSWORD=use-a-long-random-dashboard-password
DEBUG_CENTER_MAX_LOGS=300
DEBUG_CENTER_REDIS_KEY=erp-api-debug-center:logs
```

Add Redis storage using either Vercel KV or Upstash Redis:

```bash
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
```

or:

```bash
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

When Redis env vars are present, logs are shared across Vercel serverless instances. Without Redis,
the app falls back to in-memory storage, which is only suitable for local development.

Dashboard pages and `GET`/`DELETE /api/logs` are protected with HTTP Basic Auth. The ERP log ingest
endpoint still uses the separate `x-erp-debug-secret` header.
