#!/usr/bin/env python3
from __future__ import annotations

"""
Offline migration: SQLite (DB_PATH) -> MySQL (DB_DSN)

Design goals:
- Idempotent: safe to re-run (uses ON DUPLICATE KEY UPDATE / INSERT IGNORE)
- Batching: avoids huge transactions (ssh_audit can be large)
- Minimal dependencies: uses PyMySQL + sqlite3 (avoid heavy wheels/downloads)

Usage (example):
  export DB_PATH=/srv/www/codesprite/data/codesprite.db
  export DB_DSN='mysql+pymysql://codesprite:pw@codesprite-mysql:3306/codesprite?charset=utf8mb4'
  python saas_api/scripts/migrate_sqlite_to_mysql.py
"""

import os
import sqlite3
import sys
from typing import Any, Iterable, Iterator

import pymysql  # type: ignore


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _die(msg: str, code: int = 2) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def _sqlite_conn(path: str) -> sqlite3.Connection:
    # NOTE:
    # - Production sqlite uses WAL; even read-only access may require creating shm/wal files.
    # - Therefore the migration container should mount /data as read-write.
    p = (path or "").strip()
    if not p:
        raise ValueError("empty sqlite path")
    c = sqlite3.connect(p)
    try:
        c.execute("PRAGMA query_only=ON;")
    except Exception:
        pass
    c.row_factory = sqlite3.Row
    return c


def _chunks(rows: list[dict[str, Any]], n: int) -> Iterable[list[dict[str, Any]]]:
    for i in range(0, len(rows), n):
        yield rows[i : i + n]


def _fetch_all_sqlite(c: sqlite3.Connection, sql: str, args: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    cur = c.execute(sql, args)
    return [dict(r) for r in cur.fetchall()]

def _sqlite_has_table(c: sqlite3.Connection, name: str) -> bool:
    try:
        row = c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1;", (name,)).fetchone()
        return bool(row)
    except Exception:
        return False


def _mysql_upsert_sql(table: str, cols: list[str], pk_cols: list[str]) -> str:
    if not cols:
        raise ValueError("empty cols")
    if not pk_cols:
        raise ValueError("empty pk_cols")
    non_pk = [c for c in cols if c not in pk_cols]
    # Use VALUES(col) form for broad MySQL 8 compatibility.
    # (MySQL 8.0.20+ supports alias, but VALUES() is still widely accepted.)
    if not non_pk:
        updates = ", ".join([f"{c}={c}" for c in pk_cols])
    else:
        updates = ", ".join([f"{c}=VALUES({c})" for c in non_pk])
    return f"INSERT INTO {table}({', '.join(cols)}) VALUES({', '.join(['%s']*len(cols))}) ON DUPLICATE KEY UPDATE {updates};"


def _mysql_insert_ignore_sql(table: str, cols: list[str]) -> str:
    return f"INSERT IGNORE INTO {table}({', '.join(cols)}) VALUES({', '.join(['%s']*len(cols))});"


def _pymysql_connect(dsn: str):
    # Accept SQLAlchemy-like DSN: mysql+pymysql://user:pass@host:3306/db?charset=utf8mb4
    s = dsn.strip()
    if s.startswith("mysql+pymysql://"):
        s = "mysql://" + s[len("mysql+pymysql://") :]
    if not s.startswith("mysql://"):
        _die("DB_DSN must start with mysql+pymysql:// or mysql://")
    # Very small parser (avoid extra deps)
    # mysql://user:pass@host:3306/db?charset=utf8mb4
    try:
        head, tail = s.split("://", 1)
        auth_host, rest = tail.split("/", 1)
        if "@" in auth_host:
            auth, hostport = auth_host.split("@", 1)
        else:
            auth, hostport = "", auth_host
        user = ""
        pw = ""
        if auth:
            if ":" in auth:
                user, pw = auth.split(":", 1)
            else:
                user = auth
        if ":" in hostport:
            host, port_s = hostport.split(":", 1)
            port = int(port_s)
        else:
            host, port = hostport, 3306
        if "?" in rest:
            db, qs = rest.split("?", 1)
        else:
            db, qs = rest, ""
        charset = "utf8mb4"
        for part in qs.split("&"):
            if part.startswith("charset="):
                charset = part.split("=", 1)[1] or "utf8mb4"
    except Exception as e:
        _die(f"Invalid DB_DSN format: {e.__class__.__name__}")

    return pymysql.connect(
        host=host,
        port=int(port),
        user=user,
        password=pw,
        database=db,
        charset=charset,
        autocommit=False,
        cursorclass=pymysql.cursors.Cursor,
    )


def main() -> None:
    db_path = _env("DB_PATH")
    dsn = _env("DB_DSN")
    if not db_path:
        _die("Missing DB_PATH (sqlite file path)")
    if not dsn:
        _die("Missing DB_DSN (mysql+pymysql://...)")

    if not os.path.exists(db_path):
        _die(f"SQLite DB not found: {db_path}")

    sc = _sqlite_conn(db_path)
    mc = _pymysql_connect(dsn)

    # Tables to migrate (scope per plan)
    tables: list[dict[str, Any]] = [
        {"name": "users", "pk": ["id"]},
        {"name": "subscriptions", "pk": ["user_id"]},
        {"name": "recharge_orders", "pk": ["id"]},
        {"name": "ledger", "pk": ["id"]},
        {"name": "sms_codes", "pk": ["id"]},
        {"name": "llm_usage", "pk": ["id"]},
        {"name": "ssh_usage_daily", "pk": ["user_id", "day"]},
        {"name": "ssh_audit", "pk": ["id"]},
        {"name": "inventory_state", "pk": ["user_id", "space_id"]},
        {"name": "inventory_credentials", "pk": ["id"]},
    ]

    # Preflight: ensure MySQL has tables
    with mc.cursor() as cur:
        for t in tables:
            name = t["name"]
            cur.execute(
                "SELECT COUNT(1) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=%s;",
                (name,),
            )
            n = int(cur.fetchone()[0] or 0)
            if n <= 0:
                _die(f"MySQL table missing: {name}. Run migrations/mysql_init.sql first.")

    total_rows = 0
    try:
        for t in tables:
            name = str(t["name"])
            pk = list(t["pk"])

            if not _sqlite_has_table(sc, name):
                print(f"[{name}] sqlite table missing -> skip", flush=True)
                continue

            rows = _fetch_all_sqlite(sc, f"SELECT * FROM {name};")
            total_rows += len(rows)
            print(f"[{name}] sqlite rows={len(rows)}", flush=True)
            if not rows:
                continue

            cols = sorted(list(rows[0].keys()))
            up_sql = _mysql_upsert_sql(name, cols, pk)

            # batch sizes: ssh_audit can be huge
            batch = 2000 if name == "ssh_audit" else 1000
            with mc.cursor() as cur:
                for chunk in _chunks(rows, batch):
                    vals = [tuple(r.get(c) for c in cols) for r in chunk]
                    cur.executemany(up_sql, vals)
                    mc.commit()

            # quick validation: count compare (best-effort)
            with mc.cursor() as cur:
                cur.execute(f"SELECT COUNT(1) FROM {name};")
                my_n = int(cur.fetchone()[0] or 0)
            print(f"[{name}] mysql rows={my_n}", flush=True)
    finally:
        try:
            mc.close()
        except Exception:
            pass
        try:
            sc.close()
        except Exception:
            pass

    print(f"Done. Migrated tables={len(tables)}, sqlite_total_rows={total_rows}")


if __name__ == "__main__":
    main()

