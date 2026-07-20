from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass
from typing import Any, Literal


Severity = Literal["info", "warn", "critical"]


def now_ms() -> int:
    return int(time.time() * 1000)


def now_s() -> int:
    return int(time.time())


def clamp_str(s: str, n: int) -> str:
    s = (s or "").strip()
    if len(s) <= n:
        return s
    return s[:n] + "…"


def safe_json(obj: Any, max_chars: int = 200_000) -> str:
    try:
        raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        raw = json.dumps({"error": "json_encode_failed"}, ensure_ascii=True, separators=(",", ":"))
    if len(raw) > max_chars:
        return raw[:max_chars] + "…"
    return raw


def normalize_severity(v: str | None) -> Severity:
    s = str(v or "").strip().lower()
    if s in {"critical", "crit", "p0", "sev0", "sev1", "high"}:
        return "critical"
    if s in {"warn", "warning", "p1", "p2", "sev2", "medium"}:
        return "warn"
    return "info"


def compute_fingerprint(title: str, labels: dict[str, Any] | None) -> str:
    lab = labels or {}
    # Stable key order
    items = sorted([(str(k), str(lab.get(k) or "")) for k in lab.keys()])
    base = json.dumps({"title": title, "labels": items}, ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:24]


def is_safe_name(s: str) -> bool:
    return bool(re.fullmatch(r"[a-zA-Z0-9_.:-]{1,80}", (s or "").strip()))


@dataclass(frozen=True)
class NormalizedAlert:
    source: str
    fingerprint: str
    severity: Severity
    title: str
    description: str
    labels: dict[str, Any]
    annotations: dict[str, Any]
    starts_at: int | None  # epoch seconds
    ends_at: int | None  # epoch seconds
    raw: Any

