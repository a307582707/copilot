from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class PtyLease:
    lease_id: str
    user_id: int
    session_id: str
    manual_active: bool
    created_at_ms: int
    expires_at_ms: int

    @property
    def expired(self) -> bool:
        return _now_ms() >= int(self.expires_at_ms)


_LOCK = threading.Lock()
_LEASES: dict[str, PtyLease] = {}
# While a valid lease exists, exec must be forbidden for that session (Manual/Shell in effect).
_MANUAL_ACTIVE_UNTIL: dict[str, int] = {}  # key: "uid:sessionId" -> expiresAtMs


def _key(user_id: int, session_id: str) -> str:
    return f"{int(user_id)}:{(session_id or '').strip()}"


def create_lease(*, user_id: int, session_id: str, ttl_sec: int = 5 * 60, manual_active: bool = True) -> PtyLease:
    sid = (session_id or "").strip()
    if not sid:
        raise ValueError("Missing sessionId")
    ttl = int(ttl_sec)
    if ttl < 15:
        ttl = 15
    if ttl > 30 * 60:
        ttl = 30 * 60
    now = _now_ms()
    lease_id = "pty_" + secrets.token_urlsafe(18)
    ma = bool(manual_active)
    lease = PtyLease(
        lease_id=lease_id,
        user_id=int(user_id),
        session_id=sid,
        manual_active=ma,
        created_at_ms=now,
        expires_at_ms=now + ttl * 1000,
    )
    with _LOCK:
        _LEASES[lease_id] = lease
        if ma:
            _MANUAL_ACTIVE_UNTIL[_key(user_id, sid)] = int(lease.expires_at_ms)
    return lease


def is_manual_active(*, user_id: int, session_id: str) -> bool:
    sid = (session_id or "").strip()
    if not sid:
        return False
    k = _key(user_id, sid)
    now = _now_ms()
    with _LOCK:
        until = int(_MANUAL_ACTIVE_UNTIL.get(k) or 0)
        if until <= now:
            _MANUAL_ACTIVE_UNTIL.pop(k, None)
            return False
        return True


def renew_manual_active(*, user_id: int, session_id: str, ttl_sec: int = 30 * 60) -> bool:
    """
    Extend Manual/Shell active window for a session.
    Intended usage:
    - Called by PTY WS while the connection is alive (on open and periodically/on activity)
    - end_lease() will clear the manual flag on close
    """
    sid = (session_id or "").strip()
    if not sid:
        return False
    ttl = int(ttl_sec)
    if ttl < 15:
        ttl = 15
    if ttl > 12 * 60 * 60:
        ttl = 12 * 60 * 60
    k = _key(user_id, sid)
    now = _now_ms()
    with _LOCK:
        _MANUAL_ACTIVE_UNTIL[k] = now + ttl * 1000
    return True


def consume_lease(*, user_id: int, lease_id: str, session_id: str) -> PtyLease | None:
    """
    Validate and return lease. Does NOT delete it (WS uses it during the session).
    Caller may later call end_lease().
    """
    lid = (lease_id or "").strip()
    sid = (session_id or "").strip()
    if not lid or not sid:
        return None
    with _LOCK:
        lease = _LEASES.get(lid)
        if not lease:
            return None
        if lease.user_id != int(user_id) or lease.session_id != sid:
            return None
        if lease.expired:
            _LEASES.pop(lid, None)
            return None
        return lease


def end_lease(*, user_id: int, lease_id: str) -> bool:
    lid = (lease_id or "").strip()
    if not lid:
        return False
    with _LOCK:
        lease = _LEASES.get(lid)
        if not lease or lease.user_id != int(user_id):
            return False
        _LEASES.pop(lid, None)
        # Always clear manual active for this session on lease end.
        # (We don't support multiple parallel PTY leases for the same session.)
        k = _key(user_id, lease.session_id)
        _MANUAL_ACTIVE_UNTIL.pop(k, None)
        return True

