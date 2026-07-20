from __future__ import annotations

from typing import Any

from .base import CheckResult


def connectivity(config: dict[str, Any]) -> CheckResult:
    # MVP: only validate region and optional probe targets.
    region = str(config.get("region") or "").strip()
    targets = config.get("targets") if isinstance(config.get("targets"), list) else []
    ok = bool(region)
    status = "configured" if ok else "missing_config"
    summary = f"Network configured region={region or '-'} targets={len(targets)}"
    return CheckResult(ok=(True if ok else None), status=status, summary=summary, details={"region": region, "targets": targets, "note": "Detailed checks via CI later"})


def status_snapshot(config: dict[str, Any]) -> CheckResult:
    return connectivity(config)

