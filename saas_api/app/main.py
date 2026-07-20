from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from pathlib import Path
from typing import AsyncIterator

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from starlette.requests import Request

from .public_releases import load_releases_payload
from .llm_gateway import load_upstreams, list_models, stream_chat
from .billing import can_start_llm_call, charge_llm_usage, record_llm_usage
from .accounting import beta_max_concurrent_per_user, beta_max_output_chars, beta_mode_enabled
from .db import connect, init_db, db_require_mysql
from .saas import current_user, SESSION_COOKIE

app = FastAPI(title='cursor-like backend')

_DB = connect()
init_db(_DB)

_ACTIVE_LLM_CALLS: dict[int, int] = {}
_ACTIVE_LLM_LOCK = threading.Lock()

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
    '\u672A\u914D\u7F6E\u53EF\u7528\u7684 AI \u6A21\u578B\u670D\u52A1\u3002\n'
    '\u53EF\u9009\u65B9\u6848\uff1a\n'
    '- \u672C\u673A Ollama\uff1a\u542F\u52A8 11434 \u5E76\u914D\u7F6E OLLAMA_BASE_URL/OLLAMA_MODEL\n'
    '- \u4E91\u7AEF\uff08\u63A8\u8350\u7ED3\u5408\u56FD\u5185\u4F9B\u5E94\u5546\uff09\uff1A\u914D\u7F6E LLM_UPSTREAMS_JSON \u6216 LLM_BASE_URL/LLM_API_KEY\n'
)
_BETA_OUTPUT_LIMIT_TEXT = "\n\n[Beta output limit reached. Please narrow the request or wait for quota refresh.]\n"


def _try_enter_llm_call(uid: int) -> bool:
    if not beta_mode_enabled():
        return True
    limit = beta_max_concurrent_per_user()
    with _ACTIVE_LLM_LOCK:
        current = int(_ACTIVE_LLM_CALLS.get(uid, 0))
        if current >= limit:
            return False
        _ACTIVE_LLM_CALLS[uid] = current + 1
        return True


def _leave_llm_call(uid: int) -> None:
    if not beta_mode_enabled():
        return
    with _ACTIVE_LLM_LOCK:
        current = int(_ACTIVE_LLM_CALLS.get(uid, 0))
        if current <= 1:
            _ACTIVE_LLM_CALLS.pop(uid, None)
        else:
            _ACTIVE_LLM_CALLS[uid] = current - 1

#
# LLM system prompt
# - Keep it stable and explicit: when context is attached, the model must treat it as ground truth.
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
    + "- IMPORTANT: CONTEXT may contain both an inventory/profile name (e.g. asset_name) and a remote hostname (remote_hostname from shell prompt). Do NOT assume they are the same.\n"
    + "\n"
    + "Strictness rules (to avoid wrong 'guesses'):\n"
    + "- Only state facts that are explicitly present in CONTEXT.\n"
    + "- Do NOT guess user intent (e.g. 'you are probably doing SSL') unless asked. If you must infer, label it clearly as a hypothesis and explain the evidence.\n"
    + "- When the user asks 'where am I / what did I run', answer with a short FACTS list and include evidence quotes.\n"
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


def _terminal_state_block(payload: dict) -> str:
    """
    Inject TerminalState + ai_mode into SYSTEM prompt (not shown to user).
    This is the cross-mode "world model" and MUST be preserved across Ask/Plan/Execute/Debug.
    """
    try:
        if not isinstance(payload, dict):
            return ""
        ai_mode = str(payload.get("ai_mode") or payload.get("aiMode") or "").strip().lower()
        if ai_mode not in {"ask", "plan", "execute", "debug"}:
            ai_mode = ""
        ts = payload.get("terminal_state") or payload.get("terminalState") or None
        if ts is None:
            return ("\n\nAI_MODE:\n" + ai_mode + "\n") if ai_mode else ""
        raw = json.dumps(ts, ensure_ascii=False)
        if len(raw) > 20_000:
            raw = raw[:20_000] + "…"
        out = "\n\nTERMINAL_STATE(JSON):\n" + raw + "\n"
        if ai_mode:
            out = "\n\nAI_MODE:\n" + ai_mode + "\n" + out
        return out
    except Exception:
        return ""


@app.get('/health')
def health():
    return {
        'ok': True,
        'port': os.environ.get('PORT', ''),
        'db': {
            'kind': _DB.kind,
            'requireMySQL': db_require_mysql(),
        },
        'auth': {
            'sessionBackend': 'signed-cookie',
            'sessionStore': 'stateless',
            'userStore': 'mysql' if _DB.kind == 'mysql' else 'sqlite',
        },
        'cache': {
            'userStore': 'disabled',
            'recommendedUsage': ['rate_limit', 'short_ttl_read_model'],
        },
    }


@app.get('/model/health')
async def model_health():
    ups = load_upstreams()
    up = ups[0] if ups else None
    if not up:
        return {'ok': False, 'error': 'no upstream configured'}
    # best-effort probe for the primary upstream
    url = (
        (up.base_url + '/api/tags')
        if up.kind == 'ollama'
        else (up.base_url + ('/v1/models' if not up.base_url.endswith('/v1') else '/models'))
    )
    try:
        async with httpx.AsyncClient(timeout=2.5, trust_env=False) as client:
            r = await client.get(url, headers={'Authorization': f'Bearer {up.api_key}'} if up.api_key else None)
            return {'ok': r.status_code == 200, 'status': r.status_code, 'url': url, 'model': up.default_model or ''}
    except Exception as e:
        return {'ok': False, 'error': str(e), 'url': url, 'model': up.default_model or ''}


@app.get('/models')
async def models():
    try:
        ups = load_upstreams()
        ms, default = await list_models(ups)
        return {'ok': True, 'models': ms, 'default': default or (ms[0] if ms else '')}
    except Exception as e:
        ups = load_upstreams()
        fallback_default = (ups[0].default_model if ups else '') or ''
        return {'ok': False, 'error': str(e), 'models': [], 'default': fallback_default}


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


#
# NOTE: LLM streaming is implemented in llm_gateway.py (supports Ollama + OpenAI-compatible providers)
#


@app.post('/chat')
async def chat(payload: dict, request: Request):
    if (os.environ.get("LEGACY_CHAT_UNMETERED_ENABLED") or "").strip().lower() not in {"1", "true", "yes", "y", "on"}:
        return await api_chat(payload, request)
    session_id = str(payload.get('session_id') or '')
    message = str(payload.get('message') or '')
    model = str(payload.get('model') or '').strip()
    images = payload.get("images") or []
    image_data_urls: list[str] = []
    try:
        if isinstance(images, list):
            for u in images[:3]:
                if isinstance(u, str) and u.startswith("data:image/"):
                    # soft size guard (avoid huge prompts)
                    if len(u) <= 2_200_000:
                        image_data_urls.append(u)
    except Exception:
        image_data_urls = []
    # Optional context items (from workspace/terminal/file). Keep it simple for MVP:
    # - frontend controls what is included
    # - backend limits size and formats as markdown
    ctx_items = payload.get("context_items") or payload.get("contextItems") or []
    ctx_text = ""
    try:
        if isinstance(ctx_items, list) and ctx_items:
            parts: list[str] = []
            max_total = 120_000  # chars
            used = 0
            for it in ctx_items[:12]:
                if not isinstance(it, dict):
                    continue
                kind = str(it.get("kind") or it.get("type") or "context")
                title = str(it.get("title") or it.get("path") or it.get("name") or kind)
                content = str(it.get("content") or it.get("text") or "")
                if not content:
                    continue
                # truncate each item
                if len(content) > 20_000:
                    content = content[:20_000] + "\n…(truncated)…\n"
                block = f"### {title}\n\n```text\n{content}\n```\n"
                if used + len(block) > max_total:
                    break
                parts.append(block)
                used += len(block)
            if parts:
                ctx_text = "\n\n".join(parts)
    except Exception:
        ctx_text = ""

    async def gen() -> AsyncIterator[bytes]:
        started_at = int(time.time())
        # Auth/Billing gates (best-effort, controlled by env in accounting.py)
        # NOTE: current production endpoints under /api/* are mounted via server.py router.
        # Here we reuse the same cookie auth for /api/chat as well.
        user_id: int | None = None
        upstream_name = ""
        request_id = f"llm_{started_at}_{os.getpid()}_{abs(hash(session_id)) % 100000}"
        prompt_chars = 0
        completion_chars = 0
        usage_prompt_tokens: int | None = None
        usage_completion_tokens: int | None = None

        try:
            final_msg = message
            if ctx_text:
                final_msg = f"{ctx_text}\n\n---\n\n用户问题：\n{message}"
            prompt_chars = len(final_msg)

            # Require login if the cookie is present or if ops chooses to enforce.
            sess = ""
            try:
                # FastAPI passes Request only if declared; read from payload for now is not possible.
                # For /api/chat, cookie is available via Request in api_chat below.
                sess = ""
            except Exception:
                sess = ""

            ups = load_upstreams()

            # Billing/auth are enforced in /api/chat where we can read cookies.
            def _on_usage(d: dict):
                nonlocal usage_prompt_tokens, usage_completion_tokens
                if not isinstance(d, dict):
                    return
                pt = d.get("prompt_tokens")
                ct = d.get("completion_tokens")
                if isinstance(pt, int):
                    usage_prompt_tokens = pt
                if isinstance(ct, int):
                    usage_completion_tokens = ct

            base_sys = _SYS_PROMPT_WITH_CONTEXT if ctx_text else _SYS_PROMPT_BASE
            sys_prompt = (
                base_sys
                + (_TOOL_PROMPT if bool(payload.get("tool_mode") or payload.get("toolMode") or False) else "")
                + _tool_env_block(payload)
                + _terminal_state_block(payload)
            )
            async for chunk in stream_chat(
                ups,
                final_msg,
                model or None,
                image_data_urls=image_data_urls,
                system_prompt=sys_prompt,
                on_usage=_on_usage,
            ):
                try:
                    completion_chars += len(chunk.decode("utf-8", errors="ignore"))
                except Exception:
                    completion_chars += 0
                yield chunk
        except Exception:
            for ch in _CN_MODEL_NOT_READY:
                yield ch.encode('utf-8')
                await asyncio.sleep(0.0005)
            async for chunk in _stream_placeholder(session_id, message):
                yield chunk
        finally:
            # No charging in /chat (non-/api alias). Charging happens in /api/chat where user is known.
            _ = user_id
            _ = upstream_name
            _ = request_id
            _ = prompt_chars
            _ = completion_chars
            _ = usage_prompt_tokens
            _ = usage_completion_tokens
            _ = started_at

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
async def api_chat(payload: dict, request: Request):
    """
    Auth + billing wrapper around /chat.
    - Uses cookie-based session (same as saas.py).
    - Records llm_usage + optionally charges ledger (env-controlled).
    """
    started_at = int(time.time())
    session_id = str(payload.get('session_id') or '')
    message = str(payload.get('message') or '')
    model = str(payload.get('model') or '').strip()

    # Auth
    sess = request.cookies.get(SESSION_COOKIE, "")
    u = None
    try:
        u = current_user(session=sess)
    except Exception:
        u = None
    if u is None:
        raise HTTPException(status_code=401, detail="Not logged in")
    uid = int(u["id"])

    # Billing gate (min balance etc)
    decision = can_start_llm_call(_DB, user_id=uid)
    if not decision.ok:
        code = "InsufficientBalance" if decision.reason == "Insufficient balance" else "BetaQuotaExceeded"
        message = "Beta credit is exhausted" if code == "InsufficientBalance" else decision.reason
        raise HTTPException(status_code=402, detail={"code": code, "message": message, "balanceCents": decision.balance_cents})
    if not _try_enter_llm_call(uid):
        raise HTTPException(status_code=429, detail={"code": "BetaConcurrencyLimit", "message": "Only one active beta request is allowed per user"})

    # Prepare context assembling same as /chat
    images = payload.get("images") or []
    image_data_urls: list[str] = []
    try:
        if isinstance(images, list):
            for u0 in images[:3]:
                if isinstance(u0, str) and u0.startswith("data:image/"):
                    if len(u0) <= 2_200_000:
                        image_data_urls.append(u0)
    except Exception:
        image_data_urls = []

    ctx_items = payload.get("context_items") or payload.get("contextItems") or []
    ctx_text = ""
    try:
        if isinstance(ctx_items, list) and ctx_items:
            parts: list[str] = []
            max_total = 120_000
            used = 0
            for it in ctx_items[:12]:
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
            if parts:
                ctx_text = "\n\n".join(parts)
    except Exception:
        ctx_text = ""

    final_msg = message
    if ctx_text:
        final_msg = f"{ctx_text}\n\n---\n\n用户问题：\n{message}"
    prompt_chars = len(final_msg)

    request_id = f"llm_{uid}_{started_at}_{os.getpid()}_{abs(hash(session_id)) % 100000}"
    completion_chars = 0
    usage_prompt_tokens: int | None = None
    usage_completion_tokens: int | None = None
    status = "ok"
    err = ""

    def _on_usage(d: dict):
        nonlocal usage_prompt_tokens, usage_completion_tokens
        if not isinstance(d, dict):
            return
        pt = d.get("prompt_tokens")
        ct = d.get("completion_tokens")
        if isinstance(pt, int):
            usage_prompt_tokens = pt
        if isinstance(ct, int):
            usage_completion_tokens = ct

    async def gen() -> AsyncIterator[bytes]:
        nonlocal completion_chars, status, err
        try:
            ups = load_upstreams()
            base_sys = _SYS_PROMPT_WITH_CONTEXT if ctx_text else _SYS_PROMPT_BASE
            sys_prompt = base_sys + (_TOOL_PROMPT if bool(payload.get("tool_mode") or payload.get("toolMode") or False) else "") + _tool_env_block(payload)
            max_output = beta_max_output_chars() if beta_mode_enabled() else 0
            async for chunk in stream_chat(
                ups,
                final_msg,
                model or None,
                image_data_urls=image_data_urls,
                system_prompt=sys_prompt,
                on_usage=_on_usage,
            ):
                try:
                    text = chunk.decode("utf-8", errors="ignore")
                except Exception:
                    text = ""
                if max_output > 0 and text and completion_chars + len(text) > max_output:
                    remaining = max(0, max_output - completion_chars)
                    if remaining > 0:
                        out = text[:remaining]
                        completion_chars += len(out)
                        yield out.encode("utf-8")
                    status = "truncated"
                    err = "beta_output_limit"
                    yield _BETA_OUTPUT_LIMIT_TEXT.encode("utf-8")
                    break
                completion_chars += len(text)
                yield chunk
        except Exception as e:
            status = "error"
            err = f"{e.__class__.__name__}"
            for ch in _CN_MODEL_NOT_READY:
                yield ch.encode('utf-8')
                await asyncio.sleep(0.0005)
            async for chunk in _stream_placeholder(session_id, message):
                yield chunk
        finally:
            finished_at = int(time.time())
            # Charge and record (best-effort)
            cost = charge_llm_usage(
                _DB,
                user_id=uid,
                request_id=request_id,
                model=model or "",
                prompt_chars=prompt_chars,
                completion_chars=completion_chars,
                created_at=finished_at,
            )
            record_llm_usage(
                _DB,
                request_id=request_id,
                user_id=uid,
                model=model or "",
                upstream="",
                status=status,
                prompt_chars=prompt_chars,
                completion_chars=completion_chars,
                prompt_tokens=usage_prompt_tokens,
                completion_tokens=usage_completion_tokens,
                cost_cents=cost,
                started_at=started_at,
                finished_at=finished_at,
                error=err,
            )
            _leave_llm_call(uid)

    return StreamingResponse(gen(), media_type='text/plain; charset=utf-8')


@app.get('/public/releases')
def public_releases():
    return load_releases_payload()


@app.get('/api/public/releases')
def api_public_releases():
    return load_releases_payload()


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
