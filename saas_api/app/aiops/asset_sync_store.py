from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import Any

from ..accounting import new_id
from ..db import exec_one, fetch_all, fetch_one


def _now() -> int:
    return int(time.time())


def _to_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        return v != 0
    return str(v or "").strip() in {"1", "true", "yes", "y", "on"}


def _cron_values(field: str, *, min_v: int, max_v: int) -> set[int]:
    s = str(field or "").strip()
    if not s or s == "*":
        return set(range(min_v, max_v + 1))
    out: set[int] = set()
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        if part == "*":
            out.update(range(min_v, max_v + 1))
            continue
        if part.startswith("*/"):
            step = int(part[2:] or "1")
            step = max(1, step)
            out.update(range(min_v, max_v + 1, step))
            continue
        if "-" in part:
            a_raw, b_raw = part.split("-", 1)
            a = max(min_v, min(max_v, int(a_raw)))
            b = max(min_v, min(max_v, int(b_raw)))
            if a <= b:
                out.update(range(a, b + 1))
            continue
        val = int(part)
        if min_v <= val <= max_v:
            out.add(val)
    if not out:
        raise ValueError("invalid cron field")
    return out


def next_cron_ts(cron_expr: str, *, base_ts: int | None = None) -> int:
    raw = str(cron_expr or "").strip()
    parts = raw.split()
    if len(parts) != 5:
        raise ValueError("cron_expr must have 5 fields")
    minute_set = _cron_values(parts[0], min_v=0, max_v=59)
    hour_set = _cron_values(parts[1], min_v=0, max_v=23)
    dom_set = _cron_values(parts[2], min_v=1, max_v=31)
    month_set = _cron_values(parts[3], min_v=1, max_v=12)
    dow_set = _cron_values(parts[4], min_v=0, max_v=6)

    base = datetime.utcfromtimestamp(int(base_ts if isinstance(base_ts, int) else _now()))
    cur = base.replace(second=0, microsecond=0) + timedelta(minutes=1)
    limit = cur + timedelta(days=370)
    while cur <= limit:
        py_dow = (cur.weekday() + 1) % 7  # cron: Sunday=0
        if (
            cur.minute in minute_set
            and cur.hour in hour_set
            and cur.day in dom_set
            and cur.month in month_set
            and py_dow in dow_set
        ):
            return int(cur.timestamp())
        cur += timedelta(minutes=1)
    raise ValueError("no next run time found for cron_expr")


def create_sync_run(
    conn,
    *,
    cloud_account_key: str,
    cli_account_id: str,
    region: str,
    trigger_mode: str,
    triggered_by: int | None,
) -> str:
    run_id = new_id("asrun")
    now = _now()
    exec_one(
        conn,
        """
INSERT INTO aiops_asset_sync_runs(id,cloud_account_key,cli_account_id,region,trigger_mode,status,triggered_by,created_at)
VALUES(?,?,?,?,?,?,?,?);
""",
        (
            run_id,
            str(cloud_account_key or "").strip()[:80],
            str(cli_account_id or "").strip()[:120],
            str(region or "all").strip()[:80] or "all",
            str(trigger_mode or "manual").strip()[:40] or "manual",
            "queued",
            int(triggered_by) if isinstance(triggered_by, int) else None,
            now,
        ),
    )
    return run_id


def update_sync_run(
    conn,
    run_id: str,
    *,
    status: str | None = None,
    started_at: int | None = None,
    finished_at: int | None = None,
    summary: str | None = None,
    error: str | None = None,
) -> None:
    rid = str(run_id or "").strip()
    if not rid:
        raise ValueError("missing run_id")
    row = fetch_one(conn, "SELECT id FROM aiops_asset_sync_runs WHERE id=?;", (rid,))
    if not row:
        raise ValueError("sync run not found")
    sets: list[str] = []
    args: list[Any] = []
    if status is not None:
        sets.append("status=?")
        args.append(str(status or "").strip()[:40])
    if isinstance(started_at, int):
        sets.append("started_at=?")
        args.append(int(started_at))
    if isinstance(finished_at, int):
        sets.append("finished_at=?")
        args.append(int(finished_at))
    if summary is not None:
        sets.append("summary=?")
        args.append(str(summary or "")[:1000])
    if error is not None:
        sets.append("error=?")
        args.append(str(error or "")[:4000])
    if not sets:
        return
    args.append(rid)
    exec_one(conn, "UPDATE aiops_asset_sync_runs SET " + ", ".join(sets) + " WHERE id=?;", tuple(args))


def get_sync_run(conn, run_id: str) -> dict[str, Any] | None:
    row = fetch_one(
        conn,
        """
SELECT id,cloud_account_key,cli_account_id,region,trigger_mode,status,started_at,finished_at,summary,error,triggered_by,created_at
FROM aiops_asset_sync_runs
WHERE id=?
LIMIT 1;
""",
        (str(run_id or "").strip(),),
    )
    return row


def list_sync_runs(conn, *, limit: int = 20, cloud_account_key: str = "", status: str = "") -> list[dict[str, Any]]:
    n = max(1, min(200, int(limit)))
    account = str(cloud_account_key or "").strip()
    st = str(status or "").strip()
    where = []
    args: list[Any] = []
    if account:
        where.append("cloud_account_key=?")
        args.append(account)
    if st:
        where.append("status=?")
        args.append(st)
    sql = """
SELECT id,cloud_account_key,cli_account_id,region,trigger_mode,status,started_at,finished_at,summary,error,triggered_by,created_at
FROM aiops_asset_sync_runs
"""
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC LIMIT ?;"
    args.append(n)
    return fetch_all(conn, sql, tuple(args))


def find_active_sync_run(conn, *, cloud_account_key: str, cli_account_id: str, region: str) -> dict[str, Any] | None:
    return fetch_one(
        conn,
        """
SELECT id,cloud_account_key,cli_account_id,region,trigger_mode,status,started_at,finished_at,summary,error,triggered_by,created_at
FROM aiops_asset_sync_runs
WHERE cloud_account_key=? AND cli_account_id=? AND region=? AND status IN ('queued','running')
ORDER BY created_at DESC
LIMIT 1;
""",
        (
            str(cloud_account_key or "").strip(),
            str(cli_account_id or "").strip(),
            str(region or "all").strip() or "all",
        ),
    )


def upsert_sync_schedule(
    conn,
    *,
    schedule_id: str = "",
    cloud_account_key: str,
    cli_account_id: str,
    region: str,
    cron_expr: str,
    enabled: bool,
    updated_by: int | None,
) -> str:
    now = _now()
    sid = str(schedule_id or "").strip() or new_id("assch")
    next_run_at = next_cron_ts(cron_expr, base_ts=now) if enabled else None
    exists = fetch_one(conn, "SELECT id FROM aiops_asset_sync_schedules WHERE id=?;", (sid,))
    if exists:
        exec_one(
            conn,
            """
UPDATE aiops_asset_sync_schedules
SET cloud_account_key=?, cli_account_id=?, region=?, cron_expr=?, enabled=?, next_run_at=?, updated_by=?, updated_at=?
WHERE id=?;
""",
            (
                str(cloud_account_key or "").strip()[:80],
                str(cli_account_id or "").strip()[:120],
                str(region or "all").strip()[:80] or "all",
                str(cron_expr or "").strip()[:120],
                1 if enabled else 0,
                int(next_run_at) if isinstance(next_run_at, int) else None,
                int(updated_by) if isinstance(updated_by, int) else None,
                now,
                sid,
            ),
        )
        return sid
    exec_one(
        conn,
        """
INSERT INTO aiops_asset_sync_schedules(id,cloud_account_key,cli_account_id,region,cron_expr,enabled,last_run_id,last_run_at,next_run_at,updated_by,created_at,updated_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?);
""",
        (
            sid,
            str(cloud_account_key or "").strip()[:80],
            str(cli_account_id or "").strip()[:120],
            str(region or "all").strip()[:80] or "all",
            str(cron_expr or "").strip()[:120],
            1 if enabled else 0,
            None,
            None,
            int(next_run_at) if isinstance(next_run_at, int) else None,
            int(updated_by) if isinstance(updated_by, int) else None,
            now,
            now,
        ),
    )
    return sid


def list_sync_schedules(conn, *, enabled_only: bool = False) -> list[dict[str, Any]]:
    sql = """
SELECT id,cloud_account_key,cli_account_id,region,cron_expr,enabled,last_run_id,last_run_at,next_run_at,updated_by,created_at,updated_at
FROM aiops_asset_sync_schedules
"""
    args: tuple[Any, ...] = ()
    if enabled_only:
        sql += " WHERE enabled=1"
    sql += " ORDER BY updated_at DESC, created_at DESC;"
    rows = fetch_all(conn, sql, args)
    for row in rows:
        row["enabled"] = _to_bool(row.get("enabled"))
    return rows


def get_sync_schedule(conn, schedule_id: str) -> dict[str, Any] | None:
    row = fetch_one(
        conn,
        """
SELECT id,cloud_account_key,cli_account_id,region,cron_expr,enabled,last_run_id,last_run_at,next_run_at,updated_by,created_at,updated_at
FROM aiops_asset_sync_schedules
WHERE id=?
LIMIT 1;
""",
        (str(schedule_id or "").strip(),),
    )
    if row:
        row["enabled"] = _to_bool(row.get("enabled"))
    return row


def delete_sync_schedule(conn, schedule_id: str) -> None:
    exec_one(conn, "DELETE FROM aiops_asset_sync_schedules WHERE id=?;", (str(schedule_id or "").strip(),))


def list_due_schedules(conn, *, now_ts: int | None = None) -> list[dict[str, Any]]:
    now = int(now_ts if isinstance(now_ts, int) else _now())
    rows = fetch_all(
        conn,
        """
SELECT id,cloud_account_key,cli_account_id,region,cron_expr,enabled,last_run_id,last_run_at,next_run_at,updated_by,created_at,updated_at
FROM aiops_asset_sync_schedules
WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?
ORDER BY next_run_at ASC, updated_at ASC;
""",
        (now,),
    )
    for row in rows:
        row["enabled"] = _to_bool(row.get("enabled"))
    return rows


def mark_schedule_enqueued(conn, *, schedule_id: str, run_id: str, now_ts: int | None = None) -> None:
    now = int(now_ts if isinstance(now_ts, int) else _now())
    row = get_sync_schedule(conn, schedule_id)
    if not row:
        raise ValueError("schedule not found")
    next_run_at = next_cron_ts(str(row.get("cron_expr") or ""), base_ts=now) if _to_bool(row.get("enabled")) else None
    exec_one(
        conn,
        """
UPDATE aiops_asset_sync_schedules
SET last_run_id=?, last_run_at=?, next_run_at=?, updated_at=?
WHERE id=?;
""",
        (
            str(run_id or "").strip()[:120],
            now,
            int(next_run_at) if isinstance(next_run_at, int) else None,
            now,
            str(schedule_id or "").strip(),
        ),
    )
