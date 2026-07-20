from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any

from .types import Severity, is_safe_name


@dataclass(frozen=True)
class PolicyDecision:
    ok: bool
    allow_autopilot: bool
    needs_approval: bool
    reason: str


def _kill_switch_on() -> bool:
    v = (os.environ.get("AIOPS_KILL_SWITCH") or "").strip().lower()
    return v in {"1", "true", "yes", "y", "on"}


def _freeze_window_on() -> bool:
    """
    Optional: AIOPS_FREEZE_UTC="23:00-01:00"
    """
    raw = (os.environ.get("AIOPS_FREEZE_UTC") or "").strip()
    if not raw or "-" not in raw:
        return False
    try:
        a, b = raw.split("-", 1)
        ah, am = [int(x) for x in a.split(":")]
        bh, bm = [int(x) for x in b.split(":")]
        now = time.gmtime()
        cur = now.tm_hour * 60 + now.tm_min
        start = ah * 60 + am
        end = bh * 60 + bm
        if start <= end:
            return start <= cur <= end
        # crosses midnight
        return cur >= start or cur <= end
    except Exception:
        return False


def decide_action(
    *,
    action_kind: str,
    risk: str,
    severity: Severity,
    labels: dict[str, Any] | None,
) -> PolicyDecision:
    """
    Minimal MVP policy:
    - Global kill switch blocks everything.
    - Freeze window blocks autopilot (still allows proposal/approval flow).
    - Autopilot only for explicitly low-risk actions and critical/warn incidents.
    """
    if not is_safe_name(action_kind):
        return PolicyDecision(ok=False, allow_autopilot=False, needs_approval=True, reason="invalid action_kind")
    if _kill_switch_on():
        return PolicyDecision(ok=False, allow_autopilot=False, needs_approval=True, reason="kill_switch_on")

    risk0 = (risk or "").strip().lower()
    if risk0 not in {"low", "high"}:
        risk0 = "high"

    # Always require approval for high risk in MVP
    if risk0 == "high":
        return PolicyDecision(ok=True, allow_autopilot=False, needs_approval=True, reason="high_risk_requires_approval")

    # low risk: allow autopilot only if not frozen and severity is non-info
    if _freeze_window_on():
        return PolicyDecision(ok=True, allow_autopilot=False, needs_approval=False, reason="freeze_window_blocks_autopilot")

    # Low risk allowlist (MVP)
    allow = action_kind in {"collect_evidence_basic", "silence_duplicates"}
    if not allow:
        return PolicyDecision(ok=True, allow_autopilot=False, needs_approval=False, reason="low_risk_not_in_allowlist")

    if severity == "info":
        return PolicyDecision(ok=True, allow_autopilot=False, needs_approval=False, reason="info_severity_no_autopilot")

    lab = labels or {}

    # Scope/env guard (MVP):
    # - If labels.env exists, only allow autopilot for envs in allowlist.
    #   Default allowlist is conservative: dev,staging.
    env_allow = (os.environ.get("AIOPS_AUTOPILOT_ENVS") or "dev,staging").strip()
    envs = {x.strip().lower() for x in env_allow.split(",") if x.strip()}
    env = str(lab.get("env") or lab.get("environment") or "").strip().lower()
    if env and envs and env not in envs:
        return PolicyDecision(ok=True, allow_autopilot=False, needs_approval=False, reason=f"env_not_allowed:{env}")

    # Scope/service guard (MVP):
    # - If labels.service exists, only allow autopilot for services in allowlist (when configured).
    svc_allow = (os.environ.get("AIOPS_AUTOPILOT_SERVICES") or "").strip()
    if svc_allow:
        svcs = {x.strip().lower() for x in svc_allow.split(",") if x.strip()}
        svc = str(lab.get("service") or lab.get("app") or "").strip().lower()
        if svc and svcs and svc not in svcs:
            return PolicyDecision(ok=True, allow_autopilot=False, needs_approval=False, reason=f"service_not_allowed:{svc}")

    # Optional scope tag guard (future-friendly):
    # - labels.scope is a single string (e.g. "clusterA/nsX" or "prod/us-west-1").
    # - If allowlist is configured, require match.
    scope_allow = (os.environ.get("AIOPS_AUTOPILOT_SCOPES") or "").strip()
    if scope_allow:
        scopes = {x.strip() for x in scope_allow.split(",") if x.strip()}
        scope = str(lab.get("scope") or "").strip()
        if scope and scopes and scope not in scopes:
            return PolicyDecision(ok=True, allow_autopilot=False, needs_approval=False, reason=f"scope_not_allowed:{scope}")

    # Rate limit (process-local MVP): AIOPS_AUTOPILOT_RATE_PER_H=3
    rate = int(os.environ.get("AIOPS_AUTOPILOT_RATE_PER_H") or 3)
    if rate < 0:
        rate = 0
    if rate == 0:
        return PolicyDecision(ok=True, allow_autopilot=False, needs_approval=False, reason="rate_limit_disabled")
    if not _rate_allow(action_kind, per_hour=rate):
        return PolicyDecision(ok=True, allow_autopilot=False, needs_approval=False, reason="rate_limited")

    return PolicyDecision(ok=True, allow_autopilot=True, needs_approval=False, reason="autopilot_allowed")


_rate_bucket: dict[str, list[int]] = {}


def _rate_allow(key: str, *, per_hour: int) -> bool:
    now = int(time.time())
    win_start = now - 3600
    arr = _rate_bucket.get(key) or []
    arr = [t for t in arr if t >= win_start]
    if len(arr) >= per_hour:
        _rate_bucket[key] = arr
        return False
    arr.append(now)
    _rate_bucket[key] = arr
    return True

