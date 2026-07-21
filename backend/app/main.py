from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import socket
import time
import io
from pathlib import Path
from typing import AsyncIterator
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import FastAPI, HTTPException
from fastapi import Response
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from starlette.requests import Request

import paramiko

from .public_releases import load_releases_payload
from .db import create_engine, create_sessionmaker
from .models import Base, User
from .security import hash_password, verify_password

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError

app = FastAPI(title='CodeSprite backend')

# --- Minimal auth (admin console MVP) ---
# Notes:
# - Same-domain cookie session for /admin (recommended in docs).
# - Uses AUTH_SECRET for signing; keep it stable across deploys.
# - For MVP, admin credentials are taken from env:
#     ADMIN_USER / ADMIN_PASS
#   (Replace with DB-backed users later.)
_COOKIE_NAME = "cs_session_v1"


def _auth_secret() -> str:
    return os.environ.get("AUTH_SECRET", "").strip()

def _cookie_secure() -> bool:
    v = (os.environ.get("COOKIE_SECURE") or "").strip().lower()
    if v in {"1", "true", "yes", "y", "on"}:
        return True
    if v in {"0", "false", "no", "n", "off"}:
        return False
    # default: secure in prod
    return True


def _admin_user() -> str:
    return os.environ.get("ADMIN_USER", "").strip() or "admin"


def _admin_pass() -> str:
    return os.environ.get("ADMIN_PASS", "").strip() or ""


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("ascii"))


def _sign(data: bytes, secret: str) -> str:
    return _b64url(hmac.new(secret.encode("utf-8"), data, hashlib.sha256).digest())


def _make_session(payload: dict) -> str:
    secret = _auth_secret()
    if not secret:
        # Hard fail: without a stable secret, cookie sessions will be unreliable.
        raise HTTPException(status_code=500, detail="AUTH_SECRET not configured")
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return f"{_b64url(raw)}.{_sign(raw, secret)}"


def _verify_session(token: str) -> dict | None:
    secret = _auth_secret()
    if not secret:
        return None
    if not token or "." not in token:
        return None
    b64, sig = token.split(".", 1)
    try:
        raw = _b64url_decode(b64)
    except Exception:
        return None
    expected = _sign(raw, secret)
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        obj = json.loads(raw.decode("utf-8"))
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def _require_admin(request: Request) -> dict:
    token = request.cookies.get(_COOKIE_NAME, "")
    sess = _verify_session(token)
    if not sess or sess.get("role") != "admin":
        raise HTTPException(status_code=401, detail="Unauthorized")
    return sess

# --- DB bootstrap (MySQL) ---
_engine = None
_Session = None


def _db_enabled() -> bool:
    return bool(os.environ.get("DB_DSN", "").strip())


async def _init_db():
    global _engine, _Session
    if not _db_enabled():
        return
    _engine = create_engine()
    _Session = create_sessionmaker(_engine)
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Ensure admin user exists (requires ADMIN_PASS)
    admin_pw = _admin_pass()
    if not admin_pw:
        return
    async with _Session() as s:
        r = await s.execute(select(User).where(User.identifier == _admin_user()))
        u = r.scalar_one_or_none()
        if u is None:
            now = datetime.now(timezone.utc)
            # default trial: 7 days (can be moved to config later)
            u = User(
                identifier=_admin_user(),
                password_hash=hash_password(admin_pw),
                role="admin",
                trial_start_at=now,
                trial_end_at=now + timedelta(days=7),
            )
            s.add(u)
            await s.commit()


@app.on_event("startup")
async def _on_startup():
    try:
        await _init_db()
    except Exception as e:
        # Fail fast when DB is configured but not usable.
        if _db_enabled():
            raise
        # If DB not enabled, ignore.
        _ = e

# --- Web (static) hosting ---
# Goal: enable a single-process "web mode" where FastAPI serves the built frontend
# (frontend/dist) and provides /api/* endpoints for the UI.
#
# This keeps the existing dev flow intact (Vite on :5173 + proxy to backend),
# while adding a minimal-change production-style path:
#   1) build frontend -> frontend/dist
#   2) run backend -> serve UI + /api/*
#
_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_FRONTEND_DIST = _REPO_ROOT / "frontend" / "dist"


def _frontend_dist_dir() -> Path | None:
    p = os.environ.get("FRONTEND_DIST", "").strip()
    dist = Path(p) if p else _DEFAULT_FRONTEND_DIST
    if dist.exists() and dist.is_dir():
        return dist
    return None


def _serve_frontend_enabled() -> bool:
    v = (os.environ.get("SERVE_FRONTEND") or "").strip().lower()
    if v in {"1", "true", "yes", "y", "on"}:
        return True
    # Auto-enable if dist exists (safe default for local runs; can be disabled via SERVE_FRONTEND=0)
    if v in {"0", "false", "no", "n", "off"}:
        return False
    return _frontend_dist_dir() is not None


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        'http://127.0.0.1:5173',
        'http://localhost:5173',
        'http://127.0.0.1:4173',
        'http://localhost:4173',
        'http://127.0.0.1:8030',
        'http://localhost:8030',
    ],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

# ASCII-only Chinese strings via unicode escapes (avoid Windows encoding corruption)
_CN_PLACEHOLDER = '\uFF08\u5360\u4F4D\u6D41\u5F0F\u56DE\u590D\uFF09\n'
_CN_SESSION = '\u4F1A\u8BDDID\uFF1A'
_CN_YOU_SAID = '\u4F60\u8BF4\uFF1A'
_CN_NEXT = (
    '\u4E0B\u4E00\u6B65\uFF1A\u8FD9\u91CC\u63A5\u5165\u672C\u5730\u6A21\u578B\uFF08\u4F8B\u5982 Ollama\uFF09\u5E76\u628A token \u6309\u6D41\u5F0F\u8FD4\u56DE\u3002\n'
)

_CN_MODEL_NOT_READY = (
    '\u672A\u68C0\u6D4B\u5230\u672C\u5730\u6A21\u578B\u670D\u52A1\u3002\n'
    '\u8BF7\u5148\u5B89\u88C5\u5E76\u542F\u52A8 Ollama\uFF0C\u7136\u540E\u6267\u884C\uff1aollama pull qwen2.5-coder:1.5b\n'
)

#
# LLM system prompt (Cursor-like)
# - When context is attached, treat it as ground truth.
#
_SYS_PROMPT_BASE = (
    "You are CodeSprite, a senior engineering/SRE assistant.\n"
    "Be concise, actionable, and do not invent command outputs.\n"
)

_SYS_PROMPT_WITH_CONTEXT = (
    _SYS_PROMPT_BASE
    + "\n"
    + "The user may attach CONTEXT blocks (files/dirs/terminal output). Treat CONTEXT as ground truth.\n"
    + "- Prefer using CONTEXT over assumptions.\n"
    + "- If the question requires information not present in CONTEXT, say what is missing and what command/output is needed.\n"
    + "- When referencing terminal info, quote the relevant lines.\n"
    + "\n"
    + "Strictness rules (to avoid wrong 'guesses'):\n"
    + "- Only state facts that are explicitly present in CONTEXT.\n"
    + "- Do NOT guess user intent unless asked.\n"
)

# Tool/Agent mode (frontend executes tools; LLM emits tool-call blocks).
_TOOL_PROMPT = (
    "\n\n"
    "You may request the UI to run tools on the user's connected workspace.\n"
    "Rules:\n"
    "- Only request tools when the user asks to run/check/modify something on the remote machine.\n"
    "- Do NOT invent command outputs. If you need data, request a tool.\n"
    "- Use ONLY the following tool call format, as a standalone fenced code block:\n"
    "```tool\n"
    "{\"tool\":\"ssh_exec\",\"args\":{\"command\":\"df -h\",\"cwd\":\".\"}}\n"
    "```\n"
    "Tools:\n"
    "- ssh_exec: run a shell command (args: command, optional cwd)\n"
    "- files_list: list a dir (args: path)\n"
    "- files_read: read a file (args: path)\n"
    "- files_write: write a file (args: path, content)\n"
    "Safety:\n"
    "- Avoid dangerous commands (rm -rf/mkfs/dd/reboot). If requested, ask for confirmation and propose safer steps.\n"
)


def _tool_env_block(payload: dict) -> str:
    """
    Best-effort, bounded-size environment hints for tool mode.
    This is injected into SYSTEM prompt (not shown to user).
    """
    try:
        if not isinstance(payload, dict):
            return ""
        tool_mode = bool(payload.get("tool_mode") or payload.get("toolMode") or False)
        if not tool_mode:
            return ""
        env = payload.get("tool_env") or payload.get("toolEnv") or ""
        if not isinstance(env, str):
            return ""
        env = env.strip()
        if not env:
            return ""
        # hard cap to prevent prompt abuse
        if len(env) > 4000:
            env = env[:4000] + "…"
        return "\n\nWORKSPACE ENV:\n" + env + "\n"
    except Exception:
        return ""


def _ctx_text_from_payload(payload: dict) -> str:
    """
    Assemble bounded CONTEXT text from payload['context_items'] (frontend-controlled).
    """
    try:
        items = payload.get("context_items") or payload.get("contextItems") or []
        if not isinstance(items, list) or not items:
            return ""
        parts: list[str] = []
        max_total = 120_000  # chars
        used = 0
        for it in items[:12]:
            if not isinstance(it, dict):
                continue
            kind = str(it.get("kind") or it.get("type") or "context")
            title = str(it.get("title") or it.get("path") or it.get("name") or kind)
            content = str(it.get("content") or it.get("text") or "")
            if not content:
                continue
            if len(content) > 20_000:
                content = content[:20_000] + "\n…(truncated)…\n"
            block = f"### {title}\n\n```text\n{content}\n```\n"
            if used + len(block) > max_total:
                break
            parts.append(block)
            used += len(block)
        return "\n\n".join(parts) if parts else ""
    except Exception:
        return ""


def _ollama_base_url() -> str:
    return os.environ.get('OLLAMA_BASE_URL', 'http://127.0.0.1:11434').rstrip('/')


def _ollama_model() -> str:
    # Default to a smaller model for faster first-time setup; override via OLLAMA_MODEL.
    return os.environ.get('OLLAMA_MODEL', 'qwen2.5-coder:1.5b')


@app.get('/health')
def health():
    return {'ok': True, 'port': os.environ.get('PORT', '')}


@app.get('/model/health')
async def model_health():
    url = _ollama_base_url() + '/api/tags'
    try:
        async with httpx.AsyncClient(timeout=2.5, trust_env=False) as client:
            r = await client.get(url)
            return {'ok': r.status_code == 200, 'status': r.status_code, 'url': url, 'model': _ollama_model()}
    except Exception as e:
        return {'ok': False, 'error': str(e), 'url': url, 'model': _ollama_model()}


@app.get('/models')
async def models():
    """Return available Ollama models (tags)."""
    url = _ollama_base_url() + '/api/tags'
    try:
        async with httpx.AsyncClient(timeout=3.5, trust_env=False) as client:
            r = await client.get(url)
            r.raise_for_status()
            data = r.json() if r.content else {}
            items = data.get('models') or []
            names: list[str] = []
            for m in items:
                n = m.get('name') if isinstance(m, dict) else None
                if isinstance(n, str) and n:
                    names.append(n)
            return {'ok': True, 'models': names, 'default': _ollama_model()}
    except Exception as e:
        return {'ok': False, 'error': str(e), 'models': [], 'default': _ollama_model()}


async def _stream_placeholder(session_id: str, message: str) -> AsyncIterator[bytes]:
    intro = (
        _CN_PLACEHOLDER
        + _CN_SESSION
        + (session_id or 'N/A')
        + '\n'
        + _CN_YOU_SAID
        + message
        + '\n\n'
        + _CN_NEXT
    )
    for ch in intro:
        yield ch.encode('utf-8')
        await asyncio.sleep(0.001)

    tail = '\n\n' + json.dumps({'done': True}, ensure_ascii=False) + '\n'
    for ch in tail:
        yield ch.encode('utf-8')
        await asyncio.sleep(0.0005)


async def _stream_ollama(*, message: str, model: str, system_prompt: str) -> AsyncIterator[bytes]:
    url = _ollama_base_url() + '/api/chat'
    payload = {
        'model': model,
        'stream': True,
        'messages': [
            {'role': 'system', 'content': system_prompt or _SYS_PROMPT_BASE},
            {'role': 'user', 'content': message},
        ],
    }

    async with httpx.AsyncClient(timeout=None, trust_env=False) as client:
        async with client.stream('POST', url, json=payload) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue

                msg = obj.get('message') or {}
                content = msg.get('content')
                if content:
                    yield str(content).encode('utf-8')

                if obj.get('done') is True:
                    break


@app.post('/chat')
async def chat(payload: dict):
    session_id = str(payload.get('session_id') or '')
    message = str(payload.get('message') or '')
    model = str(payload.get('model') or '').strip() or _ollama_model()

    ctx_text = _ctx_text_from_payload(payload)
    final_msg = message
    if ctx_text:
        final_msg = f"{ctx_text}\n\n---\n\n用户问题：\n{message}"

    tool_mode = bool(payload.get("tool_mode") or payload.get("toolMode") or False)
    base_sys = _SYS_PROMPT_WITH_CONTEXT if ctx_text else _SYS_PROMPT_BASE
    system_prompt = base_sys + (_TOOL_PROMPT if tool_mode else "") + _tool_env_block(payload)

    async def gen() -> AsyncIterator[bytes]:
        try:
            async with httpx.AsyncClient(timeout=1.5, trust_env=False) as client:
                await client.get(_ollama_base_url() + '/api/tags')

            async for chunk in _stream_ollama(message=final_msg, model=model, system_prompt=system_prompt):
                yield chunk
        except Exception:
            for ch in _CN_MODEL_NOT_READY:
                yield ch.encode('utf-8')
                await asyncio.sleep(0.0005)
            async for chunk in _stream_placeholder(session_id, message):
                yield chunk

    return StreamingResponse(gen(), media_type='text/plain; charset=utf-8')


# --- Web-mode API aliases ---
# The React UI calls /api/* (dev via Vite proxy). For a single-process web deployment
# we expose /api/* endpoints that map to the same handlers.
@app.get('/api/health')
def api_health():
    return health()


@app.get('/api/model/health')
async def api_model_health():
    return await model_health()


@app.get('/api/models')
async def api_models():
    return await models()


@app.post('/api/chat')
async def api_chat(payload: dict):
    return await chat(payload)


def _guess_os_from_ssh_banner(banner: str) -> str:
    s = (banner or "").lower()
    # common server fingerprints
    if "ubuntu" in s:
        return "Ubuntu"
    if "debian" in s:
        return "Debian"
    if "centos" in s:
        return "CentOS"
    if "rocky" in s:
        return "Rocky"
    if "almalinux" in s or "alma" in s:
        return "AlmaLinux"
    if "openssh_for_windows" in s or "windows" in s:
        return "Windows"
    if "openssh" in s:
        return "Linux"
    return "Unknown"


@app.post("/api/ssh/test")
async def api_ssh_test(payload: dict):
    """
    Lightweight connectivity check for SSH-like endpoints.
    - Measures TCP connect latency
    - Reads SSH banner (if available) to guess OS
    Does NOT perform authentication (safe for MVP).
    """
    address = str(payload.get("address") or payload.get("host") or payload.get("ip") or "").strip()
    port_raw = payload.get("port", 22)
    try:
        port = int(port_raw)
    except Exception:
        port = 22
    if not address:
        raise HTTPException(status_code=400, detail="Missing address")
    if port < 1 or port > 65535:
        raise HTTPException(status_code=400, detail="Invalid port")

    timeout_s = 3.0
    t0 = time.perf_counter()
    try:
        sock = socket.create_connection((address, port), timeout=timeout_s)
        sock.settimeout(0.6)
        banner = ""
        try:
            data = sock.recv(256) or b""
            banner = data.decode("utf-8", errors="ignore").strip()
        except Exception:
            banner = ""
        finally:
            try:
                sock.close()
            except Exception:
                pass
        latency_ms = int((time.perf_counter() - t0) * 1000)
        os_name = _guess_os_from_ssh_banner(banner)
        return {
            "ok": True,
            "success": True,
            "latency_ms": latency_ms,
            "latency": f"{latency_ms}ms",
            "os": os_name,
            "banner": banner,
        }
    except Exception as e:
        latency_ms = int((time.perf_counter() - t0) * 1000)
        return {
            "ok": True,
            "success": False,
            "latency_ms": latency_ms,
            "latency": f"{latency_ms}ms",
            "os": "Unknown",
            "error": str(e),
        }


def _ssh_exec_allowed(cmd: str) -> bool:
    """
    P0: minimal safe allowlist for exec.
    - Non-interactive
    - No shell metacharacters
    - Only a few read-only probe commands
    """
    c = (cmd or "").strip()
    if not c:
        return False
    # forbid obvious shell meta / chaining / redirection
    bad = [";", "&&", "||", "|", ">", "<", "$(", "`", "\n", "\r"]
    if any(x in c for x in bad):
        return False
    allow = {
        "pwd",
        "whoami",
        "id",
        "uname -a",
        "ls",
        "ls -la",
    }
    return c in allow


def _ssh_exec_sync(
    *,
    address: str,
    port: int,
    username: str,
    auth_type: str,
    password: str | None,
    private_key: str | None,
    cmd: str,
    timeout_s: float,
) -> dict:
    t0 = time.perf_counter()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        connect_kwargs: dict = {
            "hostname": address,
            "port": port,
            "username": username,
            "timeout": min(8.0, timeout_s),
            "banner_timeout": min(8.0, timeout_s),
            "auth_timeout": min(8.0, timeout_s),
            "look_for_keys": False,
            "allow_agent": False,
        }

        if auth_type == "password":
            if not password:
                raise ValueError("Missing password")
            connect_kwargs["password"] = password
        elif auth_type == "ssh_key":
            if not private_key:
                raise ValueError("Missing private_key")
            key_obj = None
            last_err: Exception | None = None
            for KeyCls in (paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.RSAKey):
                try:
                    key_obj = KeyCls.from_private_key(io.StringIO(private_key))
                    break
                except Exception as e:
                    last_err = e
                    continue
            if key_obj is None:
                raise ValueError(f"Invalid private_key: {last_err or 'unknown'}")
            connect_kwargs["pkey"] = key_obj
        else:
            raise ValueError("Invalid auth_type")

        client.connect(**connect_kwargs)

        # Exec command (non-interactive)
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout_s)
        # limit output to avoid memory blow-up
        out_b = stdout.read(64 * 1024) or b""
        err_b = stderr.read(64 * 1024) or b""
        exit_code = stdout.channel.recv_exit_status()
        dur_ms = int((time.perf_counter() - t0) * 1000)
        return {
            "ok": True,
            "success": True,
            "stdout": out_b.decode("utf-8", errors="replace"),
            "stderr": err_b.decode("utf-8", errors="replace"),
            "exit_code": int(exit_code),
            "duration_ms": dur_ms,
        }
    finally:
        try:
            client.close()
        except Exception:
            pass


@app.post("/api/ssh/exec")
async def api_ssh_exec(payload: dict):
    """
    P0-2: Execute ONE short command via SSH (non-interactive).
    - Requires user-provided auth (NOT persisted).
    - Uses a strict allowlist for safety in MVP.
    """
    address = str(payload.get("address") or "").strip()
    port_raw = payload.get("port", 22)
    username = str(payload.get("username") or payload.get("user") or "").strip() or "root"
    cmd = str(payload.get("cmd") or payload.get("command") or "").strip()

    try:
        port = int(port_raw)
    except Exception:
        port = 22

    if not address:
        raise HTTPException(status_code=400, detail="Missing address")
    if port < 1 or port > 65535:
        raise HTTPException(status_code=400, detail="Invalid port")
    if not cmd:
        raise HTTPException(status_code=400, detail="Missing cmd")
    if not _ssh_exec_allowed(cmd):
        raise HTTPException(status_code=400, detail="Command not allowed in MVP")

    auth = payload.get("auth") or {}
    if not isinstance(auth, dict):
        auth = {}
    auth_type = str(auth.get("type") or payload.get("auth_type") or "").strip()
    password = str(auth.get("password") or payload.get("password") or "") if auth_type == "password" else None
    private_key = str(auth.get("private_key") or payload.get("private_key") or "") if auth_type == "ssh_key" else None

    timeout_s = 12.0
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(
                _ssh_exec_sync,
                address=address,
                port=port,
                username=username,
                auth_type=auth_type,
                password=password,
                private_key=private_key,
                cmd=cmd,
                timeout_s=timeout_s,
            ),
            timeout=timeout_s + 2.0,
        )
    except HTTPException:
        raise
    except asyncio.TimeoutError:
        return {"ok": True, "success": False, "error": "timeout"}
    except Exception as e:
        # Do NOT include secrets; only return message.
        return {"ok": True, "success": False, "error": str(e)}


@app.get('/public/releases')
def public_releases():
    return load_releases_payload()


@app.get('/api/public/releases')
def api_public_releases():
    return load_releases_payload()

@app.post("/api/auth/login")
async def api_auth_login(payload: dict, response: Response):
    """
    MVP login:
      - identifier: string
      - password: string
    Only supports admin user for now.
    """
    identifier = str(payload.get("identifier") or "").strip()
    password = str(payload.get("password") or "").strip()

    if not identifier or not password:
        raise HTTPException(status_code=400, detail="Missing identifier or password")
    # Require explicit ADMIN_PASS to avoid accidental exposure.
    if not _admin_pass():
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # Prefer DB-backed admin when enabled; fallback to env-only for minimal setups.
    if _db_enabled() and _Session is not None:
        async with _Session() as s:
            r = await s.execute(select(User).where(User.identifier == identifier))
            u = r.scalar_one_or_none()
            if not u or u.disabled or u.role != "admin" or not verify_password(password, u.password_hash):
                raise HTTPException(status_code=401, detail="Invalid credentials")
    else:
        if identifier != _admin_user() or password != _admin_pass():
            raise HTTPException(status_code=401, detail="Invalid credentials")

    token = _make_session({"role": "admin", "sub": identifier})
    response.set_cookie(
        key=_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
        path="/",
        max_age=60 * 60 * 24 * 7,
    )
    return {"ok": True, "role": "admin"}


@app.post("/api/auth/logout")
async def api_auth_logout(response: Response):
    response.delete_cookie(key=_COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/me")
async def api_me(request: Request):
    token = request.cookies.get(_COOKIE_NAME, "")
    sess = _verify_session(token)
    if not sess:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return {"ok": True, "user": {"role": sess.get("role", "user"), "sub": sess.get("sub", "")}}


@app.get("/api/admin/stats")
async def api_admin_stats(request: Request):
    _require_admin(request)
    if not _db_enabled() or _Session is None:
        return {"ok": True, "users_total": 0, "subscriptions_active": 0, "trial_expiring": 0, "note": "DB not enabled"}
    async with _Session() as s:
        users_total = (await s.execute(select(func.count()).select_from(User))).scalar_one()
        # For MVP, treat role=user as "product users"; subscriptions not wired yet.
        trial_expiring = 0
        return {"ok": True, "users_total": int(users_total), "subscriptions_active": 0, "trial_expiring": trial_expiring}


@app.get("/api/admin/users")
async def api_admin_users(request: Request, q: str = "", page: int = 1, page_size: int = 20):
    _require_admin(request)
    if not _db_enabled() or _Session is None:
        return {"ok": True, "items": [], "page": page, "page_size": page_size, "total": 0, "note": "DB not enabled"}
    page = max(1, int(page))
    page_size = min(100, max(1, int(page_size)))
    q = (q or "").strip()
    async with _Session() as s:
        stmt = select(User).order_by(User.id.desc())
        if q:
            stmt = stmt.where(User.identifier.like(f"%{q}%"))
        total = (await s.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
        rows = await s.execute(stmt.limit(page_size).offset((page - 1) * page_size))
        items = []
        for u in rows.scalars().all():
            items.append(
                {
                    "id": u.id,
                    "identifier": u.identifier,
                    "role": u.role,
                    "disabled": bool(u.disabled),
                    "trial_end_at": u.trial_end_at.isoformat() if u.trial_end_at else None,
                    "created_at": u.created_at.isoformat() if u.created_at else None,
                }
            )
        return {"ok": True, "items": items, "page": page, "page_size": page_size, "total": int(total)}


# --- Static frontend (SPA) ---
if _serve_frontend_enabled():
    _dist = _frontend_dist_dir()

    if _dist is not None:
        @app.get("/", include_in_schema=False)
        def ui_root():
            return FileResponse(_dist / "index.html")

        @app.get("/{path:path}", include_in_schema=False)
        def ui_fallback(path: str, request: Request):
            # Do not interfere with API routes
            if path.startswith("api/"):
                # (Normally /api/* routes match earlier; this is a safety net.)
                raise HTTPException(status_code=404, detail="Not Found")

            candidate = (_dist / path).resolve()
            # Prevent path traversal
            try:
                candidate.relative_to(_dist.resolve())
            except Exception:
                return FileResponse(_dist / "index.html")

            if candidate.is_file():
                return FileResponse(candidate)

            # SPA fallback
            return FileResponse(_dist / "index.html")
