from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any

import paramiko
import os


def _now() -> float:
    return time.time()


@dataclass
class SshSession:
    id: str
    user_id: int
    created_at: float
    last_used_at: float
    host: dict[str, Any]
    client: paramiko.SSHClient

    def touch(self) -> None:
        self.last_used_at = _now()


class SshSessionStore:
    """
    In-memory SSH session store.
    - Isolated per process (single container instance).
    - Sessions are tied to (user_id) and expire by TTL.
    """

    def __init__(self, *, ttl_sec: int = 30 * 60, max_per_user: int = 5, max_total: int = 200):
        self._ttl = int(ttl_sec)
        self._max_per_user = int(max_per_user)
        self._max_total = int(max_total)
        self._lock = threading.Lock()
        self._sessions: dict[str, SshSession] = {}

    @property
    def ttl_sec(self) -> int:
        return int(self._ttl)

    def _purge_locked(self) -> None:
        now = _now()
        expired: list[str] = []
        for sid, s in self._sessions.items():
            if (now - s.last_used_at) > self._ttl:
                expired.append(sid)
        for sid in expired:
            self._close_locked(sid)

        # Hard cap total (best-effort): drop oldest last_used
        if len(self._sessions) > self._max_total:
            order = sorted(self._sessions.values(), key=lambda x: x.last_used_at)
            for s in order[: max(0, len(self._sessions) - self._max_total)]:
                self._close_locked(s.id)

    def _close_locked(self, sid: str) -> None:
        s = self._sessions.pop(sid, None)
        if not s:
            return
        try:
            s.client.close()
        except Exception:
            pass

    def create(self, *, user_id: int, host: dict[str, Any], client: paramiko.SSHClient) -> str:
        sid = "ssh_" + secrets.token_urlsafe(24)
        now = _now()
        with self._lock:
            self._purge_locked()
            # cap per user
            mine = [s for s in self._sessions.values() if s.user_id == user_id]
            if len(mine) >= self._max_per_user:
                mine_sorted = sorted(mine, key=lambda x: x.last_used_at)
                for s in mine_sorted[: max(1, len(mine) - self._max_per_user + 1)]:
                    self._close_locked(s.id)
            self._sessions[sid] = SshSession(
                id=sid, user_id=user_id, created_at=now, last_used_at=now, host=host, client=client
            )
        return sid

    def get(self, *, user_id: int, session_id: str) -> SshSession | None:
        sid = (session_id or "").strip()
        if not sid:
            return None
        with self._lock:
            self._purge_locked()
            s = self._sessions.get(sid)
            if not s or s.user_id != user_id:
                return None
            s.touch()
            return s

    def delete(self, *, user_id: int, session_id: str) -> bool:
        sid = (session_id or "").strip()
        if not sid:
            return False
        with self._lock:
            s = self._sessions.get(sid)
            if not s or s.user_id != user_id:
                return False
            self._close_locked(sid)
            return True


def _env_int(name: str, default: int) -> int:
    try:
        v = int(str(os.environ.get(name) or "").strip() or default)
        return v
    except Exception:
        return default


STORE = SshSessionStore(ttl_sec=_env_int("SSH_SESSION_TTL_SEC", 30 * 60))




