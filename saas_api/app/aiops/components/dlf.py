from __future__ import annotations

from typing import Any

from .base import CheckResult


def connectivity(config: dict[str, Any]) -> CheckResult:
    # DLF CLI support may be missing; treat as config-level check.
    catalog = str(config.get("catalog") or "").strip()
    endpoint = str(config.get("endpoint") or "").strip()
    ok = bool(catalog) or bool(endpoint)
    status = "configured" if ok else "missing_config"
    summary = f"DLF configured catalog={catalog or '-'} endpoint={endpoint or '-'}"
    return CheckResult(ok=(True if ok else None), status=status, summary=summary, details={"catalog": catalog, "endpoint": endpoint, "note": "API probe via CI/SDK later"})


def status_snapshot(config: dict[str, Any]) -> CheckResult:
    return connectivity(config)

