from __future__ import annotations

from typing import Any

from .base import CheckResult


def connectivity(config: dict[str, Any]) -> CheckResult:
    pid = str(config.get("project_id") or "").strip()
    ident = str(config.get("project_identifier") or "").strip()
    ok = bool(pid) or bool(ident)
    status = "configured" if ok else "missing_config"
    summary = f"DataWorks configured project_id={pid or '-'} identifier={ident or '-'}"
    return CheckResult(ok=(True if ok else None), status=status, summary=summary, details={"project_id": pid, "project_identifier": ident, "note": "API probe via CI"})


def status_snapshot(config: dict[str, Any]) -> CheckResult:
    return connectivity(config)

