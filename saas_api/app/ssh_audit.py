from __future__ import annotations

import json
import secrets
import threading
import time
from typing import Any

from .db import connect, init_db


def _now_ms() -> int:
    return int(time.time() * 1000)


def _s(v: Any, *, limit: int) -> str | None:
    if v is None:
        return None
    try:
        s = str(v).strip()
    except Exception:
        return None
    if not s:
        return None
    if len(s) > limit:
        s = s[:limit] + "…"
    return s


def _i(v: Any) -> int | None:
    try:
        if v is None:
            return None
        return int(v)
    except Exception:
        return None


_LOCK = threading.Lock()
_DB = connect()
init_db(_DB)


def new_event_id(prefix: str = "audit_") -> str:
    return str(prefix or "audit_") + secrets.token_urlsafe(12)


def record_event(
    *,
    event_id: str | None,
    user_id: int,
    session_id: str | None,
    event_type: str,
    host: dict[str, Any] | None = None,
    cwd: str | None = None,
    path: str | None = None,
    cmd: str | None = None,
    ok: bool | None = None,
    exit_code: int | None = None,
    timed_out: bool | None = None,
    stdout_len: int | None = None,
    stderr_len: int | None = None,
    started_at_ms: int | None = None,
    finished_at_ms: int | None = None,
    duration_ms: int | None = None,
    error: str | None = None,
    meta: dict[str, Any] | None = None,
) -> str:
    """
    Best-effort audit write.
    Never blocks user operations (exceptions are swallowed after printing).
    """
    eid = (event_id or "").strip() or new_event_id("audit_")
    uid = int(user_id)
    sid = _s(session_id, limit=80)
    et = _s(event_type, limit=40) or "unknown"

    asset_name = None
    ssh_target = None
    try:
        if isinstance(host, dict):
            address = _s(host.get("address"), limit=200) or ""
            port = _i(host.get("port")) or 22
            username = _s(host.get("username"), limit=120) or ""
            # optional inventory label (frontend host config)
            asset_name = _s(host.get("asset_name") or host.get("name"), limit=160)
            if address:
                ssh_target = f"{username or 'root'}@{address}:{port}"
    except Exception:
        asset_name = asset_name
        ssh_target = ssh_target

    started = int(started_at_ms) if isinstance(started_at_ms, int) else _now_ms()
    finished = int(finished_at_ms) if isinstance(finished_at_ms, int) else None
    dur = int(duration_ms) if isinstance(duration_ms, int) else (max(0, finished - started) if finished else None)

    row = {
        "id": eid,
        "user_id": uid,
        "session_id": sid,
        "event_type": et,
        "asset_name": _s(asset_name, limit=160),
        "ssh_target": _s(ssh_target, limit=240),
        "cwd": _s(cwd, limit=800),
        "path": _s(path, limit=1600),
        "cmd": _s(cmd, limit=4000),
        "ok": 1 if ok is True else 0 if ok is False else None,
        "exit_code": _i(exit_code),
        "timed_out": 1 if timed_out else 0 if timed_out is False else None,
        "stdout_len": _i(stdout_len),
        "stderr_len": _i(stderr_len),
        "started_at": int(started),
        "finished_at": int(finished) if finished is not None else None,
        "duration_ms": int(dur) if dur is not None else None,
        "error": _s(error, limit=800),
        "meta_json": None,
    }
    try:
        if isinstance(meta, dict) and meta:
            row["meta_json"] = _s(json.dumps(meta, ensure_ascii=False, sort_keys=True), limit=4000)
    except Exception:
        row["meta_json"] = None

    try:
        with _LOCK:
            _DB.execute(
                """
INSERT OR REPLACE INTO ssh_audit(
  id,user_id,session_id,event_type,asset_name,ssh_target,cwd,path,cmd,ok,exit_code,timed_out,stdout_len,stderr_len,started_at,finished_at,duration_ms,error,meta_json
) VALUES (
  :id,:user_id,:session_id,:event_type,:asset_name,:ssh_target,:cwd,:path,:cmd,:ok,:exit_code,:timed_out,:stdout_len,:stderr_len,:started_at,:finished_at,:duration_ms,:error,:meta_json
)
""",
                row,
            )
            _DB.commit()
    except Exception as e:  # noqa: BLE001
        try:
            print(
                json.dumps(
                    {"t": "audit_write_failed", "id": eid, "event_type": et, "err": e.__class__.__name__},
                    ensure_ascii=False,
                )
            )
        except Exception:
            pass

    # Structured log line (best-effort)
    try:
        log = dict(row)
        log["t"] = "ssh_audit"
        print(json.dumps(log, ensure_ascii=False))
    except Exception:
        pass

    return eid

