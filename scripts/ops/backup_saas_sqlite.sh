#!/usr/bin/env bash
set -euo pipefail

# Purpose: Online-consistent backup for CodeSprite SaaS SQLite DB (users/subscription/ledger/orders).
# - Runs INSIDE the `codesprite-api-saas` container to use its SQLite fallback DB (new enough for VACUUM INTO).
# - Writes backup files into the data volume so they persist on the host.
# - Optional: upload backups to OSS via aliyun CLI profiles.
#
# Non-interactive. Safe to run repeatedly. Uses flock to avoid concurrent runs.
#
# Required:
#   docker (host) + running container
#
# Env:
#   CONTAINER=codesprite-api-saas
#   BACKUP_DIR_HOST=/srv/www/codesprite/data/backup
#   BACKUP_DIR_CONTAINER=/data/backup
#   RETENTION_DAYS=14
#
# Optional OSS:
#   ALIYUN_PROFILE=<aliyun-cli-profile>
#   OSS_BUCKET=<bucket-name>
#   OSS_PREFIX=codesprite/sqlite
#
# Examples:
#   ./scripts/ops/backup_saas_sqlite.sh
#   ALIYUN_PROFILE=readonly OSS_BUCKET=my-bucket OSS_PREFIX=codesprite/sqlite ./scripts/ops/backup_saas_sqlite.sh

CONTAINER="${CONTAINER:-codesprite-api-saas}"
BACKUP_DIR_HOST="${BACKUP_DIR_HOST:-/srv/www/codesprite/data/backup}"
BACKUP_DIR_CONTAINER="${BACKUP_DIR_CONTAINER:-/data/backup}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

ALIYUN_PROFILE="${ALIYUN_PROFILE:-}"
OSS_BUCKET="${OSS_BUCKET:-}"
OSS_PREFIX="${OSS_PREFIX:-codesprite/sqlite}"

LOCK_FILE="/var/lock/codesprite-sqlite-backup.lock"

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "[skip] another backup is running"; exit 0; }

echo "[info] container=$CONTAINER"
echo "[info] backup_dir_host=$BACKUP_DIR_HOST"
echo "[info] retention_days=$RETENTION_DAYS"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "[error] container not running: $CONTAINER" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR_HOST"

DB_PATH="$(timeout 20s docker exec "$CONTAINER" sh -lc 'echo "${DB_PATH:-}"' | tr -d '\r')"
if [[ -z "$DB_PATH" ]]; then
  echo "[error] DB_PATH is empty in container env; cannot continue" >&2
  exit 1
fi

ts="$(date +%Y%m%d%H%M%S)"
base="codesprite.db.${ts}"
out_in_container="${BACKUP_DIR_CONTAINER}/${base}"

echo "[info] DB_PATH=$DB_PATH"
echo "[info] out_in_container=$out_in_container"

timeout 30s docker exec -i -e "OUT_FILE=$out_in_container" "$CONTAINER" python - <<'PY'
import os, sqlite3
db = os.environ.get("DB_PATH")
out = os.environ["OUT_FILE"]
os.makedirs(os.path.dirname(out), exist_ok=True)
conn = sqlite3.connect(db)
conn.execute(f"VACUUM INTO '{out}'")
print("ok backup_written=", out)
PY

out_on_host="${BACKUP_DIR_HOST}/${base}"
if [[ ! -f "$out_on_host" ]]; then
  echo "[error] backup not found on host: $out_on_host" >&2
  echo "[hint] check volume mount: $BACKUP_DIR_HOST <-> $BACKUP_DIR_CONTAINER" >&2
  exit 1
fi

sha="$(sha256sum "$out_on_host" | awk '{print $1}')"
echo "$sha  $(basename "$out_on_host")" > "${out_on_host}.sha256"
gzip -f "${out_on_host}.sha256" >/dev/null

echo "[ok] backup=$out_on_host (sha256=$sha)"

# Retention
if [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  find "$BACKUP_DIR_HOST" -maxdepth 1 -type f -name "codesprite.db.*" -mtime "+$RETENTION_DAYS" -print -delete || true
  find "$BACKUP_DIR_HOST" -maxdepth 1 -type f -name "codesprite.db.*.sha256.gz" -mtime "+$RETENTION_DAYS" -print -delete || true
else
  echo "[warn] RETENTION_DAYS not a number, skipping retention: $RETENTION_DAYS" >&2
fi

# Optional OSS upload (backup + sha256.gz)
if [[ -n "$OSS_BUCKET" && -n "$ALIYUN_PROFILE" ]]; then
  if ! command -v aliyun >/dev/null; then
    echo "[warn] aliyun CLI not found; skipping OSS upload" >&2
    exit 0
  fi
  obj_prefix="${OSS_PREFIX%/}"
  obj1="oss://${OSS_BUCKET}/${obj_prefix}/$(basename "$out_on_host")"
  obj2="oss://${OSS_BUCKET}/${obj_prefix}/$(basename "$out_on_host").sha256.gz"
  echo "[info] uploading to OSS (profile=$ALIYUN_PROFILE) ..."
  timeout 60s aliyun oss cp --profile "$ALIYUN_PROFILE" "$out_on_host" "$obj1" --force
  timeout 60s aliyun oss cp --profile "$ALIYUN_PROFILE" "${out_on_host}.sha256.gz" "$obj2" --force
  echo "[ok] oss_uploaded:"
  echo "  $obj1"
  echo "  $obj2"
fi

