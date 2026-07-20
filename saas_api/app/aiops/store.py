from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from ..db import exec_one, fetch_all, fetch_one
from ..accounting import new_id
from .inspect_types import InspectionStatus
from .types import NormalizedAlert, Severity, safe_json


def _ms() -> int:
    return int(time.time() * 1000)


def ensure_tables(conn: sqlite3.Connection) -> None:
    # Tables are created in db.init_db; this is only a safety net.
    _ = conn


def get_incident_row(conn: sqlite3.Connection, incident_id: str) -> dict[str, Any] | None:
    return fetch_one(conn, "SELECT * FROM aiops_incidents WHERE id=?;", (incident_id,))


def is_silenced(conn: sqlite3.Connection, incident_id: str) -> bool:
    row = get_incident_row(conn, incident_id)
    if not row:
        return False
    meta_raw = str(row.get("meta_json") or "{}")
    try:
        meta = json.loads(meta_raw) if meta_raw else {}
        if not isinstance(meta, dict):
            return False
    except Exception:
        return False
    until = meta.get("silenced_until")
    if isinstance(until, int) and until > 0:
        return int(time.time()) < until
    return False


def set_silence(conn: sqlite3.Connection, incident_id: str, *, seconds: int, by_user_id: int | None) -> None:
    row = get_incident_row(conn, incident_id)
    if not row:
        raise ValueError("incident not found")
    meta_raw = str(row.get("meta_json") or "{}")
    try:
        meta = json.loads(meta_raw) if meta_raw else {}
        if not isinstance(meta, dict):
            meta = {}
    except Exception:
        meta = {}
    now = int(time.time())
    until = now + max(60, min(24 * 3600, int(seconds)))
    meta["silenced_until"] = until
    if isinstance(by_user_id, int):
        meta["silenced_by"] = by_user_id
    meta["silenced_at"] = now
    exec_one(conn, "UPDATE aiops_incidents SET meta_json=?, updated_at=? WHERE id=?;", (safe_json(meta), now, incident_id))


def upsert_incident_from_alert(conn: sqlite3.Connection, a: NormalizedAlert) -> tuple[str, bool]:
    """
    Dedup policy (MVP):
    - Active incident keyed by fingerprint.
    - If an incident is resolved, create a new incident for new alerts.
    """
    fp = a.fingerprint
    row = fetch_one(
        conn,
        "SELECT id,status FROM aiops_incidents WHERE fingerprint=? ORDER BY updated_at DESC LIMIT 1;",
        (fp,),
    )
    if row and str(row.get("status") or "") != "resolved":
        inc_id = str(row["id"])
        return inc_id, False

    inc_id = new_id("inc")
    now = int(time.time())
    labels_json = safe_json(a.labels)
    meta_json = safe_json({"annotations": a.annotations, "source": a.source})
    exec_one(
        conn,
        "INSERT INTO aiops_incidents(id,status,severity,title,fingerprint,source,labels_json,meta_json,started_at,created_at,updated_at,last_event_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?);",
        (
            inc_id,
            "triage",
            a.severity,
            a.title,
            fp,
            a.source,
            labels_json,
            meta_json,
            int(a.starts_at or now),
            now,
            now,
            now,
        ),
    )
    return inc_id, True


def insert_event(conn: sqlite3.Connection, incident_id: str, a: NormalizedAlert) -> str:
    eid = new_id("aie")
    now = int(time.time())
    exec_one(
        conn,
        "INSERT INTO aiops_events(id,incident_id,source,severity,title,description,fingerprint,starts_at,ends_at,received_at,labels_json,annotations_json,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?);",
        (
            eid,
            incident_id,
            a.source,
            a.severity,
            a.title,
            a.description,
            a.fingerprint,
            int(a.starts_at or 0) or None,
            int(a.ends_at or 0) or None,
            now,
            safe_json(a.labels),
            safe_json(a.annotations),
            safe_json(a.raw),
        ),
    )
    exec_one(
        conn,
        "UPDATE aiops_incidents SET severity=?, title=?, updated_at=?, last_event_at=? WHERE id=?;",
        (
            _max_severity(conn, incident_id, a.severity),
            a.title,
            now,
            now,
            incident_id,
        ),
    )
    return eid


def _sev_rank(s: str) -> int:
    x = (s or "").strip().lower()
    if x == "critical":
        return 3
    if x == "warn":
        return 2
    return 1


def _max_severity(conn: sqlite3.Connection, incident_id: str, incoming: Severity) -> Severity:
    row = fetch_one(conn, "SELECT severity FROM aiops_incidents WHERE id=?;", (incident_id,))
    cur = str((row or {}).get("severity") or "info").strip().lower()
    inc = str(incoming or "info").strip().lower()
    return "critical" if max(_sev_rank(cur), _sev_rank(inc)) == 3 else "warn" if max(_sev_rank(cur), _sev_rank(inc)) == 2 else "info"


def add_evidence(conn: sqlite3.Connection, incident_id: str, *, kind: str, title: str, content: str, created_by: int | None, meta: dict[str, Any] | None) -> str:
    evid = new_id("aiv")
    now = int(time.time())
    exec_one(
        conn,
        "INSERT INTO aiops_evidence(id,incident_id,kind,title,content,created_by,created_at,meta_json) VALUES(?,?,?,?,?,?,?,?);",
        (
            evid,
            incident_id,
            str(kind or "text")[:40],
            str(title or "")[:200],
            str(content or "")[:200_000],
            int(created_by) if isinstance(created_by, int) else None,
            now,
            safe_json(meta or {}),
        ),
    )
    exec_one(conn, "UPDATE aiops_incidents SET updated_at=? WHERE id=?;", (now, incident_id))
    return evid


def list_incidents(conn: sqlite3.Connection, *, limit: int = 50) -> list[dict[str, Any]]:
    n = max(1, min(200, int(limit)))
    return fetch_all(
        conn,
        "SELECT id,status,severity,title,fingerprint,source,started_at,created_at,updated_at,last_event_at,resolved_at FROM aiops_incidents ORDER BY last_event_at DESC, updated_at DESC LIMIT ?;",
        (n,),
    )


def get_incident(conn: sqlite3.Connection, incident_id: str) -> dict[str, Any] | None:
    inc = fetch_one(conn, "SELECT * FROM aiops_incidents WHERE id=?;", (incident_id,))
    if not inc:
        return None
    events = fetch_all(
        conn,
        "SELECT id,source,severity,title,description,starts_at,ends_at,received_at,labels_json,annotations_json FROM aiops_events WHERE incident_id=? ORDER BY received_at DESC LIMIT 200;",
        (incident_id,),
    )
    evidence = fetch_all(
        conn,
        "SELECT id,kind,title,content,created_by,created_at,meta_json FROM aiops_evidence WHERE incident_id=? ORDER BY created_at DESC LIMIT 200;",
        (incident_id,),
    )
    actions = fetch_all(
        conn,
        "SELECT id,kind,title,risk,status,decision_json,created_by,created_at,approved_by,approved_at,started_at,finished_at,exit_code,error FROM aiops_actions WHERE incident_id=? ORDER BY created_at DESC LIMIT 200;",
        (incident_id,),
    )
    return {"incident": inc, "events": events, "evidence": evidence, "actions": actions}


def transition_incident(conn: sqlite3.Connection, incident_id: str, *, status: str, resolved: bool = False) -> None:
    st = str(status or "").strip().lower()
    if st not in {"triage", "investigating", "mitigating", "verifying", "resolved"}:
        raise ValueError("invalid status")
    now = int(time.time())
    row = fetch_one(conn, "SELECT status FROM aiops_incidents WHERE id=?;", (incident_id,))
    if not row:
        raise ValueError("incident not found")
    cur = str(row.get("status") or "").strip().lower()
    if cur not in {"triage", "investigating", "mitigating", "verifying", "resolved"}:
        cur = "triage"

    # State machine (MVP strong constraint)
    allowed_next = {
        "triage": {"investigating", "resolved"},
        "investigating": {"mitigating", "verifying", "resolved"},
        "mitigating": {"verifying", "resolved"},
        "verifying": {"resolved", "investigating"},  # allow fallback
        "resolved": {"triage"},  # reopen via new incident normally; manual reopen uses triage
    }
    if st not in allowed_next.get(cur, set()):
        raise ValueError(f"invalid transition: {cur} -> {st}")

    resolved_at = now if resolved or st == "resolved" else None
    exec_one(conn, "UPDATE aiops_incidents SET status=?, updated_at=?, resolved_at=? WHERE id=?;", (st, now, resolved_at, incident_id))


def create_action(
    conn: sqlite3.Connection,
    *,
    incident_id: str,
    kind: str,
    title: str,
    risk: str,
    runbook: dict[str, Any] | None,
    created_by: int | None,
    decision: dict[str, Any] | None,
    status: str = "proposed",
) -> str:
    aid = new_id("aia")
    now = int(time.time())
    exec_one(
        conn,
        "INSERT INTO aiops_actions(id,incident_id,kind,title,risk,status,runbook_json,decision_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?);",
        (
            aid,
            incident_id,
            str(kind or "")[:80],
            str(title or "")[:200],
            str(risk or "high")[:16],
            str(status or "proposed")[:32],
            safe_json(runbook or {}),
            safe_json(decision or {}),
            int(created_by) if isinstance(created_by, int) else None,
            now,
        ),
    )
    exec_one(conn, "UPDATE aiops_incidents SET updated_at=? WHERE id=?;", (now, incident_id))
    return aid


def update_action_status(conn: sqlite3.Connection, action_id: str, *, status: str, fields: dict[str, Any] | None = None) -> None:
    st = str(status or "").strip().lower()
    now = int(time.time())
    f = fields or {}
    # Keep it simple (MVP)
    exec_one(
        conn,
        "UPDATE aiops_actions SET status=?, updated_at=?, approved_by=COALESCE(?, approved_by), approved_at=COALESCE(?, approved_at), started_at=COALESCE(?, started_at), finished_at=COALESCE(?, finished_at), exit_code=COALESCE(?, exit_code), error=COALESCE(?, error) WHERE id=?;",
        (
            st,
            now,
            f.get("approved_by"),
            f.get("approved_at"),
            f.get("started_at"),
            f.get("finished_at"),
            f.get("exit_code"),
            f.get("error"),
            action_id,
        ),
    )


def get_action(conn: sqlite3.Connection, action_id: str) -> dict[str, Any] | None:
    return fetch_one(conn, "SELECT * FROM aiops_actions WHERE id=?;", (action_id,))


def compute_kpis(conn: sqlite3.Connection) -> dict[str, Any]:
    # Best-effort: derive KPIs from stored data
    rows = fetch_all(conn, "SELECT status, COUNT(1) as c FROM aiops_incidents GROUP BY status;", ())
    by_status = {str(r["status"]): int(r["c"] or 0) for r in rows}
    act = fetch_all(conn, "SELECT status, COUNT(1) as c FROM aiops_actions GROUP BY status;", ())
    act_by_status = {str(r["status"]): int(r["c"] or 0) for r in act}
    return {"incidents": by_status, "actions": act_by_status}


def compute_metrics(conn: sqlite3.Connection) -> dict[str, Any]:
    """
    MVP metrics for SRE validation:
    - MTTR (avg) for resolved incidents
    - MTTD (avg) as (first_received_at - started_at) when started_at is known
    - Evidence completeness rate: incidents with >=1 evidence (excluding 'audit') and >=1 event
    - Autopilot success rate for low-risk evidence collection actions
    """
    # MTTR
    rows = fetch_all(
        conn,
        "SELECT started_at,resolved_at FROM aiops_incidents WHERE resolved_at IS NOT NULL AND started_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 500;",
        (),
    )
    mttr_vals: list[int] = []
    for r in rows:
        sa = r.get("started_at")
        ra = r.get("resolved_at")
        if isinstance(sa, int) and isinstance(ra, int) and ra >= sa:
            mttr_vals.append(int(ra - sa))
    mttr_avg = int(sum(mttr_vals) / len(mttr_vals)) if mttr_vals else None

    # MTTD
    r2 = fetch_all(
        conn,
        """
SELECT i.id as id, i.started_at as started_at, MIN(e.received_at) as first_received
FROM aiops_incidents i
JOIN aiops_events e ON e.incident_id=i.id
WHERE i.started_at IS NOT NULL
GROUP BY i.id
ORDER BY first_received DESC
LIMIT 500;
""",
        (),
    )
    mttd_vals: list[int] = []
    for r in r2:
        sa = r.get("started_at")
        fr = r.get("first_received")
        if isinstance(sa, int) and isinstance(fr, int) and fr >= sa:
            mttd_vals.append(int(fr - sa))
    mttd_avg = int(sum(mttd_vals) / len(mttd_vals)) if mttd_vals else None

    # Evidence completeness
    total_inc = fetch_one(conn, "SELECT COUNT(1) as c FROM aiops_incidents;", ()) or {"c": 0}
    total = int(total_inc.get("c") or 0)
    ok_cnt = fetch_one(
        conn,
        """
SELECT COUNT(1) as c
FROM aiops_incidents i
WHERE
  EXISTS(SELECT 1 FROM aiops_events e WHERE e.incident_id=i.id)
  AND EXISTS(SELECT 1 FROM aiops_evidence v WHERE v.incident_id=i.id AND v.kind!='audit');
""",
        (),
    ) or {"c": 0}
    complete = int(ok_cnt.get("c") or 0)
    completeness = (complete / total) if total > 0 else None

    # Autopilot success rate (collect evidence action)
    a = fetch_all(
        conn,
        "SELECT status, COUNT(1) as c FROM aiops_actions WHERE kind='collect_evidence_basic' GROUP BY status;",
        (),
    )
    a_map = {str(x.get("status") or ""): int(x.get("c") or 0) for x in a}
    succ = a_map.get("succeeded", 0)
    fail = a_map.get("failed", 0)
    denom = succ + fail
    autopilot_success = (succ / denom) if denom > 0 else None

    return {
        "mttr_avg_sec": mttr_avg,
        "mttd_avg_sec": mttd_avg,
        "evidence_completeness": completeness,
        "autopilot_success": autopilot_success,
        "counts": {"incidents_total": total, "evidence_complete": complete, "autopilot": a_map},
    }


# --- Inspection Agent (first-class) ---


def upsert_inspection_def(
    conn: sqlite3.Connection,
    *,
    def_id: str,
    name: str,
    kind: str,
    env_id: str,
    env_json: dict[str, Any],
    runner: dict[str, Any] | None,
    schedule: dict[str, Any] | None,
    enabled: bool,
    created_by: int | None,
) -> str:
    did = str(def_id or "").strip()
    if not did:
        did = new_id("insdef")
    now = int(time.time())
    exist = fetch_one(conn, "SELECT id FROM aiops_inspection_defs WHERE id=?;", (did,))
    if exist:
        exec_one(
            conn,
            "UPDATE aiops_inspection_defs SET name=?,kind=?,env_id=?,env_json=?,runner_json=?,schedule_json=?,enabled=?,updated_at=? WHERE id=?;",
            (
                str(name or "")[:200],
                str(kind or "")[:80],
                str(env_id or "")[:80],
                safe_json(env_json or {}),
                safe_json(runner or {}),
                safe_json(schedule or {}),
                1 if enabled else 0,
                now,
                did,
            ),
        )
        return did
    exec_one(
        conn,
        "INSERT INTO aiops_inspection_defs(id,name,kind,env_id,env_json,runner_json,schedule_json,enabled,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?);",
        (
            did,
            str(name or "")[:200],
            str(kind or "")[:80],
            str(env_id or "")[:80],
            safe_json(env_json or {}),
            safe_json(runner or {}),
            safe_json(schedule or {}),
            1 if enabled else 0,
            int(created_by) if isinstance(created_by, int) else None,
            now,
            now,
        ),
    )
    return did


def list_inspection_defs(conn: sqlite3.Connection, *, limit: int = 50) -> list[dict[str, Any]]:
    n = max(1, min(200, int(limit)))
    return fetch_all(
        conn,
        "SELECT id,name,kind,env_id,enabled,created_by,created_at,updated_at FROM aiops_inspection_defs ORDER BY updated_at DESC LIMIT ?;",
        (n,),
    )


def get_inspection_def(conn: sqlite3.Connection, def_id: str) -> dict[str, Any] | None:
    return fetch_one(conn, "SELECT * FROM aiops_inspection_defs WHERE id=?;", (str(def_id or "").strip(),))


def create_inspection_run(
    conn: sqlite3.Connection,
    *,
    def_id: str,
    env_id: str,
    correlation_id: str | None,
    triggered_by: int | None,
) -> str:
    rid = new_id("insrun")
    now = int(time.time())
    exec_one(
        conn,
        "INSERT INTO aiops_inspection_runs(id,def_id,env_id,status,correlation_id,triggered_by,created_at) VALUES(?,?,?,?,?,?,?);",
        (
            rid,
            str(def_id or "").strip(),
            str(env_id or "").strip()[:80],
            "queued",
            str(correlation_id).strip()[:160] if correlation_id else None,
            int(triggered_by) if isinstance(triggered_by, int) else None,
            now,
        ),
    )
    return rid


def update_inspection_run(
    conn: sqlite3.Connection,
    run_id: str,
    *,
    status: InspectionStatus | None = None,
    started_at: int | None = None,
    finished_at: int | None = None,
    ok: bool | None = None,
    summary: str | None = None,
    report_json: str | None = None,
    incident_ids: list[str] | None = None,
    error: str | None = None,
) -> None:
    # MVP: keep it simple, update only provided fields.
    row = fetch_one(conn, "SELECT id FROM aiops_inspection_runs WHERE id=?;", (str(run_id or "").strip(),))
    if not row:
        raise ValueError("run not found")
    _ = int(time.time())
    sets: list[str] = []
    args: list[Any] = []

    if status:
        sets.append("status=?")
        args.append(str(status))
    if isinstance(started_at, int):
        sets.append("started_at=?")
        args.append(int(started_at))
    if isinstance(finished_at, int):
        sets.append("finished_at=?")
        args.append(int(finished_at))
    if isinstance(ok, bool):
        sets.append("ok=?")
        args.append(1 if ok else 0)
    if summary is not None:
        sets.append("summary=?")
        args.append(str(summary)[:500])
    if report_json is not None:
        sets.append("report_json=?")
        args.append(str(report_json)[:200_000])
    if incident_ids is not None:
        sets.append("incident_ids_json=?")
        args.append(safe_json(incident_ids))
    if error is not None:
        sets.append("error=?")
        args.append(str(error)[:500])

    if not sets:
        return
    sql = "UPDATE aiops_inspection_runs SET " + ", ".join(sets) + " WHERE id=?;"
    args.append(str(run_id or "").strip())
    exec_one(conn, sql, tuple(args))


def list_inspection_runs(conn: sqlite3.Connection, *, env_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    n = max(1, min(200, int(limit)))
    env = str(env_id or "").strip()
    if env:
        return fetch_all(
            conn,
            "SELECT id,def_id,env_id,status,correlation_id,triggered_by,created_at,started_at,finished_at,ok,summary,error FROM aiops_inspection_runs WHERE env_id=? ORDER BY created_at DESC LIMIT ?;",
            (env, n),
        )
    return fetch_all(
        conn,
        "SELECT id,def_id,env_id,status,correlation_id,triggered_by,created_at,started_at,finished_at,ok,summary,error FROM aiops_inspection_runs ORDER BY created_at DESC LIMIT ?;",
        (n,),
    )


def get_inspection_run(conn: sqlite3.Connection, run_id: str) -> dict[str, Any] | None:
    return fetch_one(conn, "SELECT * FROM aiops_inspection_runs WHERE id=?;", (str(run_id or "").strip(),))

