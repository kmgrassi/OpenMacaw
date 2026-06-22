#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.run-logs"
LAUNCHER_PORT="${LAUNCHER_PORT:-4100}"
LAUNCHER_START_PORT="${LAUNCHER_START_PORT:-4001}"
ORCHESTRATOR_PORT="${ORCHESTRATOR_PORT:-4000}"
WORKFLOW_PATH="${WORKFLOW_PATH:-./WORKFLOW.local-e2e.md}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-${OPENMACAW_HEALTH_TIMEOUT:-60}}"
MODE="foreground"

LAUNCHER_SESSION="${LAUNCHER_SESSION:-par-runtime-launcher}"
ORCHESTRATOR_SESSION="${ORCHESTRATOR_SESSION:-par-runtime-orchestrator}"
HELPER_SESSION="${HELPER_SESSION:-local-runtime-helper}"
LOCAL_RUNTIME_HELPER_DIR="${LOCAL_RUNTIME_HELPER_DIR:-$ROOT_DIR/../local-runtime-helper}"
LOCAL_RUNTIME_HELPER_CONFIG="${LOCAL_RUNTIME_HELPER_CONFIG:-./dev-runtime.toml}"
START_HELPER="${START_HELPER:-0}"

while [ "${1:-}" = "--" ]; do
  shift
done

case "${1:-}" in
  --detached)
    MODE="detached"
    shift
    ;;
  --status)
    MODE="status"
    shift
    ;;
  --stop)
    MODE="stop"
    shift
    ;;
  --restart)
    MODE="restart"
    shift
    ;;
  --help|-h)
    cat <<EOF
usage: $0 [--detached|--status|--stop|--restart]

Default mode starts launcher and orchestrator in the foreground and stops
processes started by this wrapper on Ctrl+C.

Detached mode uses named screen sessions so the stack stays up after the
terminal exits. For local-relay workflows, set START_HELPER=1 to also start
the sibling local-runtime-helper daemon.
EOF
    exit 0
    ;;
esac

# shellcheck source=./local-env.sh
. "$ROOT_DIR/scripts/local-env.sh"
load_local_env "$ROOT_DIR"

mkdir -p "$LOG_DIR"

LAUNCHER_PID=""
ORCHESTRATOR_PID=""
CLEANUP_DONE=0

cleanup() {
  if [ "$CLEANUP_DONE" -eq 1 ]; then
    return
  fi
  CLEANUP_DONE=1

  if [ -z "$ORCHESTRATOR_PID" ] && [ -z "$LAUNCHER_PID" ]; then
    return
  fi

  printf '\nStopping local runtime processes...\n'
  for pid in "$ORCHESTRATOR_PID" "$LAUNCHER_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait "$ORCHESTRATOR_PID" "$LAUNCHER_PID" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

project_listener_pids() {
  local port="$1"
  local pattern="$2"
  local pid
  local command_line
  local cwd_path

  for pid in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true); do
    cwd_path="$(lsof -p "$pid" -a -d cwd -Fn 2>/dev/null | awk '/^n/ { print substr($0, 2); exit }' || true)"
    case "$cwd_path" in
      "$ROOT_DIR"|"$ROOT_DIR"/*)
        printf '%s\n' "$pid"
        continue
        ;;
    esac

    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$command_line" in
      *"$pattern"*) printf '%s\n' "$pid" ;;
    esac
  done
}

is_project_listener() {
  [ -n "$(project_listener_pids "$1" "$2")" ]
}

process_env_value() {
  local pid="$1"
  local key="$2"

  ps eww -p "$pid" -o command= 2>/dev/null \
    | tr ' ' '\n' \
    | awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }'
}

listener_env_matches_current_env() {
  local pid="$1"
  local expected_url="${SUPABASE_URL:-}"
  local expected_key="${SUPABASE_SERVICE_ROLE_KEY:-}"
  local actual_url
  local actual_key

  if [ -n "$expected_url" ]; then
    actual_url="$(process_env_value "$pid" SUPABASE_URL)"
    [ "$actual_url" = "$expected_url" ] || return 1
  fi

  if [ -n "$expected_key" ]; then
    actual_key="$(process_env_value "$pid" SUPABASE_SERVICE_ROLE_KEY)"
    [ "$actual_key" = "$expected_key" ] || return 1
  fi

  return 0
}

restart_stale_project_listener() {
  local port="$1"
  local service="$2"
  local expected_pattern="$3"
  local pid
  local stale_pids=""
  local timeout_seconds=10
  local elapsed=0

  for pid in $(project_listener_pids "$port" "$expected_pattern"); do
    if listener_env_matches_current_env "$pid"; then
      continue
    fi
    stale_pids="${stale_pids} ${pid}"
  done

  if [ -z "$stale_pids" ]; then
    return 1
  fi

  echo "[local-runtime] restarting stale ${service} listener on port ${port}; loaded env changed"
  for pid in $stale_pids; do
    kill "$pid" 2>/dev/null || true
  done

  while lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && [ "$elapsed" -lt "$timeout_seconds" ]; do
    sleep 1
    elapsed=$((elapsed + 1))
  done

  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[local-runtime] cannot restart ${service}: stale listener did not release port ${port}" >&2
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
    exit 1
  fi

  return 0
}

require_port_available() {
  local port="$1"
  local service="$2"
  local expected_pattern="$3"

  if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    return 0
  fi

  if is_project_listener "$port" "$expected_pattern"; then
    if restart_stale_project_listener "$port" "$service" "$expected_pattern"; then
      return 0
    fi
    echo "[local-runtime] reusing existing ${service} listener on port ${port}"
    return 0
  fi

  echo "[local-runtime] cannot start ${service}: port ${port} is already in use by another process" >&2
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
  exit 1
}

wait_for_health() {
  local name="$1"
  local url="$2"
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))

  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[local-runtime] ${name} is healthy: ${url}"
      return 0
    fi
    sleep 1
  done

  echo "[local-runtime] timed out waiting for ${name}: ${url}" >&2
  return 1
}

require_screen() {
  if ! command -v screen >/dev/null 2>&1; then
    echo "[local-runtime] screen is required for detached mode" >&2
    exit 127
  fi
}

session_exists() {
  local session="$1"
  (screen -ls 2>/dev/null || true) | grep -Eq "[[:space:]][0-9]+\\.${session}[[:space:]]"
}

start_screen_session() {
  local session="$1"
  local command="$2"

  if session_exists "$session"; then
    echo "[local-runtime] ${session} already running"
    return
  fi

  screen -dmS "$session" zsh -lc "$command"
  echo "[local-runtime] started ${session}"
}

stop_screen_session() {
  local session="$1"

  if session_exists "$session"; then
    screen -S "$session" -X quit || true
    echo "[local-runtime] stopped ${session}"
  else
    echo "[local-runtime] ${session} not running"
  fi
}

status_screen_sessions() {
  require_screen
  screen -ls || true
  echo
  wait_for_health "launcher" "http://127.0.0.1:${LAUNCHER_PORT}/health" || true
  wait_for_health "orchestrator" "http://127.0.0.1:${ORCHESTRATOR_PORT}/api/v1/health" || true
}

stop_screen_sessions() {
  stop_screen_session "$HELPER_SESSION"
  stop_screen_session "$ORCHESTRATOR_SESSION"
  stop_screen_session "$LAUNCHER_SESSION"
}

start_detached() {
  require_screen
  mkdir -p "$LOG_DIR"

  start_screen_session "$LAUNCHER_SESSION" \
    "cd '$ROOT_DIR' && exec env WORKFLOW_PATH='$WORKFLOW_PATH' LAUNCHER_START_PORT='$LAUNCHER_START_PORT' pnpm run start:launcher --port '$LAUNCHER_PORT' > '$LOG_DIR/launcher-screen.log' 2>&1"

  start_screen_session "$ORCHESTRATOR_SESSION" \
    "cd '$ROOT_DIR' && exec env WORKFLOW_PATH='$WORKFLOW_PATH' ORCHESTRATOR_PORT='$ORCHESTRATOR_PORT' pnpm run start:orchestrator --port '$ORCHESTRATOR_PORT' > '$LOG_DIR/orchestrator-screen.log' 2>&1"

  if [ "$START_HELPER" = "1" ]; then
    if [ ! -d "$LOCAL_RUNTIME_HELPER_DIR" ]; then
      echo "[local-runtime] helper repo not found: $LOCAL_RUNTIME_HELPER_DIR" >&2
      echo "[local-runtime] set LOCAL_RUNTIME_HELPER_DIR or START_HELPER=0" >&2
      exit 1
    fi

    start_screen_session "$HELPER_SESSION" \
      "cd '$LOCAL_RUNTIME_HELPER_DIR' && exec go run ./cmd/local-runtime-helper start --config '$LOCAL_RUNTIME_HELPER_CONFIG' --log-level debug > '$LOG_DIR/local-runtime-helper-screen.log' 2>&1"
  fi

  echo "[local-runtime] detached runtime sessions requested"
  echo "  Launcher:     http://127.0.0.1:${LAUNCHER_PORT}"
  echo "  Orchestrator: http://127.0.0.1:${ORCHESTRATOR_PORT}"
  echo "  Logs:"
  echo "    $LOG_DIR/launcher-screen.log"
  echo "    $LOG_DIR/orchestrator-screen.log"
  if [ "$START_HELPER" = "1" ]; then
    echo "    $LOG_DIR/local-runtime-helper-screen.log"
  fi
}

start_launcher() {
  if curl -fsS "http://127.0.0.1:${LAUNCHER_PORT}/health" >/dev/null 2>&1; then
    echo "[local-runtime] launcher already healthy on port ${LAUNCHER_PORT}"
    return 0
  fi

  echo "[local-runtime] starting launcher on port ${LAUNCHER_PORT}"
  (
    cd "$ROOT_DIR"
    WORKFLOW_PATH="$WORKFLOW_PATH" LAUNCHER_PORT="$LAUNCHER_PORT" LAUNCHER_START_PORT="$LAUNCHER_START_PORT" pnpm run start:launcher --port "$LAUNCHER_PORT"
  ) >"$LOG_DIR/launcher.log" 2>&1 &
  LAUNCHER_PID=$!
}

start_orchestrator() {
  if curl -fsS "http://127.0.0.1:${ORCHESTRATOR_PORT}/api/v1/health" >/dev/null 2>&1; then
    echo "[local-runtime] orchestrator already healthy on port ${ORCHESTRATOR_PORT}"
    return 0
  fi

  echo "[local-runtime] starting orchestrator on port ${ORCHESTRATOR_PORT} with ${WORKFLOW_PATH}"
  (
    cd "$ROOT_DIR"
    WORKFLOW_PATH="$WORKFLOW_PATH" ORCHESTRATOR_PORT="$ORCHESTRATOR_PORT" pnpm run start:orchestrator --port "$ORCHESTRATOR_PORT"
  ) >"$LOG_DIR/orchestrator.log" 2>&1 &
  ORCHESTRATOR_PID=$!
}

case "$MODE" in
  status)
    status_screen_sessions
    exit 0
    ;;
  stop)
    stop_screen_sessions
    exit 0
    ;;
esac

require_port_available "$LAUNCHER_PORT" "launcher" "mix launcher.start"
require_port_available "$ORCHESTRATOR_PORT" "orchestrator" "bin/symphony"

case "$MODE" in
  detached)
    start_detached
    exit 0
    ;;
  restart)
    stop_screen_sessions
    start_detached
    exit 0
    ;;
esac

start_launcher
wait_for_health "launcher" "http://127.0.0.1:${LAUNCHER_PORT}/health"

start_orchestrator
wait_for_health "orchestrator" "http://127.0.0.1:${ORCHESTRATOR_PORT}/api/v1/health"

cat <<EOF
[local-runtime] runtime is ready
  Launcher:     http://127.0.0.1:${LAUNCHER_PORT}
  Orchestrator: http://127.0.0.1:${ORCHESTRATOR_PORT}
  Logs:
    $LOG_DIR/launcher.log
    $LOG_DIR/orchestrator.log

Press Ctrl+C to stop processes started by this wrapper.
EOF

while true; do
  if [ -n "$LAUNCHER_PID" ] && ! kill -0 "$LAUNCHER_PID" 2>/dev/null; then
    echo "[local-runtime] launcher process exited" >&2
    exit 1
  fi
  if [ -n "$ORCHESTRATOR_PID" ] && ! kill -0 "$ORCHESTRATOR_PID" 2>/dev/null; then
    echo "[local-runtime] orchestrator process exited" >&2
    exit 1
  fi
  sleep 1
done
