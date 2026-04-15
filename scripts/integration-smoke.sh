#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$ROOT_DIR/scripts/fixtures/site"
OUTPUT_DIR="${TMPDIR:-/tmp}/zimple-integration-output"
PORT="${ZIMPLE_FIXTURE_PORT:-8787}"

mkdir -p "$OUTPUT_DIR"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

python3 -m http.server "$PORT" --directory "$FIXTURE_DIR" >/dev/null 2>&1 &
SERVER_PID=$!

sleep 1

echo "Running Dockerized zimit smoke test against fixture on port $PORT"
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -v "$OUTPUT_DIR:/output" \
  ghcr.io/openzim/zimit \
  --url "http://host.docker.internal:${PORT}/" \
  --name "zimple-fixture" \
  --output "/output/zimple-fixture.zim"

if [[ ! -f "$OUTPUT_DIR/zimple-fixture.zim" ]]; then
  echo "Expected ZIM output was not generated" >&2
  exit 1
fi

echo "Integration smoke test passed: $OUTPUT_DIR/zimple-fixture.zim"
