#!/usr/bin/env bash
set -euo pipefail

# Reset or create SaaS admin user in the running `codesprite-api-saas` container.
# Non-interactive. Prints the resulting admin email/password.
#
# Usage (recommended):
#   ADMIN_EMAIL=admin@codesprite.example.com ADMIN_PASS='YourStrongPass' ./scripts/ops/reset_saas_admin.sh
#
# If ADMIN_PASS is not set, a random password will be generated.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

CONTAINER="${CONTAINER:-codesprite-api-saas}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@codesprite.example.com}"
ADMIN_PASS="${ADMIN_PASS:-}"

if [[ -z "$ADMIN_PASS" ]]; then
  # token_urlsafe gives URL-safe chars; good for copy/paste.
  ADMIN_PASS="$(python3 -c 'import secrets; print(secrets.token_urlsafe(12))')"
fi

echo "[info] target_container=$CONTAINER"
echo "[info] admin_email=$ADMIN_EMAIL"

DB_PATH="$(timeout 20s docker exec "$CONTAINER" python -c 'import os; print(os.environ.get("DB_PATH",""))')"
if [[ -z "$DB_PATH" ]]; then
  echo "[error] DB_PATH is empty in container env; cannot continue" >&2
  exit 1
fi
echo "[info] DB_PATH=$DB_PATH"

tmp_py="/tmp/cs_reset_admin.py"
cat > "/tmp/cs_reset_admin.py" <<'PY'
import os, sqlite3, time
from app.security import hash_password

db = os.environ["DB_PATH"]
email = os.environ["ADMIN_EMAIL"].strip().lower()
pw = os.environ["ADMIN_PASS"]

conn = sqlite3.connect(db)
cur = conn.cursor()

ph, salt = hash_password(pw)
ts = int(time.time())

row = cur.execute("SELECT id FROM users WHERE email=?;", (email,)).fetchone()
if row:
    uid = int(row[0])
    cur.execute(
        "UPDATE users SET password_hash=?, password_salt=?, role=?, updated_at=? WHERE id=?;",
        (ph, salt, "admin", ts, uid),
    )
else:
    cur.execute(
        "INSERT INTO users(email,password_hash,password_salt,role,created_at,updated_at) VALUES(?,?,?,?,?,?);",
        (email, ph, salt, "admin", ts, ts),
    )
    uid = int(cur.lastrowid)

# Ensure there is a subscription row so /api/me works nicely.
try:
    sub = cur.execute("SELECT id FROM subscriptions WHERE user_id=?;", (uid,)).fetchone()
    if not sub:
        cur.execute(
            "INSERT INTO subscriptions(user_id,status,trial_ends_at,current_period_end,created_at,updated_at) VALUES(?,?,?,?,?,?);",
            (uid, "active", ts + 365 * 24 * 3600, ts + 365 * 24 * 3600, ts, ts),
        )
except Exception:
    pass

conn.commit()
print("ok uid=", uid)
PY

timeout 20s docker cp "/tmp/cs_reset_admin.py" "$CONTAINER:$tmp_py" >/dev/null
rm -f "/tmp/cs_reset_admin.py"

timeout 30s docker exec -e "ADMIN_EMAIL=$ADMIN_EMAIL" -e "ADMIN_PASS=$ADMIN_PASS" "$CONTAINER" python "$tmp_py"
timeout 20s docker exec "$CONTAINER" rm -f "$tmp_py" >/dev/null || true

echo
echo "[ok] admin credentials:"
echo "  email: $ADMIN_EMAIL"
echo "  pass : $ADMIN_PASS"


