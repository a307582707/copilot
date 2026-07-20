from __future__ import annotations

import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from .db import connect, exec_one, fetch_one, init_db
from .saas import current_user

router = APIRouter()

_DB = connect()
init_db(_DB)


def _ms() -> int:
    return int(time.time() * 1000)


def _bad(detail: str):
    raise HTTPException(status_code=400, detail=detail)


def _parse_space_id(space_id: str) -> str:
    sid = str(space_id or "").strip()
    if not sid:
        _bad("Missing spaceId")
    if len(sid) > 80:
        _bad("Invalid spaceId")
    return sid


def _coerce_space_id(space_id: str | None, tab: str | None) -> str:
    """
    Compatibility:
    - frontend uses spaceId (preferred)
    - older tests may call /api/rules/get?tab=user
    """
    sid = str(space_id or "").strip()
    if sid:
        return _parse_space_id(sid)
    t = str(tab or "").strip().lower()
    if t in {"user", "project", "cmd", "commands"}:
        return "host_config_v1"
    return _parse_space_id("host_config_v1")


@router.get("/api/rules/get")
def api_rules_get(spaceId: Optional[str] = None, tab: Optional[str] = None, u: dict = Depends(current_user)):
    uid = int(u["id"])
    sid = _coerce_space_id(spaceId, tab)
    row = fetch_one(
        _DB,
        "SELECT user_rules,project_rules,commands,updated_at FROM rules_state WHERE user_id=? AND space_id=?;",
        (uid, sid),
    )
    if not row:
        return {"ok": True, "spaceId": sid, "userRules": "", "projectRules": "", "commands": "", "updatedAt": 0}
    return {
        "ok": True,
        "spaceId": sid,
        "userRules": str(row.get("user_rules") or ""),
        "projectRules": str(row.get("project_rules") or ""),
        "commands": str(row.get("commands") or ""),
        "updatedAt": int(row.get("updated_at") or 0),
    }


@router.post("/api/rules/save")
def api_rules_save(payload: dict, u: dict = Depends(current_user)):
    uid = int(u["id"])
    sid = _coerce_space_id(payload.get("spaceId"), payload.get("tab"))
    user_rules = str(payload.get("userRules") or "")
    project_rules = str(payload.get("projectRules") or "")
    commands = str(payload.get("commands") or "")
    now = _ms()
    exec_one(
        _DB,
        "INSERT OR REPLACE INTO rules_state(user_id,space_id,user_rules,project_rules,commands,updated_at) VALUES(?,?,?,?,?,?);",
        (uid, sid, user_rules, project_rules, commands, now),
    )
    return {"ok": True, "spaceId": sid, "updatedAt": now}

