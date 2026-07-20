from __future__ import annotations

import json
import os
import secrets
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse

from .accounting import ms, new_id, trial_days
from .db import exec_one, fetch_one
from .saas import _DB, _set_session_cookie, _subscription_for, _table_columns, current_user, serialize_user_public
from .security import hash_password

router = APIRouter()


def _auth_enabled(name: str, default: bool = False) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "y", "on"}


def _wechat_login_enabled() -> bool:
    return _auth_enabled("AUTH_WECHAT_LOGIN_ENABLED", default=False)


def _wechat_bind_enabled() -> bool:
    return _auth_enabled("AUTH_WECHAT_LOGIN_ENABLED", default=False)


def _wechat_app_id() -> str:
    v = (os.environ.get("WECHAT_WEB_APP_ID") or "").strip()
    if not v:
        raise HTTPException(status_code=500, detail="WECHAT_WEB_APP_ID not configured")
    return v


def _wechat_app_secret() -> str:
    v = (os.environ.get("WECHAT_WEB_APP_SECRET") or "").strip()
    if not v:
        raise HTTPException(status_code=500, detail="WECHAT_WEB_APP_SECRET not configured")
    return v


def _challenge_ttl_ms() -> int:
    raw = (os.environ.get("AUTH_LOGIN_CHALLENGE_TTL_SEC") or "").strip()
    try:
        sec = max(60, int(raw or "300"))
    except Exception:
        sec = 300
    return sec * 1000


def _wechat_redirect_uri(request: Request) -> str:
    configured = (os.environ.get("WECHAT_WEB_REDIRECT_URI") or "").strip()
    if configured:
        return configured
    return str(request.url_for("api_auth_wechat_web_callback"))


def _challenge_meta(meta_json: str | None) -> dict:
    if not meta_json:
        return {}
    try:
        data = json.loads(meta_json)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


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


def _wechat_qr_url(*, state_token: str, request: Request) -> str:
    appid = _wechat_app_id()
    redirect_uri = quote(_wechat_redirect_uri(request), safe="")
    return (
        "https://open.weixin.qq.com/connect/qrconnect"
        f"?appid={appid}&redirect_uri={redirect_uri}&response_type=code"
        f"&scope=snsapi_login&state={quote(state_token, safe='')}"
        "#wechat_redirect"
    )


def _insert_challenge(*, purpose: str, redirect_uri: str, client_ip: str, ua: str, meta: dict | None = None) -> dict:
    now = ms()
    challenge_id = new_id("wch")
    state_token = secrets.token_urlsafe(24)
    scene_token = secrets.token_urlsafe(12)
    expires_at = now + _challenge_ttl_ms()
    exec_one(
        _DB,
        "INSERT INTO login_challenges(id,purpose,channel,state_token,scene_token,status,user_id,redirect_uri,client_ip,ua,meta_json,created_at,expires_at,consumed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?);",
        (
            challenge_id,
            purpose,
            "wechat_qr",
            state_token,
            scene_token,
            "pending",
            None,
            redirect_uri,
            client_ip or "",
            ua or "",
            json.dumps(meta or {}, ensure_ascii=False, separators=(",", ":")),
            now,
            expires_at,
            None,
        ),
    )
    _DB.commit()
    return {
        "challengeId": challenge_id,
        "state": state_token,
        "sceneToken": scene_token,
        "expiresAt": expires_at,
    }


def _get_challenge_by_id(challenge_id: str) -> dict | None:
    return fetch_one(
        _DB,
        "SELECT id,purpose,channel,state_token,scene_token,status,user_id,redirect_uri,client_ip,ua,meta_json,created_at,expires_at,consumed_at FROM login_challenges WHERE id=?;",
        (challenge_id,),
    )


def _get_challenge_by_state(state_token: str) -> dict | None:
    return fetch_one(
        _DB,
        "SELECT id,purpose,channel,state_token,scene_token,status,user_id,redirect_uri,client_ip,ua,meta_json,created_at,expires_at,consumed_at FROM login_challenges WHERE state_token=?;",
        (state_token,),
    )


def _update_challenge(challenge_id: str, *, status: str, user_id: int | None = None, consumed_at: int | None = None, meta: dict | None = None) -> None:
    row = _get_challenge_by_id(challenge_id)
    if not row:
        return
    merged_meta = _challenge_meta(str(row.get("meta_json") or ""))
    if meta:
        merged_meta.update(meta)
    _DB.execute(
        "UPDATE login_challenges SET status=?, user_id=?, consumed_at=?, meta_json=? WHERE id=?;",
        (
            status,
            user_id,
            consumed_at,
            json.dumps(merged_meta, ensure_ascii=False, separators=(",", ":")),
            challenge_id,
        ),
    )
    _DB.commit()


async def _wechat_exchange_code(code: str) -> dict:
    params = {
        "appid": _wechat_app_id(),
        "secret": _wechat_app_secret(),
        "code": code,
        "grant_type": "authorization_code",
    }
    async with httpx.AsyncClient(timeout=10.0, trust_env=False) as client:
        resp = await client.get("https://api.weixin.qq.com/sns/oauth2/access_token", params=params)
        data = resp.json() if resp.content else {}
    if data.get("errcode"):
        raise HTTPException(status_code=502, detail=f"WeChatTokenError: {data.get('errmsg') or data.get('errcode')}")
    return data


async def _wechat_fetch_profile(access_token: str, openid: str) -> dict:
    async with httpx.AsyncClient(timeout=10.0, trust_env=False) as client:
        resp = await client.get(
            "https://api.weixin.qq.com/sns/userinfo",
            params={"access_token": access_token, "openid": openid, "lang": "zh_CN"},
        )
        data = resp.json() if resp.content else {}
    if data.get("errcode"):
        return {}
    return data if isinstance(data, dict) else {}


def _find_user_by_wechat_identity(openid: str, unionid: str) -> dict | None:
    cols = _table_columns("users")
    if unionid and "wechat_unionid" in cols:
        row = fetch_one(
            _DB,
            "SELECT id,email,role,created_at FROM users WHERE wechat_unionid=?;",
            (unionid,),
        )
        if row:
            return row
    if openid and "wechat_openid" in cols:
        return fetch_one(
            _DB,
            "SELECT id,email,role,created_at FROM users WHERE wechat_openid=?;",
            (openid,),
        )
    return None


def _create_wechat_user(*, openid: str, unionid: str, profile: dict, ip: str) -> dict:
    cols = _table_columns("users")
    now = ms()
    ident = unionid or openid or secrets.token_urlsafe(8)
    email = f"wx.{ident}@wechat.codesprite.local"
    password_hash, password_salt = hash_password(secrets.token_urlsafe(24))

    insert_cols = ["email", "password_hash", "password_salt", "role", "created_at", "updated_at"]
    values: list[object] = [email, password_hash, password_salt, "user", now, now]
    if "display_name" in cols:
        insert_cols.append("display_name")
        values.append(str(profile.get("nickname") or ""))
    if "avatar_url" in cols:
        insert_cols.append("avatar_url")
        values.append(str(profile.get("headimgurl") or ""))
    if "wechat_openid" in cols:
        insert_cols.append("wechat_openid")
        values.append(openid)
    if "wechat_unionid" in cols:
        insert_cols.append("wechat_unionid")
        values.append(unionid or None)
    if "wechat_bound_at" in cols:
        insert_cols.append("wechat_bound_at")
        values.append(now)
    if "last_login_at" in cols:
        insert_cols.append("last_login_at")
        values.append(now)
    if "last_login_ip" in cols:
        insert_cols.append("last_login_ip")
        values.append(ip or "")
    if "status" in cols:
        insert_cols.append("status")
        values.append("active")

    placeholders = ",".join("?" for _ in insert_cols)
    uid = exec_one(
        _DB,
        f"INSERT INTO users({','.join(insert_cols)}) VALUES({placeholders});",
        tuple(values),
    )
    trial_end = now + trial_days() * 24 * 3600
    _DB.execute(
        "INSERT INTO subscriptions(user_id,status,trial_ends_at,current_period_end,created_at,updated_at) VALUES(?,?,?,?,?,?);",
        (uid, "trialing", trial_end, trial_end, now, now),
    )
    _DB.commit()
    return {"id": int(uid), "email": email, "role": "user", "createdAt": now}


def _update_wechat_identity(uid: int, *, openid: str, unionid: str, profile: dict, ip: str) -> None:
    cols = _table_columns("users")
    now = ms()
    sets = ["updated_at=?"]
    args: list[object] = [now]
    if "display_name" in cols and str(profile.get("nickname") or "").strip():
        sets.append("display_name=?")
        args.append(str(profile.get("nickname") or "").strip())
    if "avatar_url" in cols and str(profile.get("headimgurl") or "").strip():
        sets.append("avatar_url=?")
        args.append(str(profile.get("headimgurl") or "").strip())
    if "wechat_openid" in cols:
        sets.append("wechat_openid=?")
        args.append(openid)
    if "wechat_unionid" in cols:
        sets.append("wechat_unionid=?")
        args.append(unionid or None)
    if "wechat_bound_at" in cols:
        sets.append("wechat_bound_at=COALESCE(wechat_bound_at, ?)")
        args.append(now)
    if "last_login_at" in cols:
        sets.append("last_login_at=?")
        args.append(now)
    if "last_login_ip" in cols:
        sets.append("last_login_ip=?")
        args.append(ip or "")
    args.append(uid)
    _DB.execute(f"UPDATE users SET {', '.join(sets)} WHERE id=?;", tuple(args))
    _DB.commit()


def _callback_page(message: str) -> HTMLResponse:
    return HTMLResponse(
        (
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            "<title>CodeSprite 登录</title>"
            "<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;"
            "display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f7f7f7;color:#111}"
            ".card{background:#fff;border:1px solid #e5e5e5;border-radius:14px;padding:24px 28px;box-shadow:0 8px 24px rgba(0,0,0,.06)}</style>"
            f"</head><body><div class='card'>{message}</div></body></html>"
        )
    )


@router.post("/api/auth/wechat/web/challenge")
def api_auth_wechat_web_challenge(payload: dict, request: Request):
    if not _wechat_login_enabled():
        raise HTTPException(status_code=404, detail="WeChat login disabled")
    redirect_uri = str(payload.get("redirectUri") or "").strip()
    challenge = _insert_challenge(
        purpose="login",
        redirect_uri=redirect_uri,
        client_ip=request.client.host if request.client else "",
        ua=request.headers.get("user-agent", ""),
    )
    challenge["qrUrl"] = _wechat_qr_url(state_token=challenge["state"], request=request)
    return {"ok": True, **challenge}


@router.get("/api/auth/wechat/web/challenge/{challenge_id}")
def api_auth_wechat_web_challenge_status(challenge_id: str):
    row = _get_challenge_by_id(challenge_id)
    if not row:
        raise HTTPException(status_code=404, detail="Challenge not found")
    now = ms()
    status = str(row.get("status") or "pending")
    if int(row.get("expires_at") or 0) < now and status in {"pending", "scanned"}:
        status = "expired"
        _update_challenge(challenge_id, status="expired", user_id=row.get("user_id"))
    meta = _challenge_meta(str(row.get("meta_json") or ""))
    return {
        "ok": True,
        "challengeId": challenge_id,
        "purpose": str(row.get("purpose") or "login"),
        "status": status,
        "expiresAt": int(row.get("expires_at") or 0),
        "reason": meta.get("reason"),
    }


@router.get("/api/auth/wechat/web/callback")
async def api_auth_wechat_web_callback(request: Request, code: str = "", state: str = ""):
    if not _wechat_login_enabled():
        raise HTTPException(status_code=404, detail="WeChat login disabled")
    if not code or not state:
        raise HTTPException(status_code=400, detail="Missing code or state")
    row = _get_challenge_by_state(state)
    if not row:
        raise HTTPException(status_code=400, detail="Invalid state")
    now = ms()
    if int(row.get("expires_at") or 0) < now:
        _update_challenge(str(row["id"]), status="expired", user_id=row.get("user_id"))
        raise HTTPException(status_code=400, detail="Challenge expired")

    token_data = await _wechat_exchange_code(code)
    openid = str(token_data.get("openid") or "").strip()
    unionid = str(token_data.get("unionid") or "").strip()
    profile = {}
    access_token = str(token_data.get("access_token") or "").strip()
    if access_token and openid:
        profile = await _wechat_fetch_profile(access_token, openid)
        unionid = unionid or str(profile.get("unionid") or "").strip()

    ip = request.client.host if request.client else ""
    purpose = str(row.get("purpose") or "login")
    meta = _challenge_meta(str(row.get("meta_json") or ""))

    if purpose == "bind_wechat":
        bind_user_id = int(meta.get("bindUserId") or 0)
        if not bind_user_id:
            _update_challenge(str(row["id"]), status="failed", meta={"reason": "bind_user_missing"})
            return _callback_page("绑定失败：缺少绑定上下文，请返回重新发起。")
        exist = _find_user_by_wechat_identity(openid, unionid)
        if exist and int(exist["id"]) != bind_user_id:
            _update_challenge(str(row["id"]), status="failed", meta={"reason": "wechat_already_bound"})
            return _callback_page("该微信已绑定其他账号，无法继续绑定。")
        _update_wechat_identity(bind_user_id, openid=openid, unionid=unionid, profile=profile, ip=ip)
        _update_challenge(str(row["id"]), status="confirmed", user_id=bind_user_id)
        _audit("wechat_bind_callback", "ok", user_id=bind_user_id, identifier=unionid or openid, ip=ip, ua=request.headers.get("user-agent", ""))
        return _callback_page("微信绑定成功，请返回原页面继续。")

    user = _find_user_by_wechat_identity(openid, unionid)
    if user:
        uid = int(user["id"])
        _update_wechat_identity(uid, openid=openid, unionid=unionid, profile=profile, ip=ip)
    else:
        user = _create_wechat_user(openid=openid, unionid=unionid, profile=profile, ip=ip)
        uid = int(user["id"])
    _update_challenge(str(row["id"]), status="confirmed", user_id=uid)
    _audit("wechat_login_callback", "ok", user_id=uid, identifier=unionid or openid, ip=ip, ua=request.headers.get("user-agent", ""))
    return _callback_page("扫码成功，请返回原页面完成登录。")


@router.post("/api/auth/wechat/web/exchange")
def api_auth_wechat_web_exchange(payload: dict, resp: Response):
    if not _wechat_login_enabled():
        raise HTTPException(status_code=404, detail="WeChat login disabled")
    challenge_id = str(payload.get("challengeId") or "").strip()
    if not challenge_id:
        raise HTTPException(status_code=400, detail="Missing challengeId")
    row = _get_challenge_by_id(challenge_id)
    if not row:
        raise HTTPException(status_code=404, detail="Challenge not found")
    if str(row.get("purpose") or "login") != "login":
        raise HTTPException(status_code=400, detail="Invalid challenge purpose")
    if str(row.get("status") or "") != "confirmed":
        raise HTTPException(status_code=409, detail="Challenge not ready")
    if row.get("consumed_at"):
        raise HTTPException(status_code=409, detail="Challenge already consumed")
    uid = int(row.get("user_id") or 0)
    if uid <= 0:
        raise HTTPException(status_code=409, detail="Challenge missing user")
    _update_challenge(challenge_id, status="consumed", user_id=uid, consumed_at=ms())
    user = serialize_user_public(uid)
    _set_session_cookie(resp, uid, str(user["role"]))
    return {"ok": True, "user": user, "subscription": _subscription_for(uid)}


@router.post("/api/me/wechat/bind/start")
def api_me_wechat_bind_start(payload: dict, request: Request, u: dict = Depends(current_user)):
    if not _wechat_bind_enabled():
        raise HTTPException(status_code=404, detail="WeChat bind disabled")
    uid = int(u["id"])
    challenge = _insert_challenge(
        purpose="bind_wechat",
        redirect_uri=str(payload.get("redirectUri") or "").strip(),
        client_ip=request.client.host if request.client else "",
        ua=request.headers.get("user-agent", ""),
        meta={"bindUserId": uid},
    )
    challenge["qrUrl"] = _wechat_qr_url(state_token=challenge["state"], request=request)
    return {"ok": True, **challenge}


@router.post("/api/me/wechat/unbind")
def api_me_wechat_unbind(u: dict = Depends(current_user)):
    uid = int(u["id"])
    cols = _table_columns("users")
    if "wechat_openid" not in cols and "wechat_unionid" not in cols:
        raise HTTPException(status_code=400, detail="WeChat binding not supported")
    row = fetch_one(
        _DB,
        "SELECT phone, phone_verified_at, wechat_openid, wechat_unionid FROM users WHERE id=?;",
        (uid,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    if not row.get("phone_verified_at"):
        raise HTTPException(status_code=409, detail="Bind a phone before unbinding WeChat")
    _DB.execute(
        "UPDATE users SET wechat_openid=NULL, wechat_unionid=NULL, wechat_bound_at=NULL, updated_at=? WHERE id=?;",
        (ms(), uid),
    )
    _DB.commit()
    _audit("wechat_unbind", "ok", user_id=uid, identifier=str(row.get("phone") or ""), ip="", ua="")
    return {"ok": True}
