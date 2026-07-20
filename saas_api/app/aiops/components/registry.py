from __future__ import annotations

from typing import Any, Callable

from .base import CheckResult
from . import actiontrail, dataworks, dlf, flink, network, starrocks


ComponentKey = str


def _get_cfg(inst: dict[str, Any]) -> dict[str, Any]:
    raw = inst.get("config_json") or inst.get("config") or {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            import json

            j = json.loads(raw)
            return j if isinstance(j, dict) else {}
        except Exception:
            return {}
    return {}


def connectivity(instance: dict[str, Any]) -> CheckResult:
    key = str(instance.get("component_key") or instance.get("key") or "").strip().lower()
    cfg = _get_cfg(instance)
    if key == "starrocks":
        return starrocks.connectivity(cfg)
    if key == "flink":
        return flink.connectivity(cfg)
    if key == "dataworks":
        return dataworks.connectivity(cfg)
    if key == "dlf":
        return dlf.connectivity(cfg)
    if key == "actiontrail" or key == "actiontrail":
        return actiontrail.connectivity(cfg)
    if key == "network":
        return network.connectivity(cfg)
    return CheckResult(ok=None, status="unknown_component", summary=f"unknown component_key={key}", details={"component_key": key})


def status_snapshot(instance: dict[str, Any]) -> CheckResult:
    # MVP: treat status same as connectivity
    return connectivity(instance)

