from __future__ import annotations

import logging
import os
import re
import sqlite3
import secrets
import time
import base64
import hashlib
import hmac
from typing import Optional

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from sqlalchemy.exc import SQLAlchemyError
from fastapi.responses import FileResponse
from starlette.requests import Request
from pathlib import Path

from .accounting import (
    admin_stats,
    beta_initial_credit_cents,
    beta_mode_enabled,
    beta_quota_status,
    ensure_beta_credit,
    get_user_balance_cents,
    mask_email,
    ms,
    new_id,
    trial_days,
)
from .db import connect, exec_one, fetch_all, fetch_one, init_db
from .security import hash_otp, hash_password, sign_token, verify_otp, verify_password, verify_token
from .sms_aliyun import send_sms_verification

router = APIRouter()
_log = logging.getLogger(__name__)

_DB = connect()
init_db(_DB)

SESSION_COOKIE = (os.environ.get("SESSION_COOKIE_NAME") or "codesprite_session").strip() or "codesprite_session"
_TABLE_COLUMNS_CACHE: dict[str, set[str]] = {}


def _cookie_secure() -> bool:
    v = (os.environ.get("COOKIE_SECURE") or "").strip().lower()
    return v in {"1", "true", "yes", "y", "on"}


def _set_session_cookie(resp: Response, user_id: int, role: str) -> None:
    token = sign_token({"uid": user_id, "role": role}, expires_in_sec=14 * 24 * 3600)
    resp.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
        path="/",
        max_age=14 * 24 * 3600,
    )


def _clear_session_cookie(resp: Response) -> None:
    resp.delete_cookie(key=SESSION_COOKIE, path="/")


def _table_columns(table: str) -> set[str]:
    cached = _TABLE_COLUMNS_CACHE.get(table)
    if cached is not None:
        return cached
    try:
        if _DB.kind == "sqlite":
            rows = fetch_all(_DB, f"PRAGMA table_info({table});", ())
            cols = {str(r.get("name") or "").strip() for r in rows if str(r.get("name") or "").strip()}
        else:
            safe_table = "".join(ch for ch in str(table) if ch.isalnum() or ch == "_")
            if safe_table != table:
                cols = set()
            else:
                rows = fetch_all(_DB, f"SHOW COLUMNS FROM `{safe_table}`;", ())
                cols = {str(r.get("Field") or "").strip() for r in rows if str(r.get("Field") or "").strip()}
    except Exception:
        cols = set()
    _TABLE_COLUMNS_CACHE[table] = cols
    return cols


def _user_select_fields(*, include_auth: bool = False) -> str:
    cols = _table_columns("users")
    fields = ["id"]
    if "email" in cols:
        fields.append("email")
    elif "identifier" in cols:
        fields.append("identifier AS email")
    else:
        fields.append("'' AS email")
    if "role" in cols:
        fields.append("role")
    else:
        fields.append("'user' AS role")
    if "status" in cols:
        fields.append("status")
    else:
        fields.append("'active' AS status")
    if "disabled" in cols:
        fields.append("disabled")
    else:
        fields.append("0 AS disabled")
    if "created_at" in cols:
        fields.append("created_at")
    else:
        fields.append("0 AS created_at")
    if include_auth:
        if "password_hash" in cols:
            fields.append("password_hash")
        else:
            fields.append("'' AS password_hash")
        if "password_salt" in cols:
            fields.append("password_salt")
        else:
            fields.append("'' AS password_salt")
    return ",".join(fields)


def _legacy_verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters_s, salt_b64, hash_b64 = str(stored or "").split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        iters = int(iters_s)
        salt = base64.urlsafe_b64decode(salt_b64 + "=" * (-len(salt_b64) % 4))
        expected = base64.urlsafe_b64decode(hash_b64 + "=" * (-len(hash_b64) % 4))
        got = hashlib.pbkdf2_hmac("sha256", (password or "").encode("utf-8"), salt, iters)
        return hmac.compare_digest(got, expected)
    except Exception:
        return False


def _verify_password_compat(password: str, row: dict) -> bool:
    password_hash = str(row.get("password_hash") or "")
    password_salt = str(row.get("password_salt") or "")
    if not password_hash:
        return False
    if password_salt:
        try:
            return verify_password(password or "", password_hash, password_salt)
        except Exception:
            pass
    return _legacy_verify_password(password or "", password_hash)


def _current_user_row(uid: int) -> dict | None:
    return fetch_one(_DB, f"SELECT {_user_select_fields()} FROM users WHERE id=?;", (uid,))


def _user_public_select_fields() -> str:
    cols = _table_columns("users")
    fields = ["id"]
    fields.append("email" if "email" in cols else "'' AS email")
    fields.append("role" if "role" in cols else "'user' AS role")
    fields.append("status" if "status" in cols else "'active' AS status")
    fields.append("disabled" if "disabled" in cols else "0 AS disabled")
    fields.append("created_at" if "created_at" in cols else "0 AS created_at")
    fields.append("phone" if "phone" in cols else "'' AS phone")
    fields.append("display_name" if "display_name" in cols else "'' AS display_name")
    fields.append("avatar_url" if "avatar_url" in cols else "'' AS avatar_url")
    fields.append("phone_verified_at" if "phone_verified_at" in cols else "NULL AS phone_verified_at")
    fields.append("wechat_bound_at" if "wechat_bound_at" in cols else "NULL AS wechat_bound_at")
    if "wechat_openid" in cols:
        fields.append("wechat_openid")
    else:
        fields.append("NULL AS wechat_openid")
    if "wechat_unionid" in cols:
        fields.append("wechat_unionid")
    else:
        fields.append("NULL AS wechat_unionid")
    return ",".join(fields)


def _serialize_user_public_row(row: dict) -> dict:
    if _is_user_disabled(row):
        raise HTTPException(status_code=403, detail="Account disabled")
    wechat_bound = bool(row.get("wechat_openid") or row.get("wechat_unionid") or row.get("wechat_bound_at"))
    return {
        "id": int(row.get("id") or 0),
        "email": str(row.get("email") or ""),
        "role": str(row.get("role") or "user"),
        "createdAt": int(row.get("created_at") or 0),
        "phone": str(row.get("phone") or ""),
        "displayName": str(row.get("display_name") or ""),
        "avatarUrl": str(row.get("avatar_url") or ""),
        "phoneVerifiedAt": int(row.get("phone_verified_at") or 0) or None,
        "wechatBoundAt": int(row.get("wechat_bound_at") or 0) or None,
        "wechatBound": wechat_bound,
    }


def serialize_user_public(uid: int) -> dict:
    row = fetch_one(_DB, f"SELECT {_user_public_select_fields()} FROM users WHERE id=?;", (uid,))
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    return _serialize_user_public_row(row)


def _is_user_disabled(row: dict | None) -> bool:
    if not row:
        return False
    status = str(row.get("status") or "active").strip().lower()
    disabled = row.get("disabled")
    return status in {"disabled", "banned", "suspended"} or disabled in {1, True, "1", "true", "yes"}


def current_user(session: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE)) -> dict:
    if not session:
        raise HTTPException(status_code=401, detail="Not logged in")
    payload = verify_token(session)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid session")
    uid = payload.get("uid")
    if not isinstance(uid, int):
        raise HTTPException(status_code=401, detail="Invalid session")
    user = _current_user_row(uid)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    if _is_user_disabled(user):
        raise HTTPException(status_code=403, detail="Account disabled")
    return user


def require_admin(u: dict = Depends(current_user)) -> dict:
    if u.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return u


def require_ops(u: dict = Depends(current_user)) -> dict:
    """
    Ops gate for internal operations product:
    - allow admin and ops roles
    - deny normal users
    """
    if u.get("role") not in {"admin", "ops"}:
        raise HTTPException(status_code=403, detail="Ops only")
    return u


@router.get("/api/pay/qr/{channel}")
def api_pay_qr(channel: str, _: dict = Depends(current_user)):
    """
    Temporary manual-payment mode:
    - Serve static Alipay/WeChat QR images to logged-in users only.
    - Files are expected under /app/private/qr (bind-mounted on prod).
    """
    ch = (channel or "").strip().lower()
    if ch in {"alipay", "ali"}:
        name = "alipay.jpg"
    elif ch in {"wxpay", "wechat", "weixin", "wx"}:
        name = "wxpay.jpg"
    else:
        raise HTTPException(status_code=404, detail="Unknown channel")

    base = (os.environ.get("PAY_QR_DIR") or "/app/private/qr").strip() or "/app/private/qr"
    base_path = Path(base).resolve()
    p = (base_path / name).resolve()
    # Avoid path traversal by ensuring resolved path stays under base
    if not str(p).startswith(str(base_path)):
        raise HTTPException(status_code=404, detail="Not found")
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="QR not found")

    return FileResponse(
        str(p),
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store"},
        filename=name,
    )


def _proof_dir() -> Path:
    base = (os.environ.get("PAY_PROOF_DIR") or "/app/private/pay_proofs").strip() or "/app/private/pay_proofs"
    p = Path(base)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _decode_data_url_image(data_url: str) -> tuple[bytes, str]:
    """
    Decode data URL: data:image/{png|jpeg|jpg|webp};base64,....
    Returns (bytes, ext).
    """
    s = (data_url or "").strip()
    if not s.startswith("data:image/") or ";base64," not in s:
        raise HTTPException(status_code=400, detail="Invalid image data")
    head, b64 = s.split(";base64,", 1)
    mime = head.replace("data:", "").strip().lower()
    ext = "jpg"
    if mime in {"image/jpeg", "image/jpg"}:
        ext = "jpg"
    elif mime == "image/png":
        ext = "png"
    elif mime == "image/webp":
        ext = "webp"
    else:
        raise HTTPException(status_code=400, detail="Unsupported image type")
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 image")
    if not raw:
        raise HTTPException(status_code=400, detail="Empty image")
    # hard limit 2MB
    if len(raw) > 2 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large")
    return raw, ext


@router.post("/api/pay/manual/submit")
def api_pay_manual_submit(payload: dict, u: dict = Depends(current_user)):
    """
    User submits a manual payment proof (temporary, no payment callback yet).
    Creates a recharge_order with status='submitted' and stores proof image on disk.
    """
    uid = int(u["id"])
    channel = str(payload.get("channel") or "").strip().lower()
    if channel not in {"alipay", "wxpay"}:
        raise HTTPException(status_code=400, detail="Invalid channel")
    amount_cents = int(payload.get("amountCents") or payload.get("amount_cents") or 0)
    if amount_cents <= 0:
        raise HTTPException(status_code=400, detail="Invalid amount")
    note = str(payload.get("note") or "").strip()
    proof_data = str(payload.get("proofDataUrl") or payload.get("proof_data_url") or "").strip()
    if not proof_data:
        raise HTTPException(status_code=400, detail="Missing proof image")

    raw, ext = _decode_data_url_image(proof_data)
    now = ms()
    order_id = new_id("mre")
    proof_path = _proof_dir() / f"{order_id}.{ext}"
    try:
        proof_path.write_bytes(raw)
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to store proof")

    exec_one(
        _DB,
        "INSERT INTO recharge_orders(id,user_id,channel,amount_cents,status,note,created_at,paid_at,credited_at,submitted_at,proof_path) VALUES(?,?,?,?,?,?,?,?,?,?,?);",
        (
            order_id,
            uid,
            channel,
            int(amount_cents),
            "submitted",
            note,
            int(now),
            int(now),
            None,
            int(now),
            str(proof_path),
        ),
    )
    return {"ok": True, "orderId": order_id, "status": "submitted"}


@router.get("/api/admin/recharge_orders")
def api_admin_recharge_orders(status: Optional[str] = None, _: dict = Depends(require_admin)):
    st = (status or "").strip().lower()
    if st and st not in {"submitted", "credited", "rejected", "paid"}:
        raise HTTPException(status_code=400, detail="Invalid status")
    where = "WHERE status=?" if st else ""
    args = (st,) if st else ()
    rows = fetch_all(
        _DB,
        f"SELECT id,user_id,channel,amount_cents,status,note,created_at,paid_at,credited_at,submitted_at,credited_by,proof_path FROM recharge_orders {where} ORDER BY created_at DESC LIMIT 200;",
        args,
    )
    return {"ok": True, "orders": rows}


@router.get("/api/admin/pay/manual/proof/{order_id}")
def api_admin_pay_manual_proof(order_id: str, _: dict = Depends(require_admin)):
    oid = str(order_id or "").strip()
    if not oid:
        raise HTTPException(status_code=404, detail="Not found")
    row = fetch_one(_DB, "SELECT proof_path FROM recharge_orders WHERE id=?;", (oid,))
    p = str((row or {}).get("proof_path") or "")
    if not p:
        raise HTTPException(status_code=404, detail="No proof")
    fp = Path(p)
    if not fp.exists() or not fp.is_file():
        raise HTTPException(status_code=404, detail="No proof")
    # best-effort mime
    mt = "image/jpeg"
    if fp.name.lower().endswith(".png"):
        mt = "image/png"
    elif fp.name.lower().endswith(".webp"):
        mt = "image/webp"
    return FileResponse(str(fp), media_type=mt, headers={"Cache-Control": "no-store"}, filename=fp.name)


@router.post("/api/admin/pay/manual/credit")
def api_admin_pay_manual_credit(payload: dict, admin: dict = Depends(require_admin)):
    """
    Admin one-click credit for a submitted manual payment.
    - Writes ledger: recharge (+pay), promo_credit (+gift if eligible)
    - Updates recharge_orders to credited
    """
    oid = str(payload.get("orderId") or payload.get("order_id") or "").strip()
    if not oid:
        raise HTTPException(status_code=400, detail="Missing orderId")

    now = ms()
    _DB.execute("BEGIN IMMEDIATE;")
    try:
        row = fetch_one(
            _DB,
            "SELECT id,user_id,channel,amount_cents,status FROM recharge_orders WHERE id=?;",
            (oid,),
        )
        if not row:
            _DB.rollback()
            raise HTTPException(status_code=404, detail="Order not found")
        st = str(row.get("status") or "")
        uid = int(row["user_id"])
        if st == "credited":
            _DB.commit()
            return {"ok": True, "orderId": oid, "credited": False, "balanceCents": get_user_balance_cents(_DB, uid)}
        if st not in {"submitted", "paid"}:
            _DB.rollback()
            raise HTTPException(status_code=400, detail="Invalid order status")

        pay = int(row.get("amount_cents") or 0)
        if pay <= 0:
            _DB.rollback()
            raise HTTPException(status_code=400, detail="Invalid amount")
        ch = str(row.get("channel") or "")

        # principal
        _DB.execute(
            """
INSERT OR IGNORE INTO ledger(id,user_id,entry_type,amount_cents,period,ref_id,created_at)
VALUES(?,?,?,?,?,?,?);
""",
            (new_id("led"), uid, "recharge", int(pay), ch, oid, int(now)),
        )

        # promo gift (first-month, one-time)
        gift = 0
        try:
            urow = fetch_one(_DB, "SELECT created_at FROM users WHERE id=?;", (uid,)) or {}
            promo = _promo_first_month_status(uid, int(urow.get("created_at") or 0))
            if promo.get("eligible"):
                gift = _gift_for_amount(pay)
        except Exception:
            gift = 0

        if gift > 0:
            _DB.execute(
                """
INSERT OR IGNORE INTO ledger(id,user_id,entry_type,amount_cents,period,ref_id,created_at)
VALUES(?,?,?,?,?,?,?);
""",
                (new_id("led"), uid, "promo_credit", int(gift), "first_month", oid, int(now)),
            )

        _DB.execute(
            "UPDATE recharge_orders SET status='credited', credited_at=?, credited_by=? WHERE id=?;",
            (int(now), int(admin["id"]), oid),
        )
        _DB.commit()
    except HTTPException:
        raise
    except Exception:
        try:
            _DB.rollback()
        except Exception:
            pass
        raise

    return {"ok": True, "orderId": oid, "credited": True, "balanceCents": get_user_balance_cents(_DB, uid)}



_RE_CN_MOBILE = re.compile(r"^(?:\+?86)?(1\d{10})$")


def _normalize_cn_mobile(raw: str) -> str:
    s = (raw or "").strip().replace(" ", "").replace("-", "")
    m = _RE_CN_MOBILE.match(s)
    if not m:
        raise HTTPException(status_code=400, detail="Invalid phone")
    return m.group(1)


def _sms_templates() -> tuple[str, str]:
    tpl_bind = (os.environ.get("ALIYUN_SMS_TEMPLATE_BIND_PHONE") or "").strip()
    tpl_reset = (os.environ.get("ALIYUN_SMS_TEMPLATE_RESET_PASSWORD") or "").strip()
    if not tpl_bind or not tpl_reset:
        raise HTTPException(status_code=500, detail="SMS templates not configured")
    return tpl_bind, tpl_reset


def _rate_limit_sms(phone: str, ip: str, purpose: str) -> None:
    # Simple anti-abuse:
    # - cooldown: per phone <= 1 / 60s / purpose
    # - per phone: <= 5 / hour / purpose
    # - per ip: <= 20 / hour / purpose
    now = ms()
    w60 = now - 60
    r0 = fetch_one(
        _DB,
        "SELECT created_at FROM sms_codes WHERE phone=? AND purpose=? ORDER BY id DESC LIMIT 1;",
        (phone, purpose),
    )
    if r0 and int(r0.get("created_at") or 0) >= w60:
        created_at = int(r0.get("created_at") or 0)
        remain = 60 - max(0, now - created_at)
        if remain < 1:
            remain = 1
        raise HTTPException(status_code=429, detail={"code": "Cooldown", "retryAfter": int(remain)})
    w = now - 3600
    r1 = fetch_one(
        _DB,
        "SELECT COUNT(1) AS n FROM sms_codes WHERE phone=? AND purpose=? AND created_at>=?;",
        (phone, purpose, w),
    )
    if int((r1 or {}).get("n") or 0) >= 5:
        raise HTTPException(status_code=429, detail="Too many requests")
    r2 = fetch_one(
        _DB,
        "SELECT COUNT(1) AS n FROM sms_codes WHERE ip=? AND purpose=? AND created_at>=?;",
        (ip or "", purpose, w),
    )
    if int((r2 or {}).get("n") or 0) >= 20:
        raise HTTPException(status_code=429, detail="Too many requests")


def _new_code6() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


async def _send_and_store_code(*, phone: str, purpose: str, user_id: int | None, ip: str, ua: str) -> None:
    tpl_bind, tpl_reset = _sms_templates()
    template_code = tpl_bind if purpose in {"bind_phone", "register"} else tpl_reset

    _rate_limit_sms(phone, ip, purpose)
    now = ms()
    code = _new_code6()
    code_hash, code_salt = hash_otp(code)
    expires = now + 5 * 60
    sms_id = exec_one(
        _DB,
        "INSERT INTO sms_codes(purpose,phone,user_id,code_hash,code_salt,ip,ua,created_at,expires_at,attempts) VALUES(?,?,?,?,?,?,?,?,?,0);",
        (purpose, phone, user_id, code_hash, code_salt, ip or "", ua or "", now, expires),
    )

    try:
        await send_sms_verification(phone, template_code=template_code, template_param={"code": code})
    except Exception as e:
        # Avoid poisoning rate-limit with failed sends.
        try:
            _DB.execute("DELETE FROM sms_codes WHERE id=?;", (int(sms_id),))
            _DB.commit()
        except Exception:
            pass
        raise HTTPException(status_code=502, detail=str(e))


def ensure_admin_from_env() -> None:
    # Accept both SaaS (ADMIN_EMAIL / ADMIN_PASSWORD) and Compose
    # (ADMIN_USER / ADMIN_PASS) conventions so local/prod stacks bootstrap.
    email = (os.environ.get("ADMIN_EMAIL") or "").strip().lower()
    if not email:
        user = (os.environ.get("ADMIN_USER") or "").strip()
        if user:
            email = user.lower() if "@" in user else f"{user.lower()}@localhost"
    pwd = (os.environ.get("ADMIN_PASSWORD") or os.environ.get("ADMIN_PASS") or "").strip()
    if not email or not pwd:
        return
    user_cols = _table_columns("users")
    login_col = "email" if "email" in user_cols else ("identifier" if "identifier" in user_cols else "")
    if not login_col or "password_hash" not in user_cols:
        return
    exist = fetch_one(_DB, f"SELECT id FROM users WHERE {login_col}=?;", (email,))
    if "password_salt" in user_cols:
        ph, salt = hash_password(pwd)
    else:
        salt = ""
        salt_raw = os.urandom(16)
        digest = hashlib.pbkdf2_hmac("sha256", pwd.encode("utf-8"), salt_raw, 200_000)
        ph = "pbkdf2_sha256$200000$%s$%s" % (
            base64.urlsafe_b64encode(salt_raw).decode("ascii").rstrip("="),
            base64.urlsafe_b64encode(digest).decode("ascii").rstrip("="),
        )
    if exist:
        if "password_salt" in user_cols:
            _DB.execute(
                f"UPDATE users SET password_hash=?, password_salt=?, role='admin', updated_at=? WHERE {login_col}=?;",
                (ph, salt, ms(), email),
            )
        else:
            _DB.execute(
                f"UPDATE users SET password_hash=?, role='admin', updated_at=? WHERE {login_col}=?;",
                (ph, ms(), email),
            )
        _DB.commit()
        return
    ts = ms()
    if login_col == "email" and "password_salt" in user_cols:
        exec_one(
            _DB,
            "INSERT INTO users(email,password_hash,password_salt,role,created_at,updated_at) VALUES(?,?,?,?,?,?);",
            (email, ph, salt, "admin", ts, ts),
        )
        return
    if login_col == "identifier" and "password_salt" not in user_cols:
        exec_one(
            _DB,
            "INSERT INTO users(identifier,password_hash,role,disabled,created_at,updated_at) VALUES(?,?,?,?,?,?);",
            (email, ph, "admin", 0, ts, ts),
        )
        return


ensure_admin_from_env()


def _subscription_for(uid: int) -> dict:
    sub_cols = _table_columns("subscriptions")
    if not sub_cols or "user_id" not in sub_cols:
        return {"status": "none"}
    sub = fetch_one(
        _DB,
        "SELECT "
        + ("status" if "status" in sub_cols else "'none' AS status")
        + ","
        + ("trial_ends_at" if "trial_ends_at" in sub_cols else "NULL AS trial_ends_at")
        + ","
        + ("current_period_end" if "current_period_end" in sub_cols else "NULL AS current_period_end")
        + ","
        + ("updated_at" if "updated_at" in sub_cols else "0 AS updated_at")
        + " FROM subscriptions WHERE user_id=?;",
        (uid,),
    )
    if not sub:
        return {"status": "none"}
    # Auto-correct expired status (trial/active) to avoid stale UI/state.
    # Timestamps in DB are seconds since epoch (see accounting.ms()).
    try:
        now = ms()
        status = str(sub.get("status") or "none")
        trial_ends = int(sub.get("trial_ends_at") or 0)
        cpe = int(sub.get("current_period_end") or 0)
        end = cpe if cpe > 0 else trial_ends
        if status in {"trialing", "active"} and end > 0 and end <= now and "updated_at" in sub_cols:
            _DB.execute("UPDATE subscriptions SET status='expired', updated_at=? WHERE user_id=?;", (int(now), int(uid)))
            _DB.commit()
            sub["status"] = "expired"
            sub["updated_at"] = int(now)
    except Exception:
        # best-effort; don't break API on migration edge-cases
        pass
    return {
        "status": sub["status"],
        "trialEndsAt": sub["trial_ends_at"],
        "currentPeriodEnd": sub["current_period_end"],
        "updatedAt": sub["updated_at"],
    }


def _sub_period_days() -> int:
    v = (os.environ.get("SUB_PERIOD_DAYS") or "").strip()
    try:
        n = int(v)
        return n if n > 0 else 30
    except Exception:
        return 30


def _sub_price_cents(plan: str) -> int:
    """
    Minimal subscription pricing (cents).
    Env override:
      SUB_PLAN_PRICES_JSON='{"pro":3900,"team":9900}'
    """
    raw = (os.environ.get("SUB_PLAN_PRICES_JSON") or "").strip()
    p = (plan or "").strip().lower() or "pro"
    if raw:
        try:
            import json

            obj = json.loads(raw)
            if isinstance(obj, dict) and p in obj:
                return max(0, int(obj[p]))
        except Exception:
            pass
    # Default pricing (cents): Pro ¥99/月（首发）, Team ¥299/月（占位）
    return 9900 if p == "pro" else (29900 if p == "team" else 9900)


def _sub_monthly_credit_cents(plan: str) -> int:
    """
    Plan A: subscription = 权益 + 每月赠送额度（按月发放到余额）。
    Env override:
      SUB_PLAN_CREDITS_JSON='{"pro":12000,"team":30000}'
    """
    raw = (os.environ.get("SUB_PLAN_CREDITS_JSON") or "").strip()
    p = (plan or "").strip().lower() or "pro"
    if raw:
        try:
            import json

            obj = json.loads(raw)
            if isinstance(obj, dict) and p in obj:
                return max(0, int(obj[p]))
        except Exception:
            pass
    # MVP defaults: pro 赠送略高于月费，利于转化；team 更高。
    # Default monthly credit (cents): Pro 每月送 ¥120, Team 每月送 ¥300（占位）
    return 12000 if p == "pro" else (30000 if p == "team" else 12000)


def _promo_window_days() -> int:
    v = (os.environ.get("PROMO_FIRST_MONTH_DAYS") or "").strip()
    try:
        n = int(v)
        return n if n > 0 else 30
    except Exception:
        return 30


def _promo_first_month_tiers() -> list[dict]:
    """
    首月活动档位（cents）：
      - 99 送 30 -> 到账 129
      - 199 送 80 -> 到账 279
      - 499 送 250 -> 到账 749
    Env override:
      PROMO_FIRST_MONTH_TIERS_JSON='[{"pay":9900,"gift":3000},{"pay":19900,"gift":8000},{"pay":49900,"gift":25000}]'
    """
    raw = (os.environ.get("PROMO_FIRST_MONTH_TIERS_JSON") or "").strip()
    if raw:
        try:
            import json

            arr = json.loads(raw)
            out = []
            if isinstance(arr, list):
                for it in arr:
                    if not isinstance(it, dict):
                        continue
                    pay = int(it.get("pay") or 0)
                    gift = int(it.get("gift") or 0)
                    if pay > 0 and gift >= 0:
                        out.append({"payCents": pay, "giftCents": gift, "creditCents": pay + gift})
            if out:
                out.sort(key=lambda x: int(x["payCents"]))
                return out
        except Exception:
            pass
    tiers = [(9900, 3000), (19900, 8000), (49900, 25000)]
    return [{"payCents": p, "giftCents": g, "creditCents": p + g} for (p, g) in tiers]


def _promo_first_month_status(uid: int, user_created_at: int) -> dict:
    """
    规则：
    - 首月活动：注册后 N 天内（默认 30 天）
    - 仅一次：只要出现过 promo_credit 记录，就视为已用
    备注：后续接入支付后，会在充值入账时写入 promo_credit（gift 部分）。
    """
    now = ms()
    days = _promo_window_days()
    within = (int(user_created_at or 0) > 0) and (now <= int(user_created_at) + int(days) * 24 * 3600)
    used = False
    try:
        r = fetch_one(_DB, "SELECT 1 AS ok FROM ledger WHERE user_id=? AND entry_type='promo_credit' LIMIT 1;", (int(uid),))
        used = bool(r)
    except Exception:
        used = False
    return {"kind": "first_month", "windowDays": int(days), "eligible": bool(within and (not used)), "used": bool(used), "tiers": _promo_first_month_tiers()}


def _gift_for_amount(amount_cents: int) -> int:
    for t in _promo_first_month_tiers():
        if int(t.get("payCents") or 0) == int(amount_cents):
            return int(t.get("giftCents") or 0)
    return 0


def _yyyymm(ts: int) -> str:
    try:
        return time.strftime("%Y%m", time.localtime(int(ts)))
    except Exception:
        return "000000"


def _current_sub_plan(uid: int) -> str:
    # For now we infer plan from latest subscription_fee ledger entry's period field.
    last_fee = fetch_one(
        _DB,
        "SELECT period FROM ledger WHERE user_id=? AND entry_type='subscription_fee' ORDER BY created_at DESC LIMIT 1;",
        (int(uid),),
    )
    return str((last_fee or {}).get("period") or "pro").strip().lower() or "pro"


def _ensure_monthly_credit(uid: int) -> dict:
    """
    Best-effort monthly grant (idempotent).
    Returns basic info for UI.
    """
    plan = "pro"
    try:
        now = ms()
        sub = fetch_one(_DB, "SELECT status,current_period_end FROM subscriptions WHERE user_id=?;", (int(uid),)) or {}
        status = str(sub.get("status") or "none")
        cpe = int(sub.get("current_period_end") or 0)
        plan = _current_sub_plan(uid)
        credit = _sub_monthly_credit_cents(plan)
        if status != "active" or cpe <= now or credit <= 0:
            return {"plan": plan, "monthlyCreditCents": int(max(0, credit)), "granted": False}

        month = _yyyymm(now)
        ref_id = f"monthly_credit:{plan}:{month}"
        entry_id = new_id("cred")
        cur = _DB.execute(
            """
INSERT OR IGNORE INTO ledger(id,user_id,entry_type,amount_cents,period,ref_id,created_at)
VALUES(?,?,?,?,?,?,?);
""",
            (entry_id, int(uid), "monthly_credit", int(credit), plan, ref_id, int(now)),
        )
        granted = int(getattr(cur, "rowcount", 0) or 0) > 0
        if granted:
            _DB.commit()
        return {"plan": plan, "monthlyCreditCents": int(credit), "granted": bool(granted)}
    except Exception:
        try:
            _DB.rollback()
        except Exception:
            pass
        return {"plan": plan, "monthlyCreditCents": int(_sub_monthly_credit_cents(plan)), "granted": False}


def _activate_subscription_with_balance(*, uid: int, plan: str, months: int, request_id: str) -> dict:
    """
    Charge user's prepaid balance and activate/extend subscription.
    Idempotent by (user_id, entry_type, ref_id) unique index on ledger.
    """
    p = (plan or "").strip().lower() or "pro"
    m = max(1, min(int(months), 24))
    price = _sub_price_cents(p)
    cost = int(price) * int(m)
    if cost <= 0:
        raise HTTPException(status_code=400, detail="Invalid subscription price")

    now = ms()
    period_sec = _sub_period_days() * 24 * 3600
    if period_sec <= 0:
        period_sec = 30 * 24 * 3600

    # Serialize: balance check + ledger insert + subscription update
    _DB.execute("BEGIN IMMEDIATE;")
    try:
        bal = get_user_balance_cents(_DB, uid)
        if bal < cost:
            _DB.rollback()
            raise HTTPException(status_code=402, detail={"code": "InsufficientBalance", "balanceCents": int(bal), "needCents": cost})

        cur = _DB.execute(
            """
INSERT OR IGNORE INTO ledger(id,user_id,entry_type,amount_cents,period,ref_id,created_at)
VALUES(?,?,?,?,?,?,?);
""",
            (
                request_id,
                int(uid),
                "subscription_fee",
                -int(cost),
                p,
                request_id,
                int(now),
            ),
        )
        inserted = int(getattr(cur, "rowcount", 0) or 0) > 0

        # Only extend subscription when ledger entry is newly inserted (idempotent retries won't double-extend).
        if inserted:
            sub = fetch_one(_DB, "SELECT status,trial_ends_at,current_period_end FROM subscriptions WHERE user_id=?;", (uid,)) or {}
            cpe = sub.get("current_period_end")
            base = int(cpe) if isinstance(cpe, int) and cpe > now else int(now)
            new_end = base + period_sec * int(m)
            if sub:
                _DB.execute(
                    "UPDATE subscriptions SET status='active', current_period_end=?, updated_at=? WHERE user_id=?;",
                    (int(new_end), int(now), int(uid)),
                )
            else:
                _DB.execute(
                    "INSERT INTO subscriptions(user_id,status,trial_ends_at,current_period_end,created_at,updated_at) VALUES(?,?,?,?,?,?);",
                    (int(uid), "active", None, int(new_end), int(now), int(now)),
                )

        _DB.commit()
    except HTTPException:
        raise
    except Exception:
        try:
            _DB.rollback()
        except Exception:
            pass
        raise

    # Return latest state (outside tx)
    _ensure_monthly_credit(int(uid))
    return {"subscription": _subscription_for(uid), "balanceCents": get_user_balance_cents(_DB, uid)}


def _register(email: str, password: str) -> dict:
    e = (email or "").strip().lower()
    if len(e) < 5 or "@" not in e:
        raise HTTPException(status_code=400, detail="Invalid email")
    if len(password or "") < 8:
        raise HTTPException(status_code=400, detail="Password too short")
    exist = fetch_one(_DB, "SELECT id FROM users WHERE email=?;", (e,))
    if exist:
        raise HTTPException(status_code=409, detail="Email already registered")
    ph, salt = hash_password(password)
    ts = ms()
    uid = exec_one(
        _DB,
        "INSERT INTO users(email,password_hash,password_salt,role,created_at,updated_at) VALUES(?,?,?,?,?,?);",
        (e, ph, salt, "user", ts, ts),
    )
    t_end = ts + trial_days() * 24 * 3600
    _DB.execute(
        "INSERT INTO subscriptions(user_id,status,trial_ends_at,current_period_end,created_at,updated_at) VALUES(?,?,?,?,?,?);",
        (uid, "trialing", t_end, t_end, ts, ts),
    )
    _DB.commit()
    ensure_beta_credit(_DB, user_id=int(uid), created_at=ts)
    return {"id": uid, "email": e, "role": "user", "createdAt": ts}


def _register_phone(phone: str, password: str) -> dict:
    p = _normalize_cn_mobile(phone)
    if len(password or "") < 8:
        raise HTTPException(status_code=400, detail="Password too short")
    exist = fetch_one(_DB, "SELECT id FROM users WHERE phone=?;", (p,))
    if exist:
        raise HTTPException(status_code=409, detail="Phone already registered")
    # Keep email as a stable internal identifier (email column is NOT NULL in current schema).
    # Users can still login via phone; email is implementation detail.
    e = f"{p}@phone.codesprite.local"
    ph, salt = hash_password(password)
    ts = ms()
    uid = exec_one(
        _DB,
        "INSERT INTO users(email,phone,phone_verified_at,password_hash,password_salt,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?);",
        (e, p, ts, ph, salt, "user", ts, ts),
    )
    t_end = ts + trial_days() * 24 * 3600
    _DB.execute(
        "INSERT INTO subscriptions(user_id,status,trial_ends_at,current_period_end,created_at,updated_at) VALUES(?,?,?,?,?,?);",
        (uid, "trialing", t_end, t_end, ts, ts),
    )
    _DB.commit()
    ensure_beta_credit(_DB, user_id=int(uid), created_at=ts)
    return {"id": uid, "email": e, "role": "user", "createdAt": ts}


def _coerce_row_int(val: object) -> int:
    """Normalize DB driver types (e.g. MySQL BIGINT) for JSON/session use."""
    if val is None:
        return 0
    if isinstance(val, bool):
        return int(val)
    if isinstance(val, int):
        return val
    try:
        return int(val)  # type: ignore[arg-type]
    except Exception:
        return 0


def _login(email: str, password: str) -> dict:
    ident_raw = (email or "").strip()
    e = ident_raw.lower()
    user_cols = _table_columns("users")
    login_col = "email" if "email" in user_cols else ("identifier" if "identifier" in user_cols else "")
    if not login_col or "password_hash" not in user_cols:
        raise HTTPException(status_code=500, detail="Auth schema is incompatible")
    row = None
    # Try phone first if it looks like a CN mobile.
    if "phone" in user_cols:
        try:
            p = _normalize_cn_mobile(ident_raw)
            row = fetch_one(
                _DB,
                f"SELECT {_user_select_fields(include_auth=True)} FROM users WHERE phone=?;",
                (p,),
            )
        except Exception:
            row = None
    if row is None:
        row = fetch_one(_DB, f"SELECT {_user_select_fields(include_auth=True)} FROM users WHERE {login_col}=?;", (e,))
    if not row:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if _is_user_disabled(row):
        raise HTTPException(status_code=403, detail="Account disabled")
    if not _verify_password_compat(password or "", row):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return {
        "id": _coerce_row_int(row.get("id")),
        "email": str(row.get("email") or ""),
        "role": str(row.get("role") or "user"),
        "createdAt": _coerce_row_int(row.get("created_at")),
    }


@router.post("/api/auth/register")
def api_auth_register(payload: dict, resp: Response):
    # Support both email-register and phone+sms register.
    if (payload.get("phone") or "").strip():
        phone = str(payload.get("phone") or "")
        code = str(payload.get("code") or "").strip()
        password = str(payload.get("password") or "")
        if not code:
            raise HTTPException(status_code=400, detail="Missing code")
        p = _normalize_cn_mobile(phone)
        now = ms()
        row = fetch_one(
            _DB,
            "SELECT id,code_hash,code_salt,attempts,expires_at,consumed_at FROM sms_codes WHERE phone=? AND purpose='register' ORDER BY id DESC LIMIT 1;",
            (p,),
        )
        if not row or row.get("consumed_at") or int(row.get("expires_at") or 0) < now:
            raise HTTPException(status_code=400, detail="Invalid code")
        attempts = int(row.get("attempts") or 0)
        if attempts >= 5:
            raise HTTPException(status_code=429, detail="Too many attempts")
        if not verify_otp(code, str(row["code_hash"]), str(row["code_salt"])):
            _DB.execute("UPDATE sms_codes SET attempts=attempts+1 WHERE id=?;", (int(row["id"]),))
            _DB.commit()
            raise HTTPException(status_code=400, detail="Invalid code")
        _DB.execute("UPDATE sms_codes SET consumed_at=? WHERE id=?;", (now, int(row["id"])))
        _DB.commit()
        user = _register_phone(p, password)
    else:
        user = _register(str(payload.get("email") or ""), str(payload.get("password") or ""))
    _set_session_cookie(resp, int(user["id"]), str(user["role"]))
    return {"ok": True, "user": user, "subscription": _subscription_for(int(user["id"]))}


@router.post("/api/auth/login")
def api_auth_login(payload: dict, resp: Response):
    # Support both identifier (phone/email) and legacy email field.
    identifier = str(payload.get("identifier") or payload.get("email") or "")
    try:
        user = _login(identifier, str(payload.get("password") or ""))
        _set_session_cookie(resp, int(user["id"]), str(user["role"]))
        return {"ok": True, "user": user, "subscription": _subscription_for(int(user["id"]))}
    except HTTPException:
        raise
    except (SQLAlchemyError, sqlite3.Error):
        _log.exception(
            "POST /api/auth/login database error (identifier prefix=%r)",
            (identifier[:80] + "…") if len(identifier) > 80 else identifier,
        )
        raise HTTPException(status_code=503, detail="Database temporarily unavailable")
    except Exception:
        _log.exception(
            "POST /api/auth/login unexpected error (identifier prefix=%r)",
            (identifier[:80] + "…") if len(identifier) > 80 else identifier,
        )
        raise HTTPException(status_code=500, detail="Login service error")


@router.post("/api/auth/logout")
def api_auth_logout(resp: Response):
    _clear_session_cookie(resp)
    return {"ok": True}


@router.get("/api/me")
def api_me(u: dict = Depends(current_user)):
    uid = int(u["id"])
    grant = _ensure_monthly_credit(uid)
    promo = _promo_first_month_status(uid, int(u.get("created_at") or 0))
    beta = beta_quota_status(_DB, uid)
    user = serialize_user_public(uid)
    return {
        "ok": True,
        "user": user,
        "subscription": _subscription_for(uid),
        "balanceCents": get_user_balance_cents(_DB, uid),
        "plan": grant.get("plan") or "pro",
        "monthlyCreditCents": int(grant.get("monthlyCreditCents") or 0),
        "promo": promo,
        "beta": beta,
    }


@router.get("/api/me/billing")
def api_me_billing(u: dict = Depends(current_user)):
    uid = int(u["id"])
    grant = _ensure_monthly_credit(uid)
    promo = _promo_first_month_status(uid, int(u.get("created_at") or 0))
    beta = beta_quota_status(_DB, uid)
    orders = fetch_all(
        _DB,
        "SELECT id,channel,amount_cents,status,created_at,paid_at,credited_at,note FROM recharge_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 50;",
        (uid,),
    )
    ledger = fetch_all(
        _DB,
        "SELECT id,entry_type,amount_cents,period,ref_id,created_at FROM ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 100;",
        (uid,),
    )
    return {
        "ok": True,
        "me": {"id": uid, "email": u["email"], "role": u["role"], "createdAt": u["created_at"]},
        "balanceCents": get_user_balance_cents(_DB, uid),
        "subscription": _subscription_for(uid),
        "plan": grant.get("plan") or "pro",
        "monthlyCreditCents": int(grant.get("monthlyCreditCents") or 0),
        "promo": promo,
        "beta": beta,
        "orders": orders,
        "ledger": ledger,
    }


@router.post("/api/me/subscription/activate")
def api_me_subscription_activate(payload: dict, u: dict = Depends(current_user)):
    """
    Activate/extend subscription using prepaid balance.
    This unblocks SSH after trial ends (policy: SSH requires subscription).
    """
    uid = int(u["id"])
    plan = str(payload.get("plan") or "pro")
    months = int(payload.get("months") or 1)
    request_id = str(payload.get("requestId") or payload.get("request_id") or new_id("sub"))
    r = _activate_subscription_with_balance(uid=uid, plan=plan, months=months, request_id=request_id)
    return {"ok": True, **r}


@router.post("/api/me/phone/bind/request")
async def api_me_phone_bind_request(payload: dict, request: Request, u: dict = Depends(current_user)):
    phone = _normalize_cn_mobile(str(payload.get("phone") or ""))
    exist = fetch_one(_DB, "SELECT id FROM users WHERE phone=? AND id<>?;", (phone, int(u["id"])))
    if exist:
        raise HTTPException(status_code=409, detail="Phone already bound")
    await _send_and_store_code(
        phone=phone,
        purpose="bind_phone",
        user_id=int(u["id"]),
        ip=request.client.host if request.client else "",
        ua=request.headers.get("user-agent", ""),
    )
    return {"ok": True}


@router.post("/api/me/phone/bind/confirm")
def api_me_phone_bind_confirm(payload: dict, u: dict = Depends(current_user)):
    phone = _normalize_cn_mobile(str(payload.get("phone") or ""))
    code = str(payload.get("code") or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="Missing code")
    now = ms()
    row = fetch_one(
        _DB,
        "SELECT id,code_hash,code_salt,attempts,expires_at,consumed_at FROM sms_codes WHERE phone=? AND purpose='bind_phone' AND user_id=? ORDER BY id DESC LIMIT 1;",
        (phone, int(u["id"])),
    )
    if not row or row.get("consumed_at") or int(row.get("expires_at") or 0) < now:
        raise HTTPException(status_code=400, detail="Invalid code")
    attempts = int(row.get("attempts") or 0)
    if attempts >= 5:
        raise HTTPException(status_code=429, detail="Too many attempts")
    if not verify_otp(code, str(row["code_hash"]), str(row["code_salt"])):
        _DB.execute("UPDATE sms_codes SET attempts=attempts+1 WHERE id=?;", (int(row["id"]),))
        _DB.commit()
        raise HTTPException(status_code=400, detail="Invalid code")

    _DB.execute("UPDATE sms_codes SET consumed_at=? WHERE id=?;", (now, int(row["id"])))
    _DB.execute(
        "UPDATE users SET phone=?, phone_verified_at=?, updated_at=? WHERE id=?;",
        (phone, now, now, int(u["id"])),
    )
    _DB.commit()
    return {"ok": True}


@router.post("/api/auth/password_reset/request")
async def api_auth_password_reset_request(payload: dict, request: Request):
    phone = _normalize_cn_mobile(str(payload.get("phone") or ""))
    # Do not reveal whether the phone exists/bound.
    user = fetch_one(_DB, "SELECT id FROM users WHERE phone=? AND phone_verified_at IS NOT NULL;", (phone,))
    if not user:
        return {"ok": True}
    await _send_and_store_code(
        phone=phone,
        purpose="reset_password",
        user_id=int(user["id"]),
        ip=request.client.host if request.client else "",
        ua=request.headers.get("user-agent", ""),
    )
    return {"ok": True}


@router.post("/api/auth/register_sms/request")
async def api_auth_register_sms_request(payload: dict, request: Request):
    phone = _normalize_cn_mobile(str(payload.get("phone") or ""))
    # do not reveal if already exists
    await _send_and_store_code(
        phone=phone,
        purpose="register",
        user_id=None,
        ip=request.client.host if request.client else "",
        ua=request.headers.get("user-agent", ""),
    )
    return {"ok": True}


@router.post("/api/auth/password_reset/confirm")
def api_auth_password_reset_confirm(payload: dict):
    phone = _normalize_cn_mobile(str(payload.get("phone") or ""))
    code = str(payload.get("code") or "").strip()
    new_pw = str(payload.get("newPassword") or "")
    if len(new_pw) < 8:
        raise HTTPException(status_code=400, detail="Password too short")
    user = fetch_one(_DB, "SELECT id FROM users WHERE phone=? AND phone_verified_at IS NOT NULL;", (phone,))
    if not user:
        raise HTTPException(status_code=400, detail="Invalid code")

    now = ms()
    row = fetch_one(
        _DB,
        "SELECT id,code_hash,code_salt,attempts,expires_at,consumed_at FROM sms_codes WHERE phone=? AND purpose='reset_password' AND user_id=? ORDER BY id DESC LIMIT 1;",
        (phone, int(user["id"])),
    )
    if not row or row.get("consumed_at") or int(row.get("expires_at") or 0) < now:
        raise HTTPException(status_code=400, detail="Invalid code")
    attempts = int(row.get("attempts") or 0)
    if attempts >= 5:
        raise HTTPException(status_code=429, detail="Too many attempts")
    if not verify_otp(code, str(row["code_hash"]), str(row["code_salt"])):
        _DB.execute("UPDATE sms_codes SET attempts=attempts+1 WHERE id=?;", (int(row["id"]),))
        _DB.commit()
        raise HTTPException(status_code=400, detail="Invalid code")

    ph, salt = hash_password(new_pw)
    _DB.execute("UPDATE sms_codes SET consumed_at=? WHERE id=?;", (now, int(row["id"])))
    _DB.execute(
        "UPDATE users SET password_hash=?, password_salt=?, updated_at=? WHERE id=?;",
        (ph, salt, now, int(user["id"])),
    )
    _DB.commit()
    return {"ok": True}


@router.post("/api/admin/sms/test")
async def api_admin_sms_test(payload: dict, request: Request, _: dict = Depends(require_admin)):
    phone = _normalize_cn_mobile(str(payload.get("phone") or ""))
    purpose = str(payload.get("purpose") or "reset_password").strip()
    if purpose not in {"reset_password", "bind_phone"}:
        raise HTTPException(status_code=400, detail="Invalid purpose")
    tpl_bind, tpl_reset = _sms_templates()
    template_code = tpl_bind if purpose == "bind_phone" else tpl_reset
    code = _new_code6()
    data = await send_sms_verification(phone, template_code=template_code, template_param={"code": code})
    return {"ok": True, "provider": "aliyun", "resp": data}


@router.get("/api/admin/stats")
def api_admin_stats(_: dict = Depends(require_admin)):
    stats = admin_stats(_DB)
    return {"ok": True, "stats": stats, **stats}


@router.get("/api/admin/beta/overview")
def api_admin_beta_overview(admin: dict = Depends(require_admin)):
    now = ms()
    lt = time.localtime(now)
    day_start = int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, -1, -1, -1)))
    quota = beta_quota_status(_DB, int(admin["id"]))
    users_total = fetch_one(_DB, "SELECT COUNT(1) AS n FROM users;", ()) or {}
    beta_users = fetch_one(_DB, "SELECT COUNT(DISTINCT user_id) AS n FROM ledger WHERE entry_type='beta_credit';", ()) or {}
    active_today = fetch_one(_DB, "SELECT COUNT(DISTINCT user_id) AS n FROM llm_usage WHERE started_at>=?;", (day_start,)) or {}
    top = fetch_all(
        _DB,
        """
SELECT l.user_id,u.email,COALESCE(SUM(-l.amount_cents),0) AS spend_cents
FROM ledger l
LEFT JOIN users u ON u.id=l.user_id
WHERE l.entry_type='llm_usage' AND l.amount_cents<0 AND l.created_at>=?
GROUP BY l.user_id,u.email
ORDER BY spend_cents DESC
LIMIT 10;
""",
        (day_start,),
    )
    return {
        "ok": True,
        "enabled": beta_mode_enabled(),
        "initialCreditCents": beta_initial_credit_cents(),
        "usersTotal": int(users_total.get("n") or 0),
        "betaUsers": int(beta_users.get("n") or 0),
        "activeUsersToday": int(active_today.get("n") or 0),
        "siteDailyBudgetCents": int(quota.get("siteDailyBudgetCents") or 0),
        "siteDailySpendCents": int(quota.get("siteDailySpendCents") or 0),
        "siteDailyRemainingCents": int(quota.get("siteDailyRemainingCents") or 0),
        "topUsersToday": [
            {
                "userId": int(r.get("user_id") or 0),
                "email": mask_email(str(r.get("email") or "")),
                "spendCents": int(r.get("spend_cents") or 0),
            }
            for r in top
        ],
    }


@router.post("/api/admin/beta/grant")
def api_admin_beta_grant(payload: dict, admin: dict = Depends(require_admin)):
    uid = int(payload.get("userId") or payload.get("user_id") or 0)
    amount = int(payload.get("amountCents") or payload.get("amount_cents") or beta_initial_credit_cents())
    reason = str(payload.get("reason") or "admin_beta_grant").strip()[:80] or "admin_beta_grant"
    if uid <= 0:
        raise HTTPException(status_code=400, detail="Invalid userId")
    if amount <= 0 or amount > 100000:
        raise HTTPException(status_code=400, detail="Invalid amount")
    if not fetch_one(_DB, "SELECT id FROM users WHERE id=?;", (uid,)):
        raise HTTPException(status_code=404, detail="User not found")
    ref_id = str(payload.get("requestId") or payload.get("request_id") or new_id("beta_grant"))
    now = ms()
    try:
        cur = _DB.execute(
            """
INSERT OR IGNORE INTO ledger(id,user_id,entry_type,amount_cents,period,ref_id,created_at)
VALUES(?,?,?,?,?,?,?);
""",
            (new_id("beta"), int(uid), "beta_credit", int(amount), reason, ref_id, int(now)),
        )
        _DB.commit()
        credited = int(getattr(cur, "rowcount", 0) or 0) > 0
    except Exception:
        try:
            _DB.rollback()
        except Exception:
            pass
        raise
    return {
        "ok": True,
        "userId": int(uid),
        "credited": bool(credited),
        "amountCents": int(amount if credited else 0),
        "balanceCents": get_user_balance_cents(_DB, uid),
        "adminId": int(admin["id"]),
    }


@router.get("/api/admin/users")
def api_admin_users(
    q: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
    _: dict = Depends(require_admin),
):
    query = str(q or "").strip()
    p = max(1, int(page or 1))
    ps = max(1, min(int(page_size or 20), 100))
    where = ""
    args: list[object] = []
    if query:
        like = f"%{query}%"
        where = "WHERE email LIKE ?"
        args.append(like)
    total_row = fetch_one(_DB, f"SELECT COUNT(1) AS n FROM users {where};", tuple(args)) or {}
    rows = fetch_all(
        _DB,
        f"SELECT {_user_select_fields()} FROM users {where} ORDER BY id DESC LIMIT ? OFFSET ?;",
        tuple(args + [ps, (p - 1) * ps]),
    )
    items = [
        {
            "id": int(r["id"]),
            "identifier": mask_email(str(r.get("email") or "")),
            "email": mask_email(str(r.get("email") or "")),
            "role": str(r.get("role") or "user"),
            "disabled": _is_user_disabled(r),
            "createdAt": int(r.get("created_at") or 0),
            "trial_end_at": None,
        }
        for r in rows
    ]
    return {"ok": True, "items": items, "users": items, "page": p, "page_size": ps, "total": int(total_row.get("n") or 0)}


@router.get("/api/admin/ledger")
def api_admin_ledger(
    user_id: Optional[int] = None,
    limit: int = 200,
    _: dict = Depends(require_admin),
):
    n = max(1, min(int(limit or 200), 500))
    where = ""
    args: list[object] = []
    if user_id:
        where = "WHERE l.user_id=?"
        args.append(int(user_id))
    rows = fetch_all(
        _DB,
        f"""
SELECT l.id,l.user_id,l.entry_type,l.amount_cents,l.period,l.ref_id,l.created_at,u.email
FROM ledger l
LEFT JOIN users u ON u.id=l.user_id
{where}
ORDER BY l.created_at DESC
LIMIT ?;
""",
        tuple(args + [n]),
    )
    items = [
        {
            **dict(r),
            "email": mask_email(str(r.get("email") or "")),
        }
        for r in rows
    ]
    return {"ok": True, "items": items}


@router.get("/api/admin/ssh/audit/recent")
def api_admin_ssh_audit_recent(
    limit: int = 50,
    sessionId: Optional[str] = None,
    eventType: Optional[str] = None,
    beforeStartedAt: Optional[int] = None,
    beforeId: Optional[str] = None,
    _: dict = Depends(require_admin),
):
    """
    Read-only audit feed for SSH/Files/PTY events.
    Query params:
      - limit: 1..200
      - sessionId: optional filter
      - eventType: optional filter (ssh_exec|files_list|files_read|files_write|pty_open|pty_close|pty_lease_create|pty_lease_end)
      - beforeStartedAt/beforeId: cursor for pagination (fetch older than this row)
    """
    import hashlib
    import json

    n = int(limit or 0)
    if n < 1:
        n = 1
    if n > 200:
        n = 200
    sid = (sessionId or "").strip()
    et = (eventType or "").strip()
    bts = int(beforeStartedAt) if isinstance(beforeStartedAt, int) else None
    bid = (beforeId or "").strip()
    where: list[str] = []
    args: list[object] = []
    if sid:
        where.append("session_id=?")
        args.append(sid)
    if et:
        where.append("event_type=?")
        args.append(et)
    if bts is not None:
        # Stable cursor: (started_at DESC, id DESC)
        if bid:
            where.append("(started_at < ? OR (started_at = ? AND id < ?))")
            args.extend([int(bts), int(bts), bid])
        else:
            where.append("started_at < ?")
            args.append(int(bts))
    w = ("WHERE " + " AND ".join(where)) if where else ""
    rows = fetch_all(
        _DB,
        f"""
SELECT id,user_id,session_id,event_type,asset_name,ssh_target,cwd,path,cmd,ok,exit_code,timed_out,stdout_len,stderr_len,started_at,finished_at,duration_ms,error,meta_json
FROM ssh_audit
{w}
ORDER BY started_at DESC, id DESC
LIMIT ?;
""",
        tuple([*args, n]),
    )
    # Keep response stable and small; parse meta_json best-effort.
    expose = (os.environ.get("SSH_AUDIT_EXPOSE_DETAILS") or "").strip().lower() in {"1", "true", "yes", "y", "on"}

    def _sha(s: str) -> str:
        return hashlib.sha256(s.encode("utf-8", errors="ignore")).hexdigest()[:16]

    def _basename(p: str) -> str:
        s = (p or "").strip().replace("\\", "/")
        if not s:
            return ""
        parts = [x for x in s.split("/") if x]
        return parts[-1] if parts else s

    def _cmd_preview(cmd: str) -> str:
        s = (cmd or "").strip()
        if not s:
            return ""
        # show only the binary (first token) to reduce sensitive arg leakage
        return s.split()[0][:120]

    def _filter_meta(meta: dict | None) -> dict | None:
        if not isinstance(meta, dict) or not meta:
            return None
        allow = {
            "ai_mode",
            "manual_active",
            "stdoutTruncated",
            "stderrTruncated",
            "expiresAt",
            "cols",
            "rows",
            "items",
            "isBinary",
            "truncated",
            "bytes",
            "confirm",
            "createBackup",
        }
        outm: dict = {}
        for k, v in meta.items():
            if k in allow:
                outm[k] = v
        return outm or None

    out: list[dict] = []
    for r in rows:
        meta = None
        try:
            raw = r.get("meta_json")
            if isinstance(raw, str) and raw.strip():
                meta = json.loads(raw)
        except Exception:
            meta = None

        cwd0 = str(r.get("cwd") or "")
        path0 = str(r.get("path") or "")
        cmd0 = str(r.get("cmd") or "")
        out.append(
            {
                "id": r.get("id"),
                "userId": r.get("user_id"),
                "sessionId": r.get("session_id"),
                "eventType": r.get("event_type"),
                "assetName": r.get("asset_name"),
                "sshTarget": r.get("ssh_target"),
                # Redaction policy: hide details by default (enable with SSH_AUDIT_EXPOSE_DETAILS=1).
                "cwd": cwd0 if expose else (_basename(cwd0) or None),
                "path": path0 if expose else (_basename(path0) or None),
                "cmd": cmd0 if expose else (_cmd_preview(cmd0) or None),
                # Always provide short hashes for correlation without leaking content.
                "cwdHash": _sha(cwd0) if cwd0 else None,
                "pathHash": _sha(path0) if path0 else None,
                "cmdHash": _sha(cmd0) if cmd0 else None,
                "ok": bool(r.get("ok")) if r.get("ok") is not None else None,
                "exitCode": r.get("exit_code"),
                "timedOut": bool(r.get("timed_out")) if r.get("timed_out") is not None else None,
                "stdoutLen": r.get("stdout_len"),
                "stderrLen": r.get("stderr_len"),
                "startedAt": r.get("started_at"),
                "finishedAt": r.get("finished_at"),
                "durationMs": r.get("duration_ms"),
                "error": r.get("error"),
                "meta": _filter_meta(meta),
            }
        )
    next_cursor = None
    try:
        if out:
            last = out[-1]
            next_cursor = {"beforeStartedAt": last.get("startedAt"), "beforeId": last.get("id")}
    except Exception:
        next_cursor = None
    return {"ok": True, "items": out, "nextCursor": next_cursor}