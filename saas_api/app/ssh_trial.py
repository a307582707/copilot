from __future__ import annotations

import os
import time
from dataclasses import dataclass

from fastapi import HTTPException

from .db import connect, fetch_one, init_db


_DB = connect()
init_db(_DB)


def _now() -> int:
    return int(time.time())


def _day_key(ts: int) -> int:
    return int(time.strftime("%Y%m%d", time.localtime(ts)))


def _env_int(name: str, default: int) -> int:
    v = (os.environ.get(name) or "").strip()
    try:
        return int(v)
    except Exception:
        return default


def ssh_trial_days() -> int:
    return max(0, _env_int("SSH_TRIAL_DAYS", 7))


def ssh_trial_sessions_per_day() -> int:
    return max(0, _env_int("SSH_TRIAL_SESSIONS_PER_DAY", 3))


def ssh_trial_ops_per_day() -> int:
    return max(0, _env_int("SSH_TRIAL_OPS_PER_DAY", 30))


def _subscription_row(user_id: int) -> dict | None:
    return fetch_one(_DB, "SELECT status,trial_ends_at,current_period_end FROM subscriptions WHERE user_id=?;", (int(user_id),))


def _trial_end_ts(user: dict) -> int:
    """
    Prefer subscriptions.trial_ends_at when present; otherwise fallback to created_at + SSH_TRIAL_DAYS.
    """
    uid = int(user["id"])
    sub = _subscription_row(uid) or {}
    te = sub.get("trial_ends_at")
    if isinstance(te, int) and te > 0:
        return int(te)
    created = user.get("created_at")
    created_ts = int(created) if isinstance(created, int) and created > 0 else _now()
    return created_ts + ssh_trial_days() * 24 * 3600


def _has_paid_access(user_id: int) -> bool:
    """
    After trial ends, SSH requires an active subscription.
    Users can pay subscription fees with prepaid balance via /api/me/subscription/activate.
    """
    sub = _subscription_row(int(user_id)) or {}
    st = str(sub.get("status") or "").strip().lower()
    if st in {"active", "paid"}:
        return True
    return False


@dataclass(frozen=True)
class SshTrialState:
    in_trial: bool
    trial_ends_at: int
    sessions_limit: int
    ops_limit: int
    sessions_used: int
    ops_used: int


def get_trial_state(user: dict) -> SshTrialState:
    uid = int(user["id"])
    now = _now()
    end_ts = _trial_end_ts(user)
    in_trial = now < end_ts
    day = _day_key(now)
    row = fetch_one(
        _DB,
        "SELECT sessions_created,ops FROM ssh_usage_daily WHERE user_id=? AND day=?;",
        (uid, day),
    ) or {}
    su = int(row.get("sessions_created") or 0)
    ou = int(row.get("ops") or 0)
    return SshTrialState(
        in_trial=bool(in_trial),
        trial_ends_at=int(end_ts),
        sessions_limit=ssh_trial_sessions_per_day(),
        ops_limit=ssh_trial_ops_per_day(),
        sessions_used=su,
        ops_used=ou,
    )


def _bump_daily(uid: int, *, add_sessions: int = 0, add_ops: int = 0) -> tuple[int, int]:
    """
    Atomic-ish counter bump under SQLite write lock.
    Returns (sessions_created, ops) after update.
    """
    now = _now()
    day = _day_key(now)
    _DB.execute("BEGIN IMMEDIATE;")
    try:
        _DB.execute(
            "INSERT OR IGNORE INTO ssh_usage_daily(user_id,day,sessions_created,ops,updated_at) VALUES(?,?,?,?,?);",
            (uid, day, 0, 0, now),
        )
        _DB.execute(
            "UPDATE ssh_usage_daily SET sessions_created=sessions_created+?, ops=ops+?, updated_at=? WHERE user_id=? AND day=?;",
            (int(add_sessions), int(add_ops), now, uid, day),
        )
        row = fetch_one(
            _DB,
            "SELECT sessions_created,ops FROM ssh_usage_daily WHERE user_id=? AND day=?;",
            (uid, day),
        ) or {"sessions_created": 0, "ops": 0}
        _DB.commit()
        return int(row.get("sessions_created") or 0), int(row.get("ops") or 0)
    except Exception:
        try:
            _DB.rollback()
        except Exception:
            pass
        raise


def require_ssh_access(user: dict, *, kind: str) -> None:
    """
    Enforce:
    - during trial: daily limits (3 sessions + 30 ops)
    - after trial: must have paid access (active subscription)

    kind:
      - "session": counts against sessions_created
      - "op": counts against ops
    """
    uid = int(user["id"])
    role = str(user.get("role") or "").strip().lower()
    if role == "admin":
        return

    st = get_trial_state(user)
    if not st.in_trial:
        if _has_paid_access(uid):
            return
        raise HTTPException(
            status_code=402,
            detail={"code": "SshTrialEnded", "trialEndsAt": st.trial_ends_at, "hint": "Please activate a subscription"},
        )

    # Trial enforcement
    if kind == "session":
        if st.sessions_limit > 0 and st.sessions_used >= st.sessions_limit:
            raise HTTPException(
                status_code=402,
                detail={
                    "code": "SshTrialSessionLimit",
                    "sessionsPerDay": st.sessions_limit,
                    "sessionsUsed": st.sessions_used,
                    "trialEndsAt": st.trial_ends_at,
                },
            )
        su, ou = _bump_daily(uid, add_sessions=1, add_ops=0)
        if st.sessions_limit > 0 and su > st.sessions_limit:
            # race fallback
            raise HTTPException(
                status_code=402,
                detail={
                    "code": "SshTrialSessionLimit",
                    "sessionsPerDay": st.sessions_limit,
                    "sessionsUsed": su,
                    "trialEndsAt": st.trial_ends_at,
                },
            )
        _ = ou
        return

    if kind == "op":
        if st.ops_limit > 0 and st.ops_used >= st.ops_limit:
            raise HTTPException(
                status_code=402,
                detail={
                    "code": "SshTrialOpsLimit",
                    "opsPerDay": st.ops_limit,
                    "opsUsed": st.ops_used,
                    "trialEndsAt": st.trial_ends_at,
                },
            )
        su, ou = _bump_daily(uid, add_sessions=0, add_ops=1)
        if st.ops_limit > 0 and ou > st.ops_limit:
            raise HTTPException(
                status_code=402,
                detail={
                    "code": "SshTrialOpsLimit",
                    "opsPerDay": st.ops_limit,
                    "opsUsed": ou,
                    "trialEndsAt": st.trial_ends_at,
                },
            )
        _ = su
        return

    raise HTTPException(status_code=500, detail="Invalid ssh trial kind")

