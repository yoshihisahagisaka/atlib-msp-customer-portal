#!/usr/bin/env bash
# Secure Guard verification VM preflight only. No installs, DB writes, auth or GCP mutations.
set -Eeuo pipefail
umask 077

EXPECTED_HOME="/home/yoshihisa_hagisaka_atlib_jp"
EXPECTED_HOST="atlib-test-runner"
if [[ "$HOME" != "$EXPECTED_HOME" ]]; then
  echo "STOP: OS Login HOME differs from approved verification VM home" >&2
  exit 1
fi
if [[ "$(id -u)" == "0" ]]; then
  echo "STOP: do not run the verification preflight as root" >&2
  exit 1
fi
HOST="$(hostname -s)"
if [[ "$HOST" != "$EXPECTED_HOST" ]]; then
  echo "STOP: unexpected VM hostname ($HOST)" >&2
  exit 1
fi
source /etc/os-release
if [[ "$ID" != "ubuntu" || "$VERSION_ID" != "24.04" ]]; then
  echo "STOP: expected Ubuntu 24.04, got ${ID} ${VERSION_ID}" >&2
  exit 1
fi

PROJECT_ROOT="$HOME/projects/secure-guard"
if [[ -L "$HOME/projects" || -L "$PROJECT_ROOT" ]]; then
  echo "STOP: project directory must not be a symlink" >&2
  exit 1
fi
mkdir -p "$PROJECT_ROOT"/{evidence,tmp}
chmod 700 "$PROJECT_ROOT" "$PROJECT_ROOT/evidence" "$PROJECT_ROOT/tmp"
echo "=== Secure Guard verification VM preflight ==="
echo "host=$HOST"
echo "user=$(id -un)"
echo "home=$HOME"
echo "project_root=$PROJECT_ROOT"
echo "os=${PRETTY_NAME}"
echo "cpu_count=$(nproc)"
free -h
df -h "$PROJECT_ROOT"
echo "=== Local tool readiness; no auto-install ==="
for binary in git node npm docker psql pg_config; do
  if command -v "$binary" >/dev/null 2>&1; then
    case "$binary" in
      git) git --version ;;
      node) node --version ;;
      npm) npm --version ;;
      docker) docker --version ;;
      psql) psql --version ;;
      pg_config) pg_config --version ;;
    esac
  else
    echo "MISSING: $binary"
  fi
done
if command -v docker >/dev/null 2>&1; then
  if docker info --format 'docker daemon access: {{.ServerVersion}}' >/dev/null 2>&1; then
    echo "DOCKER_ACCESS=PASS"
  else
    echo "DOCKER_ACCESS=STOP (do not use sudo or auto-install)"
  fi
fi
if command -v ss >/dev/null 2>&1; then
  echo "=== Existing local PostgreSQL test port 55432 (read only) ==="
  ss -ltn '( sport = :55432 )' || true
fi
echo "=== Preflight complete. No repo cloned and no tests executed. ==="
