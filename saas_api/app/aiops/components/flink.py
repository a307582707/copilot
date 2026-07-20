from __future__ import annotations

from typing import Any

from .base import CheckResult


def connectivity(config: dict[str, Any]) -> CheckResult:
    # MVP: we don't have a safe, stable direct probe without a configured API endpoint.
    # Treat as configuration-level check; actual API probe happens via CI execution channel.
    ws = str(config.get("workspace") or "").strip()
    ns = str(config.get("namespace") or "").strip()
    ok = bool(ws) and bool(ns) and not ws.startswith("<") and not ns.startswith("<")
    status = "configured" if ok else "missing_config"
    summary = f"Flink configured workspace={ws or '-'} namespace={ns or '-'}"
    return CheckResult(ok=(True if ok else None), status=status, summary=summary, details={"workspace": ws, "namespace": ns, "note": "API probe via CI"})


def status_snapshot(config: dict[str, Any]) -> CheckResult:
    return connectivity(config)

