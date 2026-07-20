from __future__ import annotations

import json
import time
from typing import Any

from ..accounting import new_id
from ..db import exec_one, fetch_all, fetch_one
from .types import safe_json


def _now() -> int:
    return int(time.time())


def ensure_component_catalog(conn) -> None:
    """
    Best-effort seed of known component types.
    Safe for existing DBs; uses INSERT OR IGNORE pattern.
    """
    now = _now()
    items = [
        ("flink", "Flink / Ververica"),
        ("starrocks", "StarRocks"),
        ("dataworks", "DataWorks"),
        ("dlf", "DLF"),
        ("actiontrail", "ActionTrail"),
        ("network", "Network"),
    ]
    for k, name in items:
        try:
            conn.execute(
                "INSERT OR IGNORE INTO aiops_components(key,name,enabled,created_at,updated_at) VALUES(?,?,?,?,?);",
                (k, name, 1, now, now),
            )
        except Exception:
            pass
    try:
        conn.commit()
    except Exception:
        pass


def list_components(conn) -> list[dict[str, Any]]:
    return fetch_all(conn, "SELECT key,name,enabled,created_at,updated_at FROM aiops_components ORDER BY key ASC;", ())


def list_instances(conn, *, limit: int = 200) -> list[dict[str, Any]]:
    n = max(1, min(500, int(limit)))
    return fetch_all(
        conn,
        "SELECT id,component_key,name,env,region,role_arn,enabled,created_by,created_at,updated_at FROM aiops_component_instances ORDER BY updated_at DESC LIMIT ?;",
        (n,),
    )


def get_instance(conn, instance_id: str) -> dict[str, Any] | None:
    return fetch_one(conn, "SELECT * FROM aiops_component_instances WHERE id=?;", (str(instance_id or "").strip(),))


def upsert_instance(
    conn,
    *,
    instance_id: str,
    component_key: str,
    name: str,
    env: str,
    region: str,
    role_arn: str,
    config: dict[str, Any],
    enabled: bool,
    by_user_id: int | None,
) -> str:
    iid = str(instance_id or "").strip()
    if not iid:
        iid = new_id("cmp")
    now = _now()
    exist = fetch_one(conn, "SELECT id FROM aiops_component_instances WHERE id=?;", (iid,))
    if exist:
        exec_one(
            conn,
            """
UPDATE aiops_component_instances
SET component_key=?, name=?, env=?, region=?, role_arn=?, config_json=?, enabled=?, updated_at=?
WHERE id=?;
""",
            (
                str(component_key or "")[:40],
                str(name or "")[:200],
                str(env or "")[:80],
                str(region or "")[:40],
                str(role_arn or "")[:400],
                safe_json(config or {}),
                1 if enabled else 0,
                now,
                iid,
            ),
        )
        return iid
    exec_one(
        conn,
        """
INSERT INTO aiops_component_instances(id,component_key,name,env,region,role_arn,config_json,enabled,created_by,created_at,updated_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?);
""",
        (
            iid,
            str(component_key or "")[:40],
            str(name or "")[:200],
            str(env or "")[:80],
            str(region or "")[:40],
            str(role_arn or "")[:400],
            safe_json(config or {}),
            1 if enabled else 0,
            int(by_user_id) if isinstance(by_user_id, int) else None,
            now,
            now,
        ),
    )
    return iid


def set_instance_enabled(conn, instance_id: str, *, enabled: bool) -> None:
    now = _now()
    exec_one(conn, "UPDATE aiops_component_instances SET enabled=?, updated_at=? WHERE id=?;", (1 if enabled else 0, now, str(instance_id or "").strip()))


def add_snapshot(
    conn,
    *,
    instance_id: str,
    ok: bool | None,
    status: str,
    summary: str,
    details: dict[str, Any] | None,
    ts: int | None = None,
) -> str:
    sid = new_id("cms")
    t = int(ts) if isinstance(ts, int) else _now()
    exec_one(
        conn,
        "INSERT INTO aiops_component_snapshots(id,instance_id,ts,ok,status,summary,details_json) VALUES(?,?,?,?,?,?,?);",
        (
            sid,
            str(instance_id or "").strip(),
            t,
            (1 if ok else 0) if isinstance(ok, bool) else None,
            str(status or "")[:80],
            str(summary or "")[:500],
            safe_json(details or {}),
        ),
    )
    return sid


def get_latest_snapshot(conn, instance_id: str) -> dict[str, Any] | None:
    return fetch_one(
        conn,
        "SELECT id,instance_id,ts,ok,status,summary,details_json FROM aiops_component_snapshots WHERE instance_id=? ORDER BY ts DESC LIMIT 1;",
        (str(instance_id or "").strip(),),
    )


def list_latest_snapshots(conn, *, limit: int = 200) -> list[dict[str, Any]]:
    """
    Best-effort latest snapshot per instance using a correlated subquery (SQLite-compatible).
    """
    n = max(1, min(500, int(limit)))
    return fetch_all(
        conn,
        """
SELECT s.id,s.instance_id,s.ts,s.ok,s.status,s.summary,s.details_json
FROM aiops_component_snapshots s
WHERE s.ts = (
  SELECT MAX(ts) FROM aiops_component_snapshots s2 WHERE s2.instance_id=s.instance_id
)
ORDER BY s.ts DESC
LIMIT ?;
""",
        (n,),
    )


def parse_config_json(raw: str) -> dict[str, Any]:
    s = str(raw or "").strip()
    if not s:
        return {}
    try:
        obj = json.loads(s)
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}

