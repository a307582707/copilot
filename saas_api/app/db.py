from __future__ import annotations

import os
import sqlite3
import re
import threading
from pathlib import Path
from typing import Any

from sqlalchemy import text  # type: ignore
from sqlalchemy.engine import Connection, Engine  # type: ignore
from sqlalchemy import create_engine  # type: ignore


def _repo_root() -> Path:
    """
    Repo root detection:
    - In repo layout:   <root>/saas_api/app/db.py        => want <root>
    - In prod mount:    /app/app/db.py                   => want /app
    """
    p = Path(__file__).resolve()
    parents = list(p.parents)
    # Try a few likely roots, prefer the one that contains our MySQL DDL.
    for r in parents[1:6]:
        try:
            if (r / "migrations" / "mysql_init.sql").exists():
                return r
            if (r / "saas_api" / "migrations" / "mysql_init.sql").exists():
                return r
        except Exception:
            continue
    return p.parents[2]


def db_path() -> Path:
    p = (os.environ.get("DB_PATH") or "").strip()
    if p:
        return Path(p)
    return _repo_root() / "data" / "codesprite.db"

def db_dsn() -> str:
    return (os.environ.get("DB_DSN") or "").strip()


def db_require_mysql() -> bool:
    raw = (os.environ.get("DB_REQUIRE_MYSQL") or "").strip().lower()
    return raw in {"1", "true", "yes", "y", "on"}


_QMARK_RE = re.compile(r"\?")


def _rewrite_qmark_to_named(sql: str, args: tuple[Any, ...]) -> tuple[str, dict[str, Any]]:
    """
    Convert SQLite-style positional '?' placeholders into SQLAlchemy named binds ':p0,:p1,...'.
    Attempts to avoid replacing '?' inside string literals and identifiers.
    """
    if not args:
        return sql, {}
    s = sql or ""
    out: list[str] = []
    params: dict[str, Any] = {}
    in_sq = False
    in_dq = False
    in_bt = False
    i = 0
    idx = 0
    while i < len(s):
        ch = s[i]
        if ch == "'" and not in_dq and not in_bt:
            # handle escaped '' inside single quotes
            if in_sq and i + 1 < len(s) and s[i + 1] == "'":
                out.append("''")
                i += 2
                continue
            in_sq = not in_sq
            out.append(ch)
            i += 1
            continue
        if ch == '"' and not in_sq and not in_bt:
            in_dq = not in_dq
            out.append(ch)
            i += 1
            continue
        if ch == "`" and not in_sq and not in_dq:
            in_bt = not in_bt
            out.append(ch)
            i += 1
            continue

        if ch == "?" and not in_sq and not in_dq and not in_bt:
            key = f"p{idx}"
            out.append(f":{key}")
            params[key] = args[idx] if idx < len(args) else None
            idx += 1
            i += 1
            continue

        out.append(ch)
        i += 1

    return "".join(out), params


def _rewrite_insert_or_ignore(sql: str) -> str:
    s = (sql or "").lstrip()
    if not s.lower().startswith("insert or ignore"):
        return sql
    # MySQL supports INSERT IGNORE
    return re.sub(r"(?i)^\s*INSERT\s+OR\s+IGNORE\s+", "INSERT IGNORE ", sql, count=1)


def _rewrite_insert_or_replace(sql: str) -> str:
    """
    SQLite: INSERT OR REPLACE INTO t(c1,c2,...) VALUES(...)
    MySQL:  INSERT INTO t(c1,c2,...) VALUES(...) AS new
            ON DUPLICATE KEY UPDATE c1=new.c1, ...
    """
    s = (sql or "").strip()
    m = re.match(r"(?is)^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*;?\s*$", s)
    if not m:
        return sql
    table = m.group(1).strip()
    cols_raw = m.group(2)
    vals_raw = m.group(3)
    cols = [c.strip() for c in cols_raw.split(",") if c.strip()]
    if not cols:
        return sql
    updates = ", ".join([f"{c}=new.{c}" for c in cols])
    return f"INSERT INTO {table}({', '.join(cols)}) VALUES({vals_raw}) AS new ON DUPLICATE KEY UPDATE {updates};"


def _rewrite_begin_immediate(sql: str) -> str:
    s = (sql or "").strip().rstrip(";").strip().lower()
    if s == "begin immediate":
        return "START TRANSACTION;"
    return sql


class DbConn:
    """
    A tiny compatibility wrapper so existing code can call:
      - execute(sql, args)
      - commit(), rollback()
    and keep working for both SQLite and MySQL.
    """

    def __init__(self, kind: str, *, sqlite: sqlite3.Connection | None = None, mysql_engine: Engine | None = None):
        self.kind = kind
        self._sqlite = sqlite
        self._mysql_engine = mysql_engine
        self._mysql_local = threading.local()

    def _mysql_conn(self) -> Connection:
        if self.kind != "mysql":
            raise RuntimeError("Not mysql")
        if self._mysql_engine is None:
            raise RuntimeError("MySQL engine not configured")
        c = getattr(self._mysql_local, "conn", None)
        if c is None:
            c = self._mysql_engine.connect()
            setattr(self._mysql_local, "conn", c)
        return c

    def _mysql_release(self) -> None:
        c = getattr(self._mysql_local, "conn", None)
        if c is None:
            return
        try:
            c.close()
        except Exception:
            pass
        try:
            setattr(self._mysql_local, "conn", None)
        except Exception:
            pass

    def execute(self, sql: str, args: Any = ()) -> Any:
        if self.kind == "sqlite":
            assert self._sqlite is not None
            return self._sqlite.execute(sql, args)

        c = self._mysql_conn()
        s = _rewrite_begin_immediate(sql)
        s = _rewrite_insert_or_ignore(s)
        s = _rewrite_insert_or_replace(s)

        # Param normalization:
        # - mapping args (named binds) -> pass-through
        # - tuple/list args (qmark) -> rewrite ? to :pN
        if isinstance(args, dict):
            return c.execute(text(s), args)
        if isinstance(args, (tuple, list)):
            s2, p = _rewrite_qmark_to_named(s, tuple(args))
            return c.execute(text(s2), p)
        # no args
        return c.execute(text(s), {})

    def executescript(self, script: str) -> None:
        if self.kind == "sqlite":
            assert self._sqlite is not None
            self._sqlite.executescript(script)
            return
        # Best-effort script runner for MySQL DDL.
        # - We do NOT support procedures/triggers here.
        # - We DO strip full-line comments starting with '--' or '#'.
        # Important: remove comments BEFORE splitting by ';' so semicolons in comments
        # don't produce invalid SQL fragments.
        keep_lines: list[str] = []
        for ln in (script or "").splitlines():
            s = ln.strip()
            if not s:
                continue
            if s.startswith("--") or s.startswith("#"):
                continue
            keep_lines.append(ln)
        cleaned = "\n".join(keep_lines)
        for part in cleaned.split(";"):
            stmt = part.strip()
            if not stmt:
                continue
            self.execute(stmt + ";")

    def commit(self) -> None:
        if self.kind == "sqlite":
            assert self._sqlite is not None
            self._sqlite.commit()
            return
        try:
            self._mysql_conn().commit()
        except Exception:
            # best-effort: some drivers autocommit; ignore
            pass
        # Release connection back to pool after a completed unit of work.
        self._mysql_release()

    def rollback(self) -> None:
        if self.kind == "sqlite":
            assert self._sqlite is not None
            self._sqlite.rollback()
            return
        try:
            self._mysql_conn().rollback()
        except Exception:
            pass
        self._mysql_release()

    def release(self) -> None:
        """
        Release MySQL connection back to SQLAlchemy pool.
        Needed for read-only queries (fetch_one/fetch_all) which don't call commit().
        """
        if self.kind != "mysql":
            return
        self._mysql_release()

    def close(self) -> None:
        try:
            if self._sqlite is not None:
                self._sqlite.close()
        except Exception:
            pass
        try:
            if self._mysql_engine is not None:
                self._mysql_release()
        except Exception:
            pass


_MYSQL_ENGINE: Engine | None = None


def _mysql_engine() -> Engine:
    global _MYSQL_ENGINE
    if _MYSQL_ENGINE is not None:
        return _MYSQL_ENGINE
    dsn = db_dsn()
    if not dsn:
        raise RuntimeError("DB_DSN not configured")
    # Example: mysql+pymysql://user:pass@host:3306/codesprite?charset=utf8mb4
    _MYSQL_ENGINE = create_engine(dsn, pool_pre_ping=True, pool_recycle=1800, future=True)
    return _MYSQL_ENGINE


def connect() -> DbConn:
    dsn = db_dsn()
    if dsn:
        return DbConn("mysql", mysql_engine=_mysql_engine())
    if db_require_mysql():
        raise RuntimeError("DB_REQUIRE_MYSQL=1 but DB_DSN is not configured")
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return DbConn("sqlite", sqlite=conn)


def _init_mysql(conn: DbConn) -> None:
    # Run the MySQL DDL file (idempotent).
    # In repo:   <repo>/saas_api/migrations/mysql_init.sql
    # In prod:   /app/migrations/mysql_init.sql   (when /srv/www/codesprite/api is bind-mounted to /app)
    cand = [
        _repo_root() / "migrations" / "mysql_init.sql",
        _repo_root() / "saas_api" / "migrations" / "mysql_init.sql",
    ]
    for ddl in cand:
        if ddl.exists() and ddl.is_file():
            conn.executescript(ddl.read_text(encoding="utf-8", errors="ignore"))
            conn.commit()
            return
    raise RuntimeError("MySQL DDL file not found: migrations/mysql_init.sql")


def init_db(conn: DbConn) -> None:
    if conn.kind == "mysql":
        _init_mysql(conn)
        for stmt in [
            "ALTER TABLE users ADD COLUMN display_name VARCHAR(120) NULL;",
            "ALTER TABLE users ADD COLUMN avatar_url VARCHAR(500) NULL;",
            "ALTER TABLE users ADD COLUMN wechat_openid VARCHAR(128) NULL;",
            "ALTER TABLE users ADD COLUMN wechat_unionid VARCHAR(128) NULL;",
            "ALTER TABLE users ADD COLUMN wechat_bound_at BIGINT NULL;",
            "ALTER TABLE users ADD COLUMN last_login_at BIGINT NULL;",
            "ALTER TABLE users ADD COLUMN last_login_ip VARCHAR(64) NULL;",
            "ALTER TABLE users ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active';",
            "ALTER TABLE login_challenges ADD COLUMN purpose VARCHAR(32) NOT NULL DEFAULT 'login';",
            "ALTER TABLE login_challenges ADD COLUMN meta_json LONGTEXT NULL;",
            "ALTER TABLE auth_audit ADD COLUMN action_type VARCHAR(40) NOT NULL DEFAULT 'unknown';",
            "ALTER TABLE auth_audit ADD COLUMN identifier VARCHAR(190) NULL;",
            "ALTER TABLE users ADD UNIQUE KEY uk_users_wechat_openid (wechat_openid);",
            "ALTER TABLE users ADD UNIQUE KEY uk_users_wechat_unionid (wechat_unionid);",
        ]:
            try:
                conn.execute(stmt)
            except Exception:
                pass
        conn.executescript(
            """
CREATE TABLE IF NOT EXISTS login_challenges (
  id           VARCHAR(80) NOT NULL,
  purpose      VARCHAR(32) NOT NULL DEFAULT 'login',
  channel      VARCHAR(20) NOT NULL,
  state_token  VARCHAR(120) NOT NULL,
  scene_token  VARCHAR(120) NOT NULL,
  status       VARCHAR(20) NOT NULL,
  user_id      BIGINT NULL,
  redirect_uri VARCHAR(500) NULL,
  client_ip    VARCHAR(64) NULL,
  ua           TEXT NULL,
  meta_json    LONGTEXT NULL,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  consumed_at  BIGINT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_login_challenges_state (state_token),
  KEY idx_login_challenges_status_created (status, created_at DESC),
  KEY idx_login_challenges_user_created (user_id, created_at DESC),
  CONSTRAINT fk_login_challenges_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_audit (
  id          VARCHAR(80) NOT NULL,
  user_id     BIGINT NULL,
  action_type VARCHAR(40) NOT NULL,
  result      VARCHAR(20) NOT NULL,
  identifier  VARCHAR(190) NULL,
  ip          VARCHAR(64) NULL,
  ua          TEXT NULL,
  detail_json LONGTEXT NULL,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY idx_auth_audit_user_created (user_id, created_at DESC),
  KEY idx_auth_audit_action_created (action_type, created_at DESC),
  CONSTRAINT fk_auth_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""
        )
        conn.commit()
        return
    # sqlite
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.executescript(
        """
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id             INTEGER PRIMARY KEY,
  status              TEXT NOT NULL,
  trial_ends_at       INTEGER,
  current_period_end  INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recharge_orders (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  channel       TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  status        TEXT NOT NULL,
  note          TEXT,
  created_at    INTEGER NOT NULL,
  paid_at       INTEGER,
  credited_at   INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ledger (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  entry_type    TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  period        TEXT,
  ref_id        TEXT,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recharge_user_created ON recharge_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_user_created ON ledger(user_id, created_at DESC);
"""
    )
    # Idempotency guard: avoid double ledger writes for the same ref_id.
    # Safe for existing DBs (will no-op if already present).
    conn.executescript(
        """
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_user_type_ref_unique ON ledger(user_id, entry_type, ref_id);
"""
    )
    # lightweight migrations for existing DBs (no Alembic)
    # NOTE: must work on old SQLite (3.7.x) and even when schema is partially broken.
    for stmt in [
        "ALTER TABLE users ADD COLUMN phone TEXT;",
        "ALTER TABLE users ADD COLUMN phone_verified_at INTEGER;",
        "ALTER TABLE users ADD COLUMN display_name TEXT;",
        "ALTER TABLE users ADD COLUMN avatar_url TEXT;",
        "ALTER TABLE users ADD COLUMN wechat_openid TEXT;",
        "ALTER TABLE users ADD COLUMN wechat_unionid TEXT;",
        "ALTER TABLE users ADD COLUMN wechat_bound_at INTEGER;",
        "ALTER TABLE users ADD COLUMN last_login_at INTEGER;",
        "ALTER TABLE users ADD COLUMN last_login_ip TEXT;",
        "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';",
        "ALTER TABLE login_challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login';",
        "ALTER TABLE login_challenges ADD COLUMN meta_json TEXT;",
        "ALTER TABLE auth_audit ADD COLUMN action_type TEXT NOT NULL DEFAULT 'unknown';",
        "ALTER TABLE auth_audit ADD COLUMN identifier TEXT;",
        # Manual payment (temporary) fields
        "ALTER TABLE recharge_orders ADD COLUMN proof_path TEXT;",
        "ALTER TABLE recharge_orders ADD COLUMN submitted_at INTEGER;",
        "ALTER TABLE recharge_orders ADD COLUMN credited_by INTEGER;",
    ]:
        try:
            conn.execute(stmt)
        except Exception:
            # ignore if column already exists / table not ready
            pass

    # indexes/tables that depend on optional columns
    conn.executescript(
        """
-- NOTE: CentOS 7 ships an old SQLite (3.7.x) which does NOT support partial indexes.
-- UNIQUE index allows multiple NULLs, so this is sufficient for optional phone binding.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wechat_openid_unique ON users(wechat_openid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wechat_unionid_unique ON users(wechat_unionid);

CREATE TABLE IF NOT EXISTS sms_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose     TEXT NOT NULL, -- bind_phone | reset_password
  phone       TEXT NOT NULL,
  user_id     INTEGER,
  code_hash   TEXT NOT NULL,
  code_salt   TEXT NOT NULL,
  ip          TEXT,
  ua          TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sms_codes_phone_purpose_created ON sms_codes(phone, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS login_challenges (
  id           TEXT PRIMARY KEY,
  purpose      TEXT NOT NULL DEFAULT 'login',
  channel      TEXT NOT NULL,
  state_token  TEXT NOT NULL UNIQUE,
  scene_token  TEXT NOT NULL,
  status       TEXT NOT NULL,
  user_id      INTEGER,
  redirect_uri TEXT,
  client_ip    TEXT,
  ua           TEXT,
  meta_json    TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_login_challenges_status_created ON login_challenges(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_challenges_user_created ON login_challenges(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_audit (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER,
  action_type TEXT NOT NULL,
  result      TEXT NOT NULL,
  identifier  TEXT,
  ip          TEXT,
  ua          TEXT,
  detail_json TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_audit_user_created ON auth_audit(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_audit_action_created ON auth_audit(action_type, created_at DESC);
"""
    )

    # LLM usage audit table (P0 billing)
    conn.executescript(
        """
CREATE TABLE IF NOT EXISTS llm_usage (
  id               TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL,
  model            TEXT,
  upstream         TEXT,
  status           TEXT NOT NULL,
  prompt_chars     INTEGER,
  completion_chars INTEGER,
  prompt_tokens    INTEGER,
  completion_tokens INTEGER,
  cost_cents       INTEGER,
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  error            TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_user_started ON llm_usage(user_id, started_at DESC);
"""
    )

    # SSH trial usage counters (per-user, per-day)
    conn.executescript(
        """
CREATE TABLE IF NOT EXISTS ssh_usage_daily (
  user_id          INTEGER NOT NULL,
  day              INTEGER NOT NULL, -- YYYYMMDD
  sessions_created INTEGER NOT NULL DEFAULT 0,
  ops              INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY(user_id, day),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
"""
    )

    # SSH/Files/PTY audit events (P0 traceability)
    # - Do NOT store full stdout/stderr (only lengths + optional short error string)
    # - Bounded strings; keep schema compatible with old SQLite (CentOS7).
    conn.executescript(
        """
CREATE TABLE IF NOT EXISTS ssh_audit (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  session_id   TEXT,
  event_type   TEXT NOT NULL, -- ssh_exec | files_list | files_read | files_write | pty_open | pty_close | pty_lease_create | pty_lease_end
  asset_name   TEXT,
  ssh_target   TEXT,
  cwd          TEXT,
  path         TEXT,
  cmd          TEXT,
  ok           INTEGER,
  exit_code    INTEGER,
  timed_out    INTEGER,
  stdout_len   INTEGER,
  stderr_len   INTEGER,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  duration_ms  INTEGER,
  error        TEXT,
  meta_json    TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ssh_audit_user_started ON ssh_audit(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ssh_audit_session_started ON ssh_audit(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ssh_audit_type_started ON ssh_audit(event_type, started_at DESC);
"""
    )

    # AIOps (Incident / Evidence / Actions) - MVP schema
    # - Keep TEXT-only JSON blobs for old SQLite compatibility.
    conn.executescript(
        """
CREATE TABLE IF NOT EXISTS aiops_incidents (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL, -- triage|investigating|mitigating|verifying|resolved
  severity      TEXT NOT NULL, -- info|warn|critical
  title         TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  source        TEXT,
  labels_json   TEXT,
  meta_json     TEXT,
  started_at    INTEGER,
  resolved_at   INTEGER,
  last_event_at INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aiops_incidents_fingerprint ON aiops_incidents(fingerprint, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_aiops_incidents_last_event ON aiops_incidents(last_event_at DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS aiops_events (
  id              TEXT PRIMARY KEY,
  incident_id     TEXT NOT NULL,
  source          TEXT,
  severity        TEXT,
  title           TEXT,
  description     TEXT,
  fingerprint     TEXT,
  starts_at       INTEGER,
  ends_at         INTEGER,
  received_at     INTEGER NOT NULL,
  labels_json     TEXT,
  annotations_json TEXT,
  raw_json        TEXT,
  FOREIGN KEY(incident_id) REFERENCES aiops_incidents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aiops_events_incident_received ON aiops_events(incident_id, received_at DESC);

CREATE TABLE IF NOT EXISTS aiops_evidence (
  id          TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  title       TEXT,
  content     TEXT,
  created_by  INTEGER,
  created_at  INTEGER NOT NULL,
  meta_json   TEXT,
  FOREIGN KEY(incident_id) REFERENCES aiops_incidents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aiops_evidence_incident_created ON aiops_evidence(incident_id, created_at DESC);

CREATE TABLE IF NOT EXISTS aiops_actions (
  id           TEXT PRIMARY KEY,
  incident_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  title        TEXT,
  risk         TEXT NOT NULL, -- low|high
  status       TEXT NOT NULL, -- proposed|pending_approval|approved|running|succeeded|failed|cancelled
  runbook_json TEXT,
  decision_json TEXT,
  created_by   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER,
  approved_by  INTEGER,
  approved_at  INTEGER,
  started_at   INTEGER,
  finished_at  INTEGER,
  exit_code    INTEGER,
  error        TEXT,
  FOREIGN KEY(incident_id) REFERENCES aiops_incidents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aiops_actions_incident_created ON aiops_actions(incident_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aiops_actions_status_created ON aiops_actions(status, created_at DESC);

-- AIOps Inspection (Agent is first-class; CI is an execution channel)
CREATE TABLE IF NOT EXISTS aiops_inspection_defs (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL, -- bigdata_aliyun|...
  env_id       TEXT NOT NULL, -- e.g. staging
  env_json     TEXT,          -- config snapshot (cicd/env schema)
  runner_json  TEXT,          -- how to run in CI (stages/args)
  schedule_json TEXT,         -- cron-like (future)
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_by   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aiops_inspection_defs_env ON aiops_inspection_defs(env_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_aiops_inspection_defs_kind ON aiops_inspection_defs(kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS aiops_inspection_runs (
  id            TEXT PRIMARY KEY,
  def_id        TEXT NOT NULL,
  env_id        TEXT NOT NULL,
  status        TEXT NOT NULL, -- queued|running|succeeded|failed|timeout|cancelled
  correlation_id TEXT,         -- idempotency key from CI (optional)
  triggered_by  INTEGER,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  ok            INTEGER,
  summary       TEXT,
  report_json   TEXT,
  incident_ids_json TEXT,
  error         TEXT,
  FOREIGN KEY(def_id) REFERENCES aiops_inspection_defs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aiops_inspection_runs_env_created ON aiops_inspection_runs(env_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aiops_inspection_runs_def_created ON aiops_inspection_runs(def_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aiops_inspection_runs_status_created ON aiops_inspection_runs(status, created_at DESC);
-- CentOS7 old SQLite: UNIQUE allows multiple NULLs; suitable for optional correlation_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_aiops_inspection_runs_correlation_unique ON aiops_inspection_runs(correlation_id);

-- AIOps global settings (GitLab execution channel, etc.)
CREATE TABLE IF NOT EXISTS aiops_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  INTEGER NOT NULL,
  updated_by  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_aiops_settings_updated ON aiops_settings(updated_at DESC);

-- AIOps Components (BigData products as first-class citizens)
CREATE TABLE IF NOT EXISTS aiops_components (
  key         TEXT PRIMARY KEY, -- flink|starrocks|dataworks|dlf|actiontrail|network
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS aiops_component_instances (
  id            TEXT PRIMARY KEY,
  component_key TEXT NOT NULL,
  name          TEXT NOT NULL,
  env           TEXT,
  region        TEXT,
  role_arn      TEXT,
  config_json   TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_by    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aiops_component_instances_key ON aiops_component_instances(component_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_aiops_component_instances_env ON aiops_component_instances(env, updated_at DESC);

CREATE TABLE IF NOT EXISTS aiops_component_checks (
  id            TEXT PRIMARY KEY,
  instance_id   TEXT NOT NULL,
  kind          TEXT NOT NULL, -- connectivity|health
  status        TEXT NOT NULL, -- queued|running|succeeded|failed
  created_by    INTEGER,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  ok            INTEGER,
  summary       TEXT,
  details_json  TEXT,
  FOREIGN KEY(instance_id) REFERENCES aiops_component_instances(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aiops_component_checks_instance_created ON aiops_component_checks(instance_id, created_at DESC);

CREATE TABLE IF NOT EXISTS aiops_component_snapshots (
  id            TEXT PRIMARY KEY,
  instance_id   TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  ok            INTEGER,
  status        TEXT,
  summary       TEXT,
  details_json  TEXT,
  FOREIGN KEY(instance_id) REFERENCES aiops_component_instances(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aiops_component_snapshots_instance_ts ON aiops_component_snapshots(instance_id, ts DESC);

-- Host/Asset inventory sync (per-user blobs; secrets are NOT stored here)
CREATE TABLE IF NOT EXISTS inventory_state (
  user_id     INTEGER NOT NULL,
  space_id    TEXT NOT NULL,
  json        TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 2,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY(user_id, space_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_inventory_state_user_updated ON inventory_state(user_id, updated_at DESC);

-- Optional encrypted credential vault (per-user)
CREATE TABLE IF NOT EXISTS inventory_credentials (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  kind        TEXT NOT NULL, -- password | ssh_key
  enc_payload TEXT NOT NULL,
  meta_json   TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_inventory_credentials_user_updated ON inventory_credentials(user_id, updated_at DESC);

-- Rules (per-user, per-space): user rules + project rules + command allowlist/hints
CREATE TABLE IF NOT EXISTS rules_state (
  user_id       INTEGER NOT NULL,
  space_id      TEXT NOT NULL,
  user_rules    TEXT NOT NULL,
  project_rules TEXT NOT NULL,
  commands      TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY(user_id, space_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rules_state_user_updated ON rules_state(user_id, updated_at DESC);

-- Asset sync: run records (replaces Jenkins/GitLab trigger)
CREATE TABLE IF NOT EXISTS aiops_asset_sync_runs (
  id                TEXT PRIMARY KEY,
  cloud_account_key TEXT NOT NULL,
  cli_account_id    TEXT NOT NULL,
  region            TEXT NOT NULL DEFAULT 'all',
  trigger_mode      TEXT NOT NULL DEFAULT 'manual',  -- manual | schedule
  status            TEXT NOT NULL DEFAULT 'queued',   -- queued | running | success | failed
  started_at        INTEGER,
  finished_at       INTEGER,
  summary           TEXT,
  error             TEXT,
  triggered_by      INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aiops_sync_runs_status ON aiops_asset_sync_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aiops_sync_runs_account ON aiops_asset_sync_runs(cloud_account_key, created_at DESC);

-- Asset sync: scheduled tasks
CREATE TABLE IF NOT EXISTS aiops_asset_sync_schedules (
  id                TEXT PRIMARY KEY,
  cloud_account_key TEXT NOT NULL,
  cli_account_id    TEXT NOT NULL,
  region            TEXT NOT NULL DEFAULT 'all',
  cron_expr         TEXT NOT NULL DEFAULT '0 18 * * *',
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_run_id       TEXT,
  last_run_at       INTEGER,
  next_run_at       INTEGER,
  updated_by        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aiops_sync_schedules_enabled ON aiops_asset_sync_schedules(enabled, next_run_at ASC);
"""
    )
    conn.executescript(
        """
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id               TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  event_id         TEXT NOT NULL,
  event_type       TEXT,
  order_id         TEXT,
  signature_valid  INTEGER NOT NULL DEFAULT 0,
  handled          INTEGER NOT NULL DEFAULT 0,
  payload_json     TEXT,
  received_at      INTEGER NOT NULL,
  handled_at       INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_webhook_provider_event_unique ON payment_webhook_events(provider, event_id);
CREATE INDEX IF NOT EXISTS idx_payment_webhook_received ON payment_webhook_events(received_at DESC);

CREATE TABLE IF NOT EXISTS payment_refunds (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL,
  provider          TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL,
  currency          TEXT,
  status            TEXT NOT NULL,
  reason_code       TEXT,
  provider_ref      TEXT,
  created_by        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_refunds_provider_ref_unique ON payment_refunds(provider, provider_ref);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_order_created ON payment_refunds(order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS delivery_records (
  id                      TEXT PRIMARY KEY,
  user_id                 INTEGER NOT NULL,
  subscription_period_key TEXT,
  delivery_type           TEXT NOT NULL,
  status                  TEXT NOT NULL,
  region                  TEXT,
  device_limit            INTEGER,
  region_limit            INTEGER,
  config_version          INTEGER NOT NULL DEFAULT 1,
  issued_at               INTEGER,
  expires_at              INTEGER,
  revoked_at              INTEGER,
  updated_at              INTEGER NOT NULL,
  meta_json               TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_delivery_records_user_updated ON delivery_records(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_records_status_updated ON delivery_records(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS device_registrations (
  id                 TEXT PRIMARY KEY,
  user_id            INTEGER NOT NULL,
  device_fingerprint TEXT NOT NULL,
  first_seen_at      INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active',
  notes              TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_registrations_user_fingerprint_unique ON device_registrations(user_id, device_fingerprint);
CREATE INDEX IF NOT EXISTS idx_device_registrations_user_seen ON device_registrations(user_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS abuse_events (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER,
  category      TEXT NOT NULL,
  severity      TEXT NOT NULL,
  status        TEXT NOT NULL,
  action_taken  TEXT,
  evidence_json TEXT,
  created_by    INTEGER,
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_abuse_events_status_created ON abuse_events(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abuse_events_user_created ON abuse_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS node_inventory (
  id                 TEXT PRIMARY KEY,
  region             TEXT NOT NULL,
  provider           TEXT NOT NULL,
  status             TEXT NOT NULL,
  capacity_limit     INTEGER NOT NULL DEFAULT 0,
  active_users       INTEGER NOT NULL DEFAULT 0,
  cost_monthly_cents INTEGER NOT NULL DEFAULT 0,
  latency_p50_ms     INTEGER NOT NULL DEFAULT 0,
  online_rate        REAL NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL,
  meta_json          TEXT
);
CREATE INDEX IF NOT EXISTS idx_node_inventory_region_updated ON node_inventory(region, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_node_inventory_status_updated ON node_inventory(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS status_incidents (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL,
  scope_json  TEXT,
  message_md  TEXT,
  created_by  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_status_incidents_updated ON status_incidents(updated_at DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id            TEXT PRIMARY KEY,
  actor_user_id INTEGER,
  target_type   TEXT NOT NULL,
  target_id     TEXT,
  action        TEXT NOT NULL,
  before_json   TEXT,
  after_json    TEXT,
  reason        TEXT,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor_created ON admin_audit_events(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target_created ON admin_audit_events(target_type, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS support_tickets (
  id             TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL,
  category       TEXT NOT NULL,
  subject        TEXT NOT NULL,
  content        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',
  admin_note     TEXT,
  assigned_to    INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  resolved_at    INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(assigned_to) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user_updated ON support_tickets(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status_updated ON support_tickets(status, updated_at DESC);
"""
    )
    conn.commit()


def fetch_one(conn: DbConn, sql: str, args: Any = ()) -> dict[str, Any] | None:
    if conn.kind == "sqlite":
        cur = conn.execute(sql, args)
        row = cur.fetchone()
        return dict(row) if row else None
    try:
        r = conn.execute(sql, args)
        row = r.mappings().first() if hasattr(r, "mappings") else None
        return dict(row) if row else None
    finally:
        try:
            conn.release()
        except Exception:
            pass


def fetch_all(conn: DbConn, sql: str, args: Any = ()) -> list[dict[str, Any]]:
    if conn.kind == "sqlite":
        cur = conn.execute(sql, args)
        return [dict(r) for r in cur.fetchall()]
    try:
        r = conn.execute(sql, args)
        return [dict(x) for x in (r.mappings().all() if hasattr(r, "mappings") else [])]
    finally:
        try:
            conn.release()
        except Exception:
            pass


def exec_one(conn: DbConn, sql: str, args: Any = ()) -> int:
    r = conn.execute(sql, args)
    conn.commit()
    # best-effort lastrowid compatibility
    try:
        lr = getattr(r, "lastrowid", None)
        return int(lr or 0)
    except Exception:
        return 0