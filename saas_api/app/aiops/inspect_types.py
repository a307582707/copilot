from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Literal

from .types import safe_json


InspectionStatus = Literal["queued", "running", "succeeded", "failed", "timeout", "cancelled"]


def now_s() -> int:
    return int(time.time())


@dataclass(frozen=True)
class InspectionItem:
    component: str
    name: str
    ok: bool
    severity: str = "warn"  # info|warn|critical
    title: str = ""
    description: str = ""
    labels: dict[str, Any] | None = None
    raw: Any | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "component": self.component,
            "name": self.name,
            "ok": bool(self.ok),
            "severity": self.severity,
            "title": self.title,
            "description": self.description,
            "labels": self.labels or {},
            "raw": self.raw,
        }


@dataclass(frozen=True)
class InspectionReport:
    env_id: str
    region: str
    ts: int
    ok: bool
    items: list[InspectionItem]
    artifacts: dict[str, Any] | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "envId": self.env_id,
            "region": self.region,
            "ts": int(self.ts),
            "ok": bool(self.ok),
            "items": [it.to_json() for it in self.items],
            "artifacts": self.artifacts or {},
        }


def parse_report(payload: Any) -> InspectionReport:
    if not isinstance(payload, dict):
        raise ValueError("invalid payload")
    env_id = str(payload.get("envId") or payload.get("env_id") or "").strip()
    region = str(payload.get("region") or "").strip()
    ts = payload.get("ts")
    ok = payload.get("ok")
    items_raw = payload.get("items") or []
    if not env_id:
        raise ValueError("missing envId")
    if not region:
        region = "unknown"
    if not isinstance(ts, int):
        ts = now_s()
    if not isinstance(ok, bool):
        ok = False
    if not isinstance(items_raw, list):
        items_raw = []

    items: list[InspectionItem] = []
    for r in items_raw[:500]:
        if not isinstance(r, dict):
            continue
        comp = str(r.get("component") or "").strip() or "unknown"
        name = str(r.get("name") or "").strip() or "check"
        ok_i = bool(r.get("ok")) if isinstance(r.get("ok"), bool) else False
        sev = str(r.get("severity") or "warn").strip().lower()
        if sev not in {"info", "warn", "critical"}:
            sev = "warn"
        title = str(r.get("title") or "").strip()
        desc = str(r.get("description") or "").strip()
        labels = r.get("labels") if isinstance(r.get("labels"), dict) else {}
        raw = r.get("raw")
        items.append(InspectionItem(component=comp, name=name, ok=ok_i, severity=sev, title=title, description=desc, labels=labels, raw=raw))

    artifacts = payload.get("artifacts") if isinstance(payload.get("artifacts"), dict) else {}
    return InspectionReport(env_id=env_id, region=region, ts=int(ts), ok=bool(ok), items=items, artifacts=artifacts)


def summarize_report(rep: InspectionReport) -> str:
    total = len(rep.items)
    bad = len([x for x in rep.items if not x.ok])
    comps = sorted({x.component for x in rep.items})
    return f"env={rep.env_id} region={rep.region} ok={rep.ok} bad={bad}/{total} components={','.join(comps[:8])}"


def report_json_text(rep: InspectionReport) -> str:
    # store as bounded JSON string
    return safe_json(rep.to_json(), max_chars=200_000)

