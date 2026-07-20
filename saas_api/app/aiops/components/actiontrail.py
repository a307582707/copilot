from __future__ import annotations

from typing import Any

from .base import CheckResult


def connectivity(config: dict[str, Any]) -> CheckResult:
    # ActionTrail is API-based; for MVP treat as config-level and rely on CI for real probe.
    region = str(config.get("region") or "").strip()
    ok = bool(region)
    status = "configured" if ok else "missing_config"
    summary = f"ActionTrail configured region={region or '-'}"
    return CheckResult(ok=(True if ok else None), status=status, summary=summary, details={"region": region, "note": "API probe via CI"})


def status_snapshot(config: dict[str, Any]) -> CheckResult:
    return connectivity(config)

