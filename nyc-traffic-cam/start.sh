#!/usr/bin/env bash
# Start the NYC Traffic Cam Monitor (backend + frontend) with one command.
# Re-runs are idempotent: deps install only when missing, ports are reused.
set -euo pipefail

cd "$(dirname "$0")"

VENV_DIR=".venv"
BACKEND_PORT=8000
FRONTEND_PORT=5173

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }

# --- python venv + deps ---
if [[ ! -d "$VENV_DIR" ]]; then
  bold "Creating Python venv"
  python3 -m venv "$VENV_DIR"
fi
if ! "$VENV_DIR/bin/python" -c "import fastapi, httpx, aiosqlite, PIL, numpy" 2>/dev/null; then
  bold "Installing Python deps"
  "$VENV_DIR/bin/pip" install --quiet -r server/requirements.txt
fi
ok "Python deps ready"

# --- node deps ---
if [[ ! -d node_modules ]]; then
  bold "Installing JS deps"
  npm install
fi
ok "Node deps ready"

# --- stop anything already on our ports ---
for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if lsof -ti tcp:"$port" >/dev/null 2>&1; then
    warn "Killing previous process on port $port"
    lsof -ti tcp:"$port" | xargs kill -9 2>/dev/null || true
  fi
done

# --- start backend ---
bold "Starting backend (FastAPI + ingestor) on :$BACKEND_PORT"
"$VENV_DIR/bin/uvicorn" server.main:app \
  --host 127.0.0.1 --port "$BACKEND_PORT" --log-level warning \
  > .backend.log 2>&1 &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT INT TERM

# --- wait for backend to answer /api/health ---
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null 2>&1; then
    ok "Backend is up"
    break
  fi
  sleep 0.5
done

# --- start frontend in foreground ---
bold "Starting Vite on :$FRONTEND_PORT — open http://localhost:$FRONTEND_PORT/"
echo "(backend logs streaming to .backend.log)"
echo
npm run dev
