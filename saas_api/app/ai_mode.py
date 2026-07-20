from __future__ import annotations

import threading
import time
from dataclasses import dataclass


AI_MODE_UI = {"ask", "plan", "execute", "debug"}


@dataclass
class AiModeState:
    mode: str
    updated_at_ms: int


_LOCK = threading.Lock()
# Keyed by "uid:sessionId" (sessionId is the SSH session id)
_MODE_BY_SESSION: dict[str, AiModeState] = {}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _key(user_id: int, session_id: str) -> str:
    return f"{int(user_id)}:{(session_id or '').strip()}"


def get_ai_mode(*, user_id: int, session_id: str) -> AiModeState:
    """
    Server-enforced AI mode for a given SSH session.
    Default is 'ask' (most restrictive).
    """
    sid = (session_id or "").strip()
    if not sid:
        return AiModeState(mode="ask", updated_at_ms=_now_ms())
    k = _key(user_id, sid)
    with _LOCK:
        st = _MODE_BY_SESSION.get(k)
        if not st:
            return AiModeState(mode="ask", updated_at_ms=_now_ms())
        return st


def set_ai_mode(*, user_id: int, session_id: str, mode: str) -> AiModeState:
    sid = (session_id or "").strip()
    if not sid:
        raise ValueError("Missing sessionId")
    m = (mode or "").strip().lower()
    if m not in AI_MODE_UI:
        raise ValueError("Invalid aiMode")
    st = AiModeState(mode=m, updated_at_ms=_now_ms())
    with _LOCK:
        _MODE_BY_SESSION[_key(user_id, sid)] = st
    return st

