#!/usr/bin/env python3
"""
Verify DB schema required for POST /api/auth/login (password flow).

Run from repo:
  cd saas_api && PYTHONPATH=app python3 scripts/verify_saas_auth_schema.py

With MySQL (uses DB_DSN from environment or .env is not loaded here — export first):
  export DB_DSN='mysql+pymysql://...'
  cd saas_api && PYTHONPATH=app python3 scripts/verify_saas_auth_schema.py

Reproduce login (replace host/port and credentials):
  curl -sS -i -X POST 'http://127.0.0.1:18030/api/auth/login' \\
    -H 'Content-Type: application/json' \\
    -d '{"identifier":"admin@example.com","password":"your-password"}'
"""
from __future__ import annotations

import os
import sys

# saas_api/scripts -> add app/
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)


def main() -> int:
    os.chdir(_ROOT)
    # Import after chdir so relative paths in db resolve consistently
    from app.db import connect, fetch_all, init_db  # noqa: WPS433

    conn = connect()
    init_db(conn)
    cols = {str(r.get("name") or r.get("Field") or "").strip() for r in fetch_all(conn, "PRAGMA table_info(users);", ())} if conn.kind == "sqlite" else {
        str(r.get("Field") or "").strip()
        for r in fetch_all(conn, "SHOW COLUMNS FROM `users`;", ())
    }
    cols.discard("")
    need_pw = "password_hash" in cols
    need_login = ("email" in cols) or ("identifier" in cols)
    ok = need_pw and need_login
    print("users columns:", ", ".join(sorted(cols)) if cols else "(none / table missing?)")
    print("password_hash:", "yes" if need_pw else "MISSING")
    print("email or identifier:", "yes" if need_login else "MISSING")
    if conn.kind == "mysql":
        dsn = (os.environ.get("DB_DSN") or "").strip()
        print("db kind: mysql", "(DSN set)" if dsn else "(DB_DSN empty — using env from shell)")
    else:
        print("db kind: sqlite")
    if not ok:
        print("RESULT: FAIL — password login will return 500 Auth schema is incompatible")
        return 1

    # subscriptions: optional for login response; _subscription_for tolerates missing table/columns
    try:
        if conn.kind == "sqlite":
            sub_cols = {str(r.get("name") or "").strip() for r in fetch_all(conn, "PRAGMA table_info(subscriptions);", ())}
        else:
            sub_cols = {
                str(r.get("Field") or "").strip()
                for r in fetch_all(conn, "SHOW COLUMNS FROM `subscriptions`;", ())
            }
        sub_cols.discard("")
        print("subscriptions columns:", ", ".join(sorted(sub_cols)) if sub_cols else "(missing)")
        print("subscriptions.user_id:", "yes" if "user_id" in sub_cols else "MISSING (login may still work; subscription defaults to none)")
    except Exception as exc:  # noqa: BLE001
        print("subscriptions: could not inspect (%s)" % exc)

    admin_email = (os.environ.get("ADMIN_EMAIL") or "").strip()
    admin_pwd = (os.environ.get("ADMIN_PASSWORD") or "").strip()
    if admin_email and admin_pwd:
        print("ADMIN_EMAIL/ADMIN_PASSWORD: set (ensure_admin_from_env will upsert admin on API startup)")
    else:
        print("ADMIN_EMAIL/ADMIN_PASSWORD: not both set (admin row must exist in DB or set both env vars)")

    print("RESULT: OK — schema compatible with _login()")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
