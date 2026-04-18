# Zimple

Zimple converts websites into Kiwix-compatible `.zim` archives using OpenZIM `zimit`.

This repository is now **web-only**:

- React + TypeScript frontend (`src/`)
- Node/Fastify API (`web-api/src/`)
- Dockerized runtime using `ghcr.io/openzim/zimit`

## Core behavior

- Public `http://` and `https://` URLs only
- Queue with one active job at a time
- Job states: `queued`, `running`, `paused`, `succeeded`, `failed`, `cancelled`
- Clear Queue removes `succeeded`, `failed`, and `cancelled` jobs, while keeping active jobs
  (`queued`, `running`, `paused`)
- Crawl progress UI separates job completion percent from crawl success ratio (`processed / total`)
- Default crawl limits:
  - Workers: `4`
  - Max pages: `1500`
  - Max depth: `5`
  - Max total size: `4096 MB`
  - Max asset size: `50 MB`
  - Timeout: `180 minutes`
  - Retries: `2`
- No telemetry; logs stay local

## Prerequisites

- Node.js `22+`
- npm `11+`
- Docker Desktop / Docker Engine

## Run locally with Docker (recommended)

1. Copy env template:

```bash
cp .env.example .env
```

2. Set output folder in `.env` (`ZIMPLE_OUTPUT_DIR`) to an absolute host path.
   For LAN/reverse-proxy access (for example Nginx Proxy Manager), set
   `ZIMPLE_PUBLISH_HOST=0.0.0.0`.

3. Start:

```bash
npm run docker:web:up
```

Equivalent direct command (run from repo root):

```bash
docker compose -f docker-compose.web.yml --env-file .env up --build
```

4. Open:

```text
http://127.0.0.1:8000
```

5. Stop:

```bash
npm run docker:web:down
```

Equivalent direct command:

```bash
docker compose -f docker-compose.web.yml --env-file .env down
```

## Local development (without docker-compose)

In one terminal:

```bash
npm run dev:web:api
```

In another terminal:

```bash
VITE_ZIMPLE_API_BASE_URL=http://127.0.0.1:8000 npm run dev
```

Optional frontend-only mock mode:

```bash
VITE_ZIMPLE_BACKEND=mock npm run dev
```

## Crawl scope patterns

Capture Settings supports crawl scope filtering with regex patterns:

- `Include Patterns (one per line)` for URLs you want to allow
- `Exclude Patterns (one per line)` for URLs you want to block

Examples:

```text
Include
^https?://example\.com/docs/.*
^https?://example\.com/blog/(guides|tutorials)/.*
```

```text
Exclude
^https?://example\.com/(admin|login)
[?&](utm_|sessionId=)
```

Pattern syntax reference:
[Browsertrix Crawler scope docs](https://crawler.docs.browsertrix.com/user-guide/crawl-scope/)

## Output folder binding (Linux/macOS)

When running with `docker-compose.web.yml`, set `ZIMPLE_OUTPUT_DIR` to the absolute host folder you want. The compose file mounts that same path into the container so nested `docker run` calls can write outputs correctly.

Example:

```env
ZIMPLE_OUTPUT_DIR=/home/you/zim-output
```

## Environment contracts

### Frontend env

- `VITE_ZIMPLE_API_BASE_URL`: API base URL (example: `http://127.0.0.1:8000`)
- `VITE_ZIMPLE_BACKEND`: optional `mock` override for UI-only development

### Web API env

- `ZIMPLE_OUTPUT_DIR`: absolute host path for `.zim` output
- `ZIMPLE_DOCKER_SOCKET`: Docker socket path (default `/var/run/docker.sock`)
- `ZIMPLE_BIND_ADDRESS`: API bind address (default `0.0.0.0` in compose)
- `ZIMPLE_PORT`: API/UI port (default `8000`)
- `ZIMPLE_PUBLISH_HOST`: host interface for published port
  - `127.0.0.1` for local-only access
  - `0.0.0.0` for LAN/reverse-proxy access
- `ZIMPLE_DATA_DIR`: settings persistence directory (default `/data` in compose)
- `ZIMPLE_ZIMIT_IMAGE`: zimit image (default `ghcr.io/openzim/zimit`)

## HTTP API

- `POST /api/jobs`
- `GET /api/jobs`
- `GET /api/jobs/:jobId`
- `GET /api/jobs/:jobId/progress?after=<cursor>&limit=<n>`
- `POST /api/jobs/:jobId/cancel`
- `POST /api/jobs/:jobId/pause`
- `POST /api/jobs/:jobId/resume`
- `POST /api/jobs/clear-terminal`
- `GET /api/jobs/:jobId/output`
- `GET /api/runtime-health`
- `GET /api/settings`
- `PUT /api/settings`

## Quality checks

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run build:web:api
```

## Troubleshooting

- **`failed to fetch` in UI**
  - Ensure the API is reachable at `VITE_ZIMPLE_API_BASE_URL`.
  - In docker-compose mode, confirm `zimple-web` is healthy and running.
- **`no configuration file provided: not found` when running `docker compose`**
  - This repo uses `docker-compose.web.yml` (not `docker-compose.yml`).
  - Run from the repository root, or provide an absolute compose file path.
  - Use:
    - `docker compose -f docker-compose.web.yml --env-file .env up --build`
- **`502 Bad Gateway (openresty)` from Nginx Proxy Manager**
  - If upstream is `192.168.x.x:8000`, ensure Zimple publishes on LAN:
    - Set `ZIMPLE_PUBLISH_HOST=0.0.0.0` in `.env`
    - Restart:
      - `docker compose -f docker-compose.web.yml --env-file .env up -d --build`
  - Verify on server:
    - `curl -I http://127.0.0.1:8000/api/runtime-health`
    - `curl -I http://<server-lan-ip>:8000/api/runtime-health`
- **`zimit container failed with exit code 3`**
  - Output filesystem utilization is too high for browsertrix/zimit safety checks.
  - Free space on the mounted output volume or move `ZIMPLE_OUTPUT_DIR` to a less utilized disk.
- **Web mode job cannot write output**
  - Confirm `ZIMPLE_OUTPUT_DIR` is absolute, exists on host, and is mounted with the same absolute path in compose.
