from __future__ import annotations

import json
import os
import secrets

from fastapi import APIRouter, HTTPException, Request, Response

from .accounting import ms, new_id
from .db import exec_one, fetch_one
from .saas import (
    _DB,
    _is_user_disabled,
    _normalize_cn_mobile,
    _rate_limit_sms,
    _register_phone,
    serialize_user_public,
    _set_session_cookie,
    _subscription_for,
    _table_columns,
)
from .security import hash_otp, verify_otp
from .sms_aliyun import send_sms_verification

router = APIRouter()


def _auth_enabled(name: str, default: bool = True) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "y", "on"}


def _sms_login_template() -> str:
    template = (
        (os.environ.get("ALIYUN_SMS_TEMPLATE_LOGIN") or "").strip()
        or (os.environ.get("ALIYUN_SMS_TEMPLATE_BIND_PHONE") or "").strip()
        or (os.environ.get("ALIYUN_SMS_TEMPLATE_RESET_PASSWORD") or "").strip()
    )
    if not template:
        raise HTTPException(status_code=500, detail="SMS login template not configured")
    return template


def _audit(action_type: str, result: str, *, user_id: int | None, identifier: str, ip: str, ua: str, detail: dict | None = None) -> None:
    try:
        exec_one(
            _DB,
            "INSERT INTO auth_audit(id,user_id,action_type,result,identifier,ip,ua,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?);",
            (
                new_id("aua"),
                user_id,
                action_type,
                result,
                identifier,
                ip or "",
                ua or "",
                json.dumps(detail or {}, ensure_ascii=False, separators=(",", ":")),
                ms(),
            ),
        )
        _DB.commit()
    except Exception:
        try:
            _DB.rollback()
        except Exception:
            pass


async def _send_login_code(*, phone: str, ip: str, ua: str) -> None:
    _rate_limit_sms(phone, ip, "login")
    now = ms()
    code = f"{secrets.randbelow(1_000_000):06d}"
    code_hash, code_salt = hash_otp(code)
    expires = now + 5 * 60
    sms_id = exec_one(
        _DB,
        "INSERT INTO sms_codes(purpose,phone,user_id,code_hash,code_salt,ip,ua,created_at,expires_at,attempts) VALUES(?,?,?,?,?,?,?,?,?,0);",
        ("login", phone, None, code_hash, code_salt, ip or "", ua or "", now, expires),
    )
    try:
        await send_sms_verification(phone, template_code=_sms_login_template(), template_param={"code": code})
        _DB.commit()
    except Exception as exc:
        try:
            _DB.execute("DELETE FROM sms_codes WHERE id=?;", (int(sms_id),))
            _DB.commit()
        except Exception:
            pass
        raise HTTPException(status_code=502, detail=str(exc))


def _latest_login_code(phone: str) -> dict:
    row = fetch_one(
        _DB,
        "SELECT id,code_hash,code_salt,attempts,expires_at,consumed_at FROM sms_codes WHERE phone=? AND purpose='login' ORDER BY id DESC LIMIT 1;",
        (phone,),
    )
    if not row:
        raise HTTPException(status_code=400, detail="Invalid code")
    return row


def _lookup_user_by_phone(phone: str) -> dict | None:
    cols = _table_columns("users")
    fields = ["id"]
    fields.append("email" if "email" in cols else "'' AS email")
    fields.append("role" if "role" in cols else "'user' AS role")
    fields.append("status" if "status" in cols else "'active' AS status")
    fields.append("disabled" if "disabled" in cols else "0 AS disabled")
    fields.append("created_at" if "created_at" in cols else "0 AS created_at")
    fields.append("phone_verified_at" if "phone_verified_at" in cols else "NULL AS phone_verified_at")
    return fetch_one(_DB, f"SELECT {','.join(fields)} FROM users WHERE phone=?;", (phone,))


def _ensure_phone_verified(uid: int, phone: str, ip: str) -> None:
    cols = _table_columns("users")
    if "phone" not in cols:
        return
    now = ms()
    sets = ["phone=?", "updated_at=?"]
    args: list[object] = [phone, now]
    if "phone_verified_at" in cols:
        sets.insert(1, "phone_verified_at=COALESCE(phone_verified_at, ?)")
        args.insert(1, now)
    if "last_login_at" in cols:
        sets.append("last_login_at=?")
        args.append(now)
    if "last_login_ip" in cols:
        sets.append("last_login_ip=?")
        args.append(ip or "")
    args.append(uid)
    _DB.execute(f"UPDATE users SET {', '.join(sets)} WHERE id=?;", tuple(args))
    _DB.commit()


@router.post("/api/auth/login_sms/request")
async def api_auth_login_sms_request(payload: dict, request: Request):
    if not _auth_enabled("AUTH_SMS_LOGIN_ENABLED", default=True):
        raise HTTPException(status_code=404, detail="SMS login disabled")
    phone = _normalize_cn_mobile(str(payload.get("phone") or ""))
    ip = request.client.host if request.client else ""
    ua = request.headers.get("user-agent", "")
    await _send_login_code(phone=phone, ip=ip, ua=ua)
    _audit("sms_request", "ok", user_id=None, identifier=phone, ip=ip, ua=ua)
    return {"ok": True}


@router.post("/api/auth/login_sms/confirm")
def api_auth_login_sms_confirm(payload: dict, request: Request, resp: Response):
    if not _auth_enabled("AUTH_SMS_LOGIN_ENABLED", default=True):
        raise HTTPException(status_code=404, detail="SMS login disabled")
    phone = _normalize_cn_mobile(str(payload.get("phone") or ""))
    code = str(payload.get("code") or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="Missing code")

    row = _latest_login_code(phone)
    now = ms()
    if row.get("consumed_at") or int(row.get("expires_at") or 0) < now:
        raise HTTPException(status_code=400, detail="Invalid code")
    if int(row.get("attempts") or 0) >= 5:
        raise HTTPException(status_code=429, detail="Too many attempts")
    if not verify_otp(code, str(row["code_hash"]), str(row["code_salt"])):
        _DB.execute("UPDATE sms_codes SET attempts=attempts+1 WHERE id=?;", (int(row["id"]),))
        _DB.commit()
        _audit(
            "sms_confirm",
            "invalid_code",
            user_id=None,
            identifier=phone,
            ip=request.client.host if request.client else "",
            ua=request.headers.get("user-agent", ""),
        )
        raise HTTPException(status_code=400, detail="Invalid code")

    _DB.execute("UPDATE sms_codes SET consumed_at=? WHERE id=?;", (now, int(row["id"])))
    user = _lookup_user_by_phone(phone)
    if user is None:
        user = _register_phone(phone, secrets.token_urlsafe(24))
    else:
        if _is_user_disabled(user):
            raise HTTPException(status_code=403, detail="Account disabled")
        _ensure_phone_verified(int(user["id"]), phone, request.client.host if request.client else "")
        user = serialize_user_public(int(user["id"]))
    _DB.commit()

    uid = int(user["id"])
    _set_session_cookie(resp, uid, str(user["role"]))
    _audit(
        "sms_confirm",
        "ok",
        user_id=uid,
        identifier=phone,
        ip=request.client.host if request.client else "",
        ua=request.headers.get("user-agent", ""),
    )
    return {"ok": True, "user": user, "subscription": _subscription_for(uid)}
