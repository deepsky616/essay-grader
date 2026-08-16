#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_PORT="${ESSAY_GRADER_PORT:-8000}"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm을 찾지 못했습니다. Node.js를 먼저 설치하세요." >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "uv를 찾지 못했습니다. uv를 먼저 설치하세요." >&2
  exit 1
fi

if [[ ! "$APP_PORT" =~ ^[0-9]+$ ]] || (( APP_PORT < 1 || APP_PORT > 65535 )); then
  echo "ESSAY_GRADER_PORT는 1부터 65535 사이의 정수여야 합니다." >&2
  exit 1
fi

cd "$SCRIPT_DIR/frontend"
if [[ ! -d node_modules ]]; then
  npm ci
fi
npm run build

cd "$SCRIPT_DIR/backend"
uv sync --extra dev

echo "논술형 자동채점을 http://127.0.0.1:${APP_PORT} 에서 시작합니다."
exec uv run uvicorn app.main:app --host 127.0.0.1 --port "$APP_PORT"
