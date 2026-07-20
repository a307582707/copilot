#!/usr/bin/env bash
set -euo pipefail

# Purpose: Install an idempotent cron job for SaaS SQLite backups.
# - Writes /etc/cron.d/codesprite-sqlite-backup
# - Logs to /var/log/codesprite/sqlite-backup.log
#
# Env:
#   CRON_SCHEDULE="17 3 * * *"   # default: daily 03:17
#   SCRIPT_PATH=/path/to/copilot/scripts/ops/backup_saas_sqlite.sh
#   USER=root
#
# Optional pass-through to backup script:
#   CONTAINER, BACKUP_DIR_HOST, BACKUP_DIR_CONTAINER, RETENTION_DAYS,
#   ALIYUN_PROFILE, OSS_BUCKET, OSS_PREFIX
#
# Usage:
#   ./scripts/ops/install_saas_sqlite_backup_cron.sh

CRON_SCHEDULE="${CRON_SCHEDULE:-17 3 * * *}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="${SCRIPT_PATH:-${SCRIPT_DIR}/backup_saas_sqlite.sh}"
USER="${USER:-root}"

CRON_FILE="/etc/cron.d/codesprite-sqlite-backup"
LOG_DIR="/var/log/codesprite"
LOG_FILE="${LOG_DIR}/sqlite-backup.log"

if [[ ! -x "$SCRIPT_PATH" ]]; then
  echo "[info] making script executable: $SCRIPT_PATH"
  chmod +x "$SCRIPT_PATH"
fi

mkdir -p "$LOG_DIR"
touch "$LOG_FILE"
chmod 0644 "$LOG_FILE" || true

echo "[info] writing $CRON_FILE"

cat > "$CRON_FILE" <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# CodeSprite SaaS SQLite backup (managed by scripts/ops/install_saas_sqlite_backup_cron.sh)
${CRON_SCHEDULE} ${USER} \\
  CONTAINER='${CONTAINER:-codesprite-api-saas}' \\
  BACKUP_DIR_HOST='${BACKUP_DIR_HOST:-/srv/www/codesprite/data/backup}' \\
  BACKUP_DIR_CONTAINER='${BACKUP_DIR_CONTAINER:-/data/backup}' \\
  RETENTION_DAYS='${RETENTION_DAYS:-14}' \\
  ALIYUN_PROFILE='${ALIYUN_PROFILE:-}' \\
  OSS_BUCKET='${OSS_BUCKET:-}' \\
  OSS_PREFIX='${OSS_PREFIX:-codesprite/sqlite}' \\
  ${SCRIPT_PATH} >> ${LOG_FILE} 2>&1
EOF

chmod 0644 "$CRON_FILE"
echo "[ok] installed cron: $CRON_FILE"
echo "[ok] log: $LOG_FILE"

