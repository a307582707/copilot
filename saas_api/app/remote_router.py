from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shlex
import socket
import threading
import time
from collections import defaultdict, deque

import paramiko
from fastapi import APIRouter, Depends, HTTPException, WebSocket
from starlette.websockets import WebSocketDisconnect

from .ai_mode import get_ai_mode, set_ai_mode
from .db import connect, init_db
from .pty_lease import consume_lease, create_lease, end_lease, is_manual_active, renew_manual_active
from .remote_access import (
    is_dangerous_shell_command,
    sftp_listdir_on_client,
    sftp_read_text_on_client,
    sftp_write_text_on_client,
    ssh_connect,
    ssh_exec_on_client,
)
from .inventory import get_decrypted_credential
from .saas import SESSION_COOKIE, current_user
from .ssh_sessions import STORE
from .ssh_trial import require_ssh_access

router = APIRouter()

_AUDIT_DB = connect()
init_db(_AUDIT_DB)
_AUDIT_LOCK = threading.Lock()


def _bad(detail: str):
    raise HTTPException(status_code=400, detail=detail)


def _forbidden(detail: str):
    raise HTTPException(status_code=403, detail=detail)


def _audit(event_type: str, payload: dict) -> None:
    # Best-effort audit: sqlite + json log. Must never block user operations.
    try:
        p = payload if isinstance(payload, dict) else {}
        row = {
            "id": str(p.get("id") or "").strip()[:80] or None,
            "user_id": int(p.get("user_id") or 0),
            "session_id": (str(p.get("session_id") or "").strip()[:80] or None),
            "event_type": (str(event_type or p.get("event_type") or "unknown").strip()[:40] or "unknown"),
            "asset_name": (str(p.get("asset_name") or "").strip()[:160] or None),
            "ssh_target": (str(p.get("ssh_target") or "").strip()[:240] or None),
            "cwd": (str(p.get("cwd") or "").strip()[:800] or None),
            "path": (str(p.get("path") or "").strip()[:1600] or None),
            "cmd": (str(p.get("cmd") or "").strip()[:4000] or None),
            "ok": (1 if p.get("ok") is True else 0 if p.get("ok") is False else p.get("ok")),
            "exit_code": p.get("exit_code"),
            "timed_out": (1 if p.get("timed_out") is True else 0 if p.get("timed_out") is False else p.get("timed_out")),
            "stdout_len": p.get("stdout_len"),
            "stderr_len": p.get("stderr_len"),
            "started_at": int(p.get("started_at") or int(time.time() * 1000)),
            "finished_at": int(p["finished_at"]) if isinstance(p.get("finished_at"), int) else None,
            "duration_ms": int(p["duration_ms"]) if isinstance(p.get("duration_ms"), int) else None,
            "error": (str(p.get("error") or "").strip()[:800] or None),
            "meta_json": None,
        }
        if not row["id"] or row["user_id"] <= 0:
            return
        m = p.get("meta")
        if isinstance(m, dict) and m:
            try:
                row["meta_json"] = json.dumps(m, ensure_ascii=False, sort_keys=True)[:4000]
            except Exception:
                row["meta_json"] = None
        with _AUDIT_LOCK:
            _AUDIT_DB.execute(
                """
INSERT OR REPLACE INTO ssh_audit(
  id,user_id,session_id,event_type,asset_name,ssh_target,cwd,path,cmd,ok,exit_code,timed_out,stdout_len,stderr_len,started_at,finished_at,duration_ms,error,meta_json
) VALUES (
  :id,:user_id,:session_id,:event_type,:asset_name,:ssh_target,:cwd,:path,:cmd,:ok,:exit_code,:timed_out,:stdout_len,:stderr_len,:started_at,:finished_at,:duration_ms,:error,:meta_json
)
""",
                row,
            )
            _AUDIT_DB.commit()
        try:
            print(json.dumps({"t": "ssh_audit", **row}, ensure_ascii=False))
        except Exception:
            pass
    except Exception:
        return


def _require_exec_allowed(*, user: dict, session_id: str) -> None:
    sid = (session_id or "").strip()
    if not sid:
        _bad("Missing sessionId")
    if is_manual_active(user_id=int(user["id"]), session_id=sid):
        _forbidden("Manual/Shell active: exec is disabled")
    st = get_ai_mode(user_id=int(user["id"]), session_id=sid)
    if st.mode not in {"execute", "debug"}:
        _forbidden(f"AI mode '{st.mode}' forbids exec/files")


def _guess_ssh_os_from_banner(banner: str) -> str:
    """
    Best-effort OS guess from SSH banner.
    This is only a hint for the UI; do not treat it as a source of truth.
    """
    b = str(banner or "").strip()
    if not b:
        return "Unknown"
    lb = b.lower()
    # Common Windows OpenSSH banner: "SSH-2.0-OpenSSH_for_Windows_8.1"
    if "openssh_for_windows" in lb or re.search(r"\bwindows\b", lb):
        return "Windows"
    # Most OpenSSH banners do not identify distro; treat as Linux for UX parity.
    if "openssh" in lb or "ubuntu" in lb or "debian" in lb or "centos" in lb or "alpine" in lb or "fedora" in lb:
        return "Linux"
    return "Unknown"


def _env_bool(name: str, default: bool) -> bool:
    v = (os.environ.get(name) or "").strip().lower()
    if not v:
        return default
    if v in {"1", "true", "yes", "y", "on"}:
        return True
    if v in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _is_valid_ipv4(s: str) -> bool:
    p = (s or "").strip()
    if not p:
        return False
    parts = p.split(".")
    if len(parts) != 4:
        return False
    for x in parts:
        if not x.isdigit():
            return False
        n = int(x)
        if n < 0 or n > 255:
            return False
    return True


_HOST_RE = re.compile(r"^(?=.{1,253}$)([a-zA-Z0-9-]{1,63}\.)*[a-zA-Z0-9-]{1,63}$")


def _is_valid_hostname(s: str) -> bool:
    p = (s or "").strip()
    if not p:
        return False
    if not re.search(r"[a-zA-Z-]", p):
        return False
    return bool(_HOST_RE.match(p))


# --- /api/ssh/test rate limit (in-memory, best-effort) ---
_SSH_TEST_RL_LOCK = threading.Lock()
_SSH_TEST_RL = defaultdict(lambda: deque())  # key -> deque[timestamps_sec]


def _ssh_test_rate_limit_or_raise(*, user_id: int, address: str) -> None:
    """
    Prevent abuse as a port-scanner: limit by user, user+target, and global.
    Best-effort in-memory only (per-process).
    """
    now = time.time()
    window = 60.0
    k_user = f"u:{int(user_id)}"
    k_user_target = f"ut:{int(user_id)}:{address}"
    k_global = "g"
    limits = {
        k_user_target: 10,  # per-user per-target per minute
        k_user: 30,  # per-user per minute
        k_global: 300,  # global per minute
    }

    def prune(q: deque) -> None:
        while q and (now - q[0]) > window:
            q.popleft()

    with _SSH_TEST_RL_LOCK:
        for k in (k_user_target, k_user, k_global):
            prune(_SSH_TEST_RL[k])
        for k, limit in limits.items():
            if len(_SSH_TEST_RL[k]) >= limit:
                raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")
        for k in (k_user_target, k_user, k_global):
            _SSH_TEST_RL[k].append(now)


@router.post("/api/ssh/test")
async def api_ssh_test(payload: dict, u: dict = Depends(current_user)):
    """
    Frontend pre-flight check used by HostEditor "⚡ 测试连接".
    NOTE: This does NOT perform SSH authentication; it only checks TCP reachability + (optional) SSH banner.
    Response shape:
      { ok: true, success: bool, latency_ms: number|null, os: string, error: string }
    """
    address = str(payload.get("address") or "").strip()
    port_raw = payload.get("port", 22)
    try:
        port = int(port_raw)
    except Exception:
        port = 0

    if not address:
        _bad("缺少 address")
    if not (_is_valid_ipv4(address) or _is_valid_hostname(address)):
        _bad("主机地址不合法")

    # Only allow 22 by default (avoid turning this into a general port scanner)
    if port != 22:
        _bad("仅支持端口 22（OpenSSH）")

    # Feature flag: allow gating when needed for risk control
    # - default ungated (do NOT consume trial/paid quota)
    # - set SSH_TEST_UNGATED=0 to enforce require_ssh_access(kind="op")
    if not _env_bool("SSH_TEST_UNGATED", True):
        require_ssh_access(u, kind="op")

    _ssh_test_rate_limit_or_raise(user_id=int(u["id"]), address=address)

    started = time.time()
    err = ""
    banner = ""
    ok = False
    try:
        s = socket.create_connection((address, int(port)), timeout=3.5)
        try:
            s.settimeout(2.0)
            try:
                data = s.recv(256) or b""
                banner = data.decode("utf-8", "ignore").strip()
            except Exception:
                banner = ""
        finally:
            try:
                s.close()
            except Exception:
                pass
        ok = True
    except socket.timeout:
        err = "timeout"
    except OSError as e:
        msg = str(getattr(e, "strerror", "") or e)
        err = msg[:120] if msg else e.__class__.__name__
    except Exception as e:  # noqa: BLE001
        err = f"{e.__class__.__name__}"

    latency_ms = int((time.time() - started) * 1000) if ok else None
    os_guess = _guess_ssh_os_from_banner(banner) if banner.startswith("SSH-") else "Unknown"

    # audit (no banner content)
    try:
        finished_at_ms = int(time.time() * 1000)
        started_at_ms = int(finished_at_ms - (latency_ms or 0))
        ssh_target = f"{address}:{int(port)}"
        _audit(
            "ssh_test",
            {
                "id": "test_" + secrets.token_urlsafe(10),
                "user_id": int(u["id"]),
                "session_id": None,
                "ssh_target": ssh_target,
                "ok": bool(ok),
                "started_at": int(started_at_ms),
                "finished_at": int(finished_at_ms),
                "duration_ms": int((latency_ms or 0)),
                "error": err or None,
                "meta": {"os_guess": os_guess},
            },
        )
    except Exception:
        pass

    return {"ok": True, "success": bool(ok), "latency_ms": latency_ms, "os": os_guess, "error": err}


@router.post("/api/ai/mode/set")
async def api_ai_mode_set(payload: dict, u: dict = Depends(current_user)):
    sid = str(payload.get("sessionId") or "").strip()
    mode = str(payload.get("mode") or payload.get("aiMode") or "").strip().lower()
    if not sid:
        _bad("Missing sessionId")
    s = STORE.get(user_id=int(u["id"]), session_id=sid)
    if not s:
        raise HTTPException(status_code=410, detail="SSH session expired")
    try:
        st = set_ai_mode(user_id=int(u["id"]), session_id=sid, mode=mode)
        return {"ok": True, "sessionId": sid, "mode": st.mode, "updatedAt": st.updated_at_ms}
    except ValueError as e:
        _bad(str(e))


@router.get("/api/ai/mode/get")
async def api_ai_mode_get(sessionId: str, u: dict = Depends(current_user)):
    sid = str(sessionId or "").strip()
    if not sid:
        _bad("Missing sessionId")
    st = get_ai_mode(user_id=int(u["id"]), session_id=sid)
    return {"ok": True, "sessionId": sid, "mode": st.mode, "updatedAt": st.updated_at_ms}


@router.post("/api/ssh/connect")
async def api_ssh_connect(payload: dict, u: dict = Depends(current_user)):
    require_ssh_access(u, kind="session")
    try:
        host = payload.get("host") or {}
        auth = payload.get("auth") or {}
        # Optional: use encrypted credential vault (per-user) by credentialId.
        # This keeps secrets out of localStorage and avoids repeating input.
        if isinstance(auth, dict):
            cid = str(auth.get("credentialId") or "").strip()
            if cid:
                dec = get_decrypted_credential(user_id=int(u["id"]), credential_id=cid)
                kind = str(dec.get("kind") or "").strip().lower()
                if kind == "password":
                    auth = {"type": "password", "password": dec.get("password")}
                elif kind == "ssh_key":
                    auth = {"type": "ssh_key", "privateKey": dec.get("privateKey"), "passphrase": dec.get("passphrase")}
                else:
                    raise HTTPException(status_code=400, detail="Invalid credential kind")
        timeout_sec = float(payload.get("timeoutSec", 12))
        timeout_sec = max(1.0, min(timeout_sec, 30.0))
        cli, info = ssh_connect(host=host, auth=auth, timeout_sec=timeout_sec)
        sid = STORE.create(user_id=int(u["id"]), host=info, client=cli)
        return {"ok": True, "sessionId": sid, "host": info, "ttlSec": STORE.ttl_sec}
    except HTTPException:
        raise
    except paramiko.ssh_exception.AuthenticationException:
        t = str((payload.get("auth") or {}).get("type") or "").strip()
        if t == "password":
            raise HTTPException(status_code=401, detail="认证失败：密码不正确或无权限")
        if t == "ssh_key":
            raise HTTPException(status_code=401, detail="认证失败：私钥/口令不正确或无权限")
        raise HTTPException(status_code=401, detail="认证失败：请检查认证信息")
    except ValueError as e:
        _bad(str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"SSH connect failed: {e.__class__.__name__}")


@router.post("/api/ssh/disconnect")
async def api_ssh_disconnect(payload: dict, u: dict = Depends(current_user)):
    sid = str(payload.get("sessionId") or "").strip()
    if not sid:
        _bad("Missing sessionId")
    ok = STORE.delete(user_id=int(u["id"]), session_id=sid)
    return {"ok": True, "deleted": bool(ok)}


@router.post("/api/ssh/ping")
async def api_ssh_ping(payload: dict, u: dict = Depends(current_user)):
    """
    Lightweight keepalive endpoint.
    Touches the in-memory SSH session to extend its TTL.
    """
    require_ssh_access(u, kind="op")
    sid = str(payload.get("sessionId") or "").strip()
    if not sid:
        _bad("Missing sessionId")
    s = STORE.get(user_id=int(u["id"]), session_id=sid)
    if not s:
        raise HTTPException(status_code=410, detail="SSH session expired")
    return {"ok": True, "sessionId": sid, "ttlSec": STORE.ttl_sec}


@router.post("/api/ssh/exec")
async def api_ssh_exec(payload: dict, u: dict = Depends(current_user)):
    require_ssh_access(u, kind="op")
    started_at_ms = int(time.time() * 1000)
    run_id = str(payload.get("runId") or "").strip() or ("run_" + secrets.token_urlsafe(12))
    sid = str(payload.get("sessionId") or "").strip()
    try:
        _require_exec_allowed(user=u, session_id=sid)
        command = payload.get("command") or ""
        original_command = payload.get("originalCommand")
        was_rewritten = bool(payload.get("wasRewritten", False))
        cwd = payload.get("cwd")
        timeout_sec = float(payload.get("timeoutSec", 12))
        timeout_sec = max(1.0, min(timeout_sec, 30.0))

        why = is_dangerous_shell_command(str(command))
        if why:
            _forbidden(f"危险命令已拦截：{why}。如需执行，请使用工作区终端的 PTY（人工）模式。")

        s = STORE.get(user_id=int(u["id"]), session_id=sid)
        if not s:
            raise HTTPException(status_code=410, detail="SSH session expired")
        r = ssh_exec_on_client(client=s.client, command=str(command), cwd=str(cwd) if cwd else None, timeout_sec=timeout_sec)
        finished_at_ms = int(time.time() * 1000)

        # audit (no stdout/stderr content)
        try:
            host_info = s.host or {}
            ssh_target = f"{host_info.get('username') or 'root'}@{host_info.get('address') or ''}:{int(host_info.get('port') or 22)}"
            out0 = str((r or {}).get("stdout") or "")
            err0 = str((r or {}).get("stderr") or "")
            exit0 = (r or {}).get("exitCode")
            tmo0 = bool((r or {}).get("timedOut"))
            _audit(
                "ssh_exec",
                {
                    "id": run_id,
                    "user_id": int(u["id"]),
                    "session_id": sid,
                    "ssh_target": ssh_target or None,
                    "cwd": str(cwd) if cwd else None,
                    "cmd": str(command),
                    "ok": True if (exit0 == 0 and not tmo0 and not err0.strip()) else False,
                    "exit_code": int(exit0) if isinstance(exit0, int) else None,
                    "timed_out": bool(tmo0),
                    "stdout_len": len(out0),
                    "stderr_len": len(err0),
                    "started_at": int(started_at_ms),
                    "finished_at": int(finished_at_ms),
                    "duration_ms": int((r or {}).get("durationMs") or max(0, finished_at_ms - started_at_ms)),
                    "meta": {
                        "ai_mode": get_ai_mode(user_id=int(u["id"]), session_id=sid).mode,
                        "manual_active": bool(is_manual_active(user_id=int(u["id"]), session_id=sid)),
                        "stdoutTruncated": bool((r or {}).get("stdoutTruncated")),
                        "stderrTruncated": bool((r or {}).get("stderrTruncated")),
                    },
                },
            )
        except Exception:
            pass

        out = dict(r or {})
        out.update(
            {
                "ok": True,
                "runId": run_id,
                "cmd": str(command),
                "originalCommand": str(original_command) if isinstance(original_command, str) else None,
                "wasRewritten": bool(was_rewritten),
                "signal": None,
                "startedAt": started_at_ms,
                "finishedAt": finished_at_ms,
            }
        )
        return out
    except HTTPException as e:
        try:
            _audit(
                "ssh_exec",
                {
                    "id": run_id,
                    "user_id": int(u["id"]),
                    "session_id": sid,
                    "ok": False,
                    "started_at": int(started_at_ms),
                    "finished_at": int(time.time() * 1000),
                    "error": f"HTTPException:{str(e.detail)[:600]}",
                    "meta": {"ai_mode": get_ai_mode(user_id=int(u["id"]), session_id=sid).mode},
                },
            )
        except Exception:
            pass
        raise
    except ValueError as e:
        try:
            _audit(
                "ssh_exec",
                {
                    "id": run_id,
                    "user_id": int(u["id"]),
                    "session_id": sid,
                    "ok": False,
                    "started_at": int(started_at_ms),
                    "finished_at": int(time.time() * 1000),
                    "error": f"ValueError:{str(e)[:600]}",
                    "meta": {"ai_mode": get_ai_mode(user_id=int(u["id"]), session_id=sid).mode},
                },
            )
        except Exception:
            pass
        _bad(str(e))
    except Exception as e:  # noqa: BLE001
        try:
            _audit(
                "ssh_exec",
                {
                    "id": run_id,
                    "user_id": int(u["id"]),
                    "session_id": sid,
                    "ok": False,
                    "started_at": int(started_at_ms),
                    "finished_at": int(time.time() * 1000),
                    "error": f"{e.__class__.__name__}",
                    "meta": {"ai_mode": get_ai_mode(user_id=int(u["id"]), session_id=sid).mode},
                },
            )
        except Exception:
            pass
        raise HTTPException(status_code=502, detail=f"SSH exec failed: {e.__class__.__name__}")


@router.post("/api/files/list")
async def api_files_list(payload: dict, u: dict = Depends(current_user)):
    require_ssh_access(u, kind="op")
    started_at_ms = int(time.time() * 1000)
    eid = "audit_" + secrets.token_urlsafe(12)
    sid = str(payload.get("sessionId") or "").strip()
    try:
        if not sid:
            _bad("Missing sessionId")
        _require_exec_allowed(user=u, session_id=sid)
        root_path = str(payload.get("rootPath") or "").strip()
        path = str(payload.get("path") or "").strip() or "."
        limit = int(payload.get("limit", 200))
        timeout_sec = float(payload.get("timeoutSec", 12))
        timeout_sec = max(1.0, min(timeout_sec, 30.0))
        if not root_path:
            _bad("Missing rootPath")
        s = STORE.get(user_id=int(u["id"]), session_id=sid)
        if not s:
            raise HTTPException(status_code=410, detail="SSH session expired")
        r = sftp_listdir_on_client(client=s.client, root_path=root_path, path=path, limit=limit, timeout_sec=timeout_sec)
        try:
            host_info = s.host or {}
            ssh_target = f"{host_info.get('username') or 'root'}@{host_info.get('address') or ''}:{int(host_info.get('port') or 22)}"
            now = int(time.time() * 1000)
            _audit(
                "files_list",
                {
                    "id": eid,
                    "user_id": int(u["id"]),
                    "session_id": sid,
                    "ssh_target": ssh_target or None,
                    "path": path,
                    "ok": True,
                    "started_at": int(started_at_ms),
                    "finished_at": int(now),
                    "duration_ms": int(max(0, now - started_at_ms)),
                    "meta": {
                        "ai_mode": get_ai_mode(user_id=int(u["id"]), session_id=sid).mode,
                        "manual_active": bool(is_manual_active(user_id=int(u["id"]), session_id=sid)),
                        "rootPath": root_path,
                        "items": len((r or {}).get("items") or []),
                    },
                },
            )
        except Exception:
            pass
        return r
    except HTTPException:
        raise
    except ValueError as e:
        _bad(str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"File list failed: {e.__class__.__name__}")


@router.post("/api/files/read")
async def api_files_read(payload: dict, u: dict = Depends(current_user)):
    require_ssh_access(u, kind="op")
    started_at_ms = int(time.time() * 1000)
    eid = "audit_" + secrets.token_urlsafe(12)
    sid = str(payload.get("sessionId") or "").strip()
    try:
        if not sid:
            _bad("Missing sessionId")
        _require_exec_allowed(user=u, session_id=sid)
        root_path = str(payload.get("rootPath") or "").strip()
        path = str(payload.get("path") or "").strip()
        offset = int(payload.get("offset", 0))
        limit = int(payload.get("limit", 262_144))
        timeout_sec = float(payload.get("timeoutSec", 12))
        timeout_sec = max(1.0, min(timeout_sec, 30.0))
        if not root_path:
            _bad("Missing rootPath")
        if not path:
            _bad("Missing path")
        s = STORE.get(user_id=int(u["id"]), session_id=sid)
        if not s:
            raise HTTPException(status_code=410, detail="SSH session expired")
        r = sftp_read_text_on_client(client=s.client, root_path=root_path, path=path, offset=offset, limit=limit, timeout_sec=timeout_sec)
        try:
            host_info = s.host or {}
            ssh_target = f"{host_info.get('username') or 'root'}@{host_info.get('address') or ''}:{int(host_info.get('port') or 22)}"
            body = (r or {}).get("content") or ""
            now = int(time.time() * 1000)
            _audit(
                "files_read",
                {
                    "id": eid,
                    "user_id": int(u["id"]),
                    "session_id": sid,
                    "ssh_target": ssh_target or None,
                    "path": path,
                    "ok": True,
                    "stdout_len": len(str(body)) if not bool((r or {}).get("isBinary")) else None,
                    "started_at": int(started_at_ms),
                    "finished_at": int(now),
                    "duration_ms": int(max(0, now - started_at_ms)),
                    "meta": {
                        "ai_mode": get_ai_mode(user_id=int(u["id"]), session_id=sid).mode,
                        "manual_active": bool(is_manual_active(user_id=int(u["id"]), session_id=sid)),
                        "rootPath": root_path,
                        "offset": offset,
                        "limit": limit,
                        "isBinary": bool((r or {}).get("isBinary")),
                        "truncated": bool((r or {}).get("truncated")),
                    },
                },
            )
        except Exception:
            pass
        return r
    except HTTPException:
        raise
    except ValueError as e:
        _bad(str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"File read failed: {e.__class__.__name__}")


@router.post("/api/files/write")
async def api_files_write(payload: dict, u: dict = Depends(current_user)):
    require_ssh_access(u, kind="op")
    started_at_ms = int(time.time() * 1000)
    eid = "audit_" + secrets.token_urlsafe(12)
    sid = str(payload.get("sessionId") or "").strip()
    try:
        if not sid:
            _bad("Missing sessionId")
        _require_exec_allowed(user=u, session_id=sid)
        root_path = str(payload.get("rootPath") or "").strip()
        path = str(payload.get("path") or "").strip()
        content = str(payload.get("content") or "")
        confirm = bool(payload.get("confirm", False))
        create_backup = bool(payload.get("createBackup", True))
        timeout_sec = float(payload.get("timeoutSec", 18))
        timeout_sec = max(1.0, min(timeout_sec, 45.0))
        if not root_path:
            _bad("Missing rootPath")
        if not path:
            _bad("Missing path")
        s = STORE.get(user_id=int(u["id"]), session_id=sid)
        if not s:
            raise HTTPException(status_code=410, detail="SSH session expired")
        r = sftp_write_text_on_client(
            client=s.client,
            root_path=root_path,
            path=path,
            content=content,
            confirm=confirm,
            create_backup=create_backup,
            timeout_sec=timeout_sec,
        )
        try:
            host_info = s.host or {}
            ssh_target = f"{host_info.get('username') or 'root'}@{host_info.get('address') or ''}:{int(host_info.get('port') or 22)}"
            now = int(time.time() * 1000)
            _audit(
                "files_write",
                {
                    "id": eid,
                    "user_id": int(u["id"]),
                    "session_id": sid,
                    "ssh_target": ssh_target or None,
                    "path": path,
                    "ok": True,
                    "started_at": int(started_at_ms),
                    "finished_at": int(now),
                    "duration_ms": int(max(0, now - started_at_ms)),
                    "meta": {
                        "ai_mode": get_ai_mode(user_id=int(u["id"]), session_id=sid).mode,
                        "manual_active": bool(is_manual_active(user_id=int(u["id"]), session_id=sid)),
                        "rootPath": root_path,
                        "bytes": len(content or ""),
                        "confirm": bool(confirm),
                        "createBackup": bool(create_backup),
                        "backupPath": (r or {}).get("backupPath"),
                    },
                },
            )
        except Exception:
            pass
        return r
    except HTTPException:
        raise
    except ValueError as e:
        _bad(str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"File write failed: {e.__class__.__name__}")


def _ws_close(websocket: WebSocket, *, code: int, reason: str = ""):
    return websocket.close(code=code, reason=reason or None)


def _shell_cmd(cwd: str | None) -> str:
    # Force interactive login shell (-li) so TAB completion / history work in PTY.
    #
    # IMPORTANT: Avoid nested single-quotes.
    # - We use a double-quoted `bash -lc "..."` script
    # - and keep the PROMPT_COMMAND payload single-quoted (via `shlex.quote`) so `$PWD` isn't expanded
    #   at assignment time, but will expand when PROMPT_COMMAND executes before each prompt.
    marker = r'printf "__CS_CWD__%s__CS_END__\n" "$PWD"'
    if cwd:
        q = shlex.quote(cwd)
        return f'bash -lc "cd {q}; export PROMPT_COMMAND={shlex.quote(marker)}; exec bash -li"'
    return f'bash -lc "export PROMPT_COMMAND={shlex.quote(marker)}; exec bash -li"'


@router.post("/api/ssh/pty/lease/create")
async def api_pty_lease_create(payload: dict, u: dict = Depends(current_user)):
    require_ssh_access(u, kind="op")
    sid = str(payload.get("sessionId") or "").strip()
    if not sid:
        _bad("Missing sessionId")
    s = STORE.get(user_id=int(u["id"]), session_id=sid)
    if not s:
        raise HTTPException(status_code=410, detail="SSH session expired")
    # Backward compat: default to Manual/Shell semantics unless caller explicitly opts out.
    raw_ma = payload.get("manualActive")
    if raw_ma is None:
        raw_ma = payload.get("manual_active")
    manual_active = True if raw_ma is None else bool(raw_ma)
    purpose = str(payload.get("purpose") or "").strip().lower()
    if purpose == "terminal":
        manual_active = False
    elif purpose == "manual":
        manual_active = True
    lease = create_lease(user_id=int(u["id"]), session_id=sid, ttl_sec=30 * 60, manual_active=manual_active)
    try:
        _audit(
            "pty_lease_create",
            {
                "id": lease.lease_id,
                "user_id": int(u["id"]),
                "session_id": sid,
                "ok": True,
                "started_at": int(time.time() * 1000),
                "finished_at": int(time.time() * 1000),
                "meta": {"expiresAt": int(lease.expires_at_ms)},
            },
        )
    except Exception:
        pass
    return {
        "ok": True,
        "sessionId": sid,
        "leaseId": lease.lease_id,
        "expiresAt": lease.expires_at_ms,
        "manualActive": bool(lease.manual_active),
    }


@router.post("/api/ssh/pty/lease/end")
async def api_pty_lease_end(payload: dict, u: dict = Depends(current_user)):
    require_ssh_access(u, kind="op")
    lease_id = str(payload.get("leaseId") or "").strip()
    if not lease_id:
        _bad("Missing leaseId")
    ok = end_lease(user_id=int(u["id"]), lease_id=lease_id)
    if not ok:
        raise HTTPException(status_code=404, detail="PTY lease not found")
    try:
        _audit(
            "pty_lease_end",
            {"id": lease_id, "user_id": int(u["id"]), "session_id": None, "ok": True, "started_at": int(time.time() * 1000), "finished_at": int(time.time() * 1000)},
        )
    except Exception:
        pass
    return {"ok": True, "leaseId": lease_id}


@router.websocket("/api/ssh/pty/ws")
async def ws_ssh_pty(websocket: WebSocket):
    try:
        sess = websocket.cookies.get(SESSION_COOKIE)
        u = current_user(session=sess)
    except Exception:
        await _ws_close(websocket, code=4401, reason="unauthorized")
        return

    await websocket.accept()

    try:
        require_ssh_access(u, kind="op")
    except HTTPException as e:
        try:
            await websocket.send_text(json.dumps({"t": "err", "m": "SSH trial limit", "detail": e.detail}, ensure_ascii=False))
        except Exception:
            pass
        await _ws_close(websocket, code=4402, reason="payment_required")
        return

    q = websocket.query_params
    sid = str(q.get("sessionId") or "").strip()
    lease_id = str(q.get("leaseId") or "").strip()
    cols = int(str(q.get("cols") or "120").strip() or "120")
    rows = int(str(q.get("rows") or "30").strip() or "30")
    cwd = str(q.get("cwd") or "").strip() or None
    cols = max(40, min(cols, 240))
    rows = max(10, min(rows, 80))

    if not sid:
        await websocket.send_text(json.dumps({"t": "err", "m": "Missing sessionId"}, ensure_ascii=False))
        await _ws_close(websocket, code=4400, reason="missing sessionId")
        return
    if not lease_id:
        await websocket.send_text(json.dumps({"t": "err", "m": "Missing leaseId"}, ensure_ascii=False))
        await _ws_close(websocket, code=4400, reason="missing leaseId")
        return

    try:
        lease = consume_lease(user_id=int(u["id"]), lease_id=lease_id, session_id=sid)
        if not lease:
            raise ValueError("invalid")
    except Exception:
        await websocket.send_text(json.dumps({"t": "err", "m": "PTY lease invalid/expired"}, ensure_ascii=False))
        await _ws_close(websocket, code=4403, reason="lease invalid")
        return

    # Manual/Shell mode: keep exec disabled while WS is alive.
    if bool(getattr(lease, "manual_active", False)):
        try:
            renew_manual_active(user_id=int(u["id"]), session_id=sid, ttl_sec=30 * 60)
        except Exception:
            pass

    s = STORE.get(user_id=int(u["id"]), session_id=sid)
    if not s:
        await websocket.send_text(json.dumps({"t": "err", "m": "SSH session expired"}, ensure_ascii=False))
        await _ws_close(websocket, code=4410, reason="session expired")
        return

    transport = None
    try:
        transport = s.client.get_transport()
    except Exception:
        transport = None
    if not transport or not transport.is_active():
        await websocket.send_text(json.dumps({"t": "err", "m": "SSH transport not active"}, ensure_ascii=False))
        await _ws_close(websocket, code=4410, reason="transport not active")
        return

    started_at_ms = int(time.time() * 1000)
    try:
        host_info = s.host or {}
        ssh_target = f"{host_info.get('username') or 'root'}@{host_info.get('address') or ''}:{int(host_info.get('port') or 22)}"
        _audit(
            "pty_open",
            {
                "id": lease_id,
                "user_id": int(u["id"]),
                "session_id": sid,
                "ssh_target": ssh_target or None,
                "cwd": cwd,
                "ok": True,
                "started_at": int(started_at_ms),
                "finished_at": int(started_at_ms),
                "meta": {"cols": cols, "rows": rows},
            },
        )
    except Exception:
        pass

    chan = None
    try:
        chan = transport.open_session()
        chan.get_pty(term="xterm-256color", width=cols, height=rows)
        chan.exec_command(_shell_cmd(cwd))
    except Exception:
        try:
            if chan:
                chan.close()
        except Exception:
            pass
        await websocket.send_text(json.dumps({"t": "err", "m": "Failed to open PTY"}, ensure_ascii=False))
        await _ws_close(websocket, code=1011, reason="pty open failed")
        return

    async def _reader():
        try:
            while True:
                data = await asyncio.to_thread(chan.recv, 32768)
                if not data:
                    break
                try:
                    txt = data.decode("utf-8", errors="ignore")
                except Exception:
                    txt = ""
                if txt:
                    await websocket.send_text(txt)
        except Exception:
            return

    reader_task = asyncio.create_task(_reader())

    try:
        while True:
            try:
                msg = await websocket.receive_text()
            except WebSocketDisconnect:
                break
            except Exception:
                break

            # Activity-based renewal (best-effort) for Manual/Shell mode.
            if bool(getattr(lease, "manual_active", False)):
                try:
                    renew_manual_active(user_id=int(u["id"]), session_id=sid, ttl_sec=30 * 60)
                except Exception:
                    pass

            if msg and msg[0] == "{" and len(msg) <= 2000:
                try:
                    j = json.loads(msg)
                    if isinstance(j, dict) and str(j.get("t") or "") == "resize":
                        c = int(j.get("cols") or cols)
                        r = int(j.get("rows") or rows)
                        c = max(40, min(c, 240))
                        r = max(10, min(r, 80))
                        cols, rows = c, r
                        try:
                            await asyncio.to_thread(chan.resize_pty, width=cols, height=rows)
                        except Exception:
                            break
                        continue
                except Exception:
                    pass

            if msg:
                try:
                    await asyncio.to_thread(chan.send, msg.encode("utf-8", errors="ignore"))
                except Exception:
                    break
    finally:
        try:
            end_lease(user_id=int(u["id"]), lease_id=lease_id)
        except Exception:
            pass
        try:
            reader_task.cancel()
        except Exception:
            pass
        try:
            chan.close()
        except Exception:
            pass
        try:
            await _ws_close(websocket, code=1000, reason="closed")
        except Exception:
            pass
        try:
            host_info = s.host or {}
            ssh_target = f"{host_info.get('username') or 'root'}@{host_info.get('address') or ''}:{int(host_info.get('port') or 22)}"
            end_ms = int(time.time() * 1000)
            _audit(
                "pty_close",
                {
                    "id": lease_id,
                    "user_id": int(u["id"]),
                    "session_id": sid,
                    "ssh_target": ssh_target or None,
                    "cwd": cwd,
                    "ok": True,
                    "started_at": int(started_at_ms),
                    "finished_at": int(end_ms),
                    "duration_ms": int(max(0, end_ms - started_at_ms)),
                },
            )
        except Exception:
            pass
