# Zimple

Zimple converts websites into Kiwix-compatible `.zim` archives using OpenZIM `zimit`.

The project now supports two runtime modes:

- **Desktop mode**: Tauri + Rust backend (macOS/Windows/Linux)
- **Web mode**: Fastify HTTP API + React UI, runnable in Docker on `127.0.0.1`

## Architecture

### Desktop mode (existing path)

- React + TypeScript frontend (`src/`)
- Rust/Tauri command backend (`src-tauri/`)
- Docker `ghcr.io/openzim/zimit` execution from Rust runtime

### Web mode (new path)

- React + TypeScript frontend (`src/`)
- Node/Fastify API service (`web-api/src/`)
- Docker `ghcr.io/openzim/zimit` execution from Node runtime
- Single worker + FIFO queue + retries/backoff + cancellation
- Container binds internally to `0.0.0.0`; compose publishes localhost-only (`127.0.0.1`) by default

## Core behavior and policy

- Public `http://` and `https://` URLs only
- Queue with one active job at a time
- Job states: `queued`, `running`, `succeeded`, `failed`, `cancelled`
- Output defaults:
  - Desktop mode: user `Downloads` folder
  - Web mode (Docker compose): `/Users/thomas/Repos/zimple/bind`
- Default crawl limits:
  - Max pages: `2000`
  - Max depth: `5`
  - Max total size: `2048 MB`
  - Max asset size: `50 MB`
  - Timeout: `120 minutes`
  - Retries: `3`
- No telemetry; logs remain local

## Prerequisites

- Node.js `22+`
- npm `11+`
- Rust stable toolchain (desktop mode)
- Docker Desktop / Docker Engine

## Local development

Install dependencies:

```bash
npm install
```

### Desktop mode

```bash
npm run dev:tauri
```

### Frontend-only (mock backend)

```bash
npm run dev
```

### Web API (local, non-Docker)

In one terminal:

```bash
npm run dev:web:api
```

In another terminal, run the frontend against the HTTP backend:

```bash
VITE_ZIMPLE_BACKEND=http \
VITE_ZIMPLE_API_BASE_URL=http://127.0.0.1:8080 \
npm run dev
```

## Run as a local web app via Docker

1. By default, `.zim` files are written to the project bind folder:

```bash
/Users/thomas/Repos/zimple/bind
```

The per-job "Override Output Directory" field is optional. If left blank, Zimple uses the configured default output directory for the active runtime mode.

2. Optionally define environment variables in your shell or `.env` (for a different host folder):

```bash
cp .env.example .env
```

3. Launch:

```bash
npm run docker:web:up
```

4. Open:

```text
http://127.0.0.1:8080
```

5. Stop:

```bash
npm run docker:web:down
```

### Why absolute output paths are required in web mode

The API container invokes `docker run` via the host Docker socket. The output directory must exist on the host and be mounted into the API container at the **same absolute path** so child zimit containers can write `.zim` files correctly.

## Environment contracts

### Frontend env

- `VITE_ZIMPLE_BACKEND`: `tauri` | `http` | `mock`
- `VITE_ZIMPLE_API_BASE_URL`: base URL for web API (for example `http://127.0.0.1:8080`)

### Web API env

- `ZIMPLE_OUTPUT_DIR`: absolute host path for `.zim` output (default `/Users/thomas/Repos/zimple/bind`)
- `ZIMPLE_DOCKER_SOCKET`: Docker socket path (default `/var/run/docker.sock`)
- `ZIMPLE_BIND_ADDRESS`: API bind address inside container/process (default `0.0.0.0` for Docker web mode)
- `ZIMPLE_PORT`: API/UI port (default `8080`)
- `ZIMPLE_DATA_DIR`: settings persistence directory (default `/data`)
- `ZIMPLE_ZIMIT_IMAGE`: zimit image (default `ghcr.io/openzim/zimit`)

## HTTP API (web mode)

- `POST /api/jobs`
- `GET /api/jobs`
- `GET /api/jobs/:jobId`
- `POST /api/jobs/:jobId/cancel`
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
cargo test --manifest-path src-tauri/Cargo.toml
```

## Troubleshooting

- **`Docker is installed but the daemon is not reachable`**
  - Start Docker Desktop/Engine and retry.
- **`zimit container failed with exit code 2`**
  - Usually invalid zimit args or output naming collision; check job error details.
- **Web mode job cannot write output**
  - Confirm `ZIMPLE_OUTPUT_DIR` is absolute, exists on host, and is mounted with the same path in `docker-compose.web.yml`.
- **UI opens but API calls fail**
  - Check container health and logs:
    ```bash
    docker compose -f docker-compose.web.yml ps
    docker compose -f docker-compose.web.yml logs -f zimple-web
    ```

## Security notes for web mode

- Default exposure is localhost-only (`127.0.0.1`).
- No auth layer is included in v1 web mode.
- Do not expose this service to untrusted networks without adding authentication and network controls.
