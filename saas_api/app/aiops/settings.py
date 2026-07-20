from __future__ import annotations

import time
from typing import Any

from ..db import exec_one, fetch_all, fetch_one


def _now() -> int:
    return int(time.time())


def get_setting(conn, key: str) -> str:
    k = str(key or "").strip()
    if not k:
        return ""
    row = fetch_one(conn, "SELECT value FROM aiops_settings WHERE `key`=?;", (k,))
    return str((row or {}).get("value") or "")


def set_setting(conn, *, key: str, value: str, by_user_id: int | None) -> None:
    k = str(key or "").strip()
    if not k:
        raise ValueError("missing key")
    v = str(value or "")
    now = _now()
    exist = fetch_one(conn, "SELECT `key` FROM aiops_settings WHERE `key`=?;", (k,))
    if exist:
        exec_one(
            conn,
            "UPDATE aiops_settings SET value=?, updated_at=?, updated_by=? WHERE `key`=?;",
            (v, now, int(by_user_id) if isinstance(by_user_id, int) else None, k),
        )
        return
    exec_one(
        conn,
        "INSERT INTO aiops_settings(`key`,value,updated_at,updated_by) VALUES(?,?,?,?);",
        (k, v, now, int(by_user_id) if isinstance(by_user_id, int) else None),
    )


def list_settings(conn, *, prefix: str = "") -> dict[str, str]:
    p = str(prefix or "").strip()
    if p:
        rows = fetch_all(conn, "SELECT `key`,value FROM aiops_settings WHERE `key` LIKE ? ORDER BY `key` ASC;", (p + "%",))
    else:
        rows = fetch_all(conn, "SELECT `key`,value FROM aiops_settings ORDER BY `key` ASC;", ())
    out: dict[str, str] = {}
    for r in rows:
        k = str(r.get("key") or "")
        out[k] = str(r.get("value") or "")
    return out


def mask_secret(s: str) -> str:
    v = str(s or "")
    if not v:
        return ""
    if len(v) <= 6:
        return v[:1] + "***"
    return v[:3] + "***" + v[-2:]

