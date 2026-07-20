from __future__ import annotations

import socket
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CheckResult:
    ok: bool | None
    status: str
    summary: str
    details: dict[str, Any]


def tcp_probe(host: str, port: int, *, timeout_sec: float = 3.0) -> dict[str, Any]:
    h = (host or "").strip()
    try:
        p = int(port)
    except Exception:
        p = 0
    if not h or p <= 0:
        return {"ok": False, "error": "invalid_host_or_port", "host": h, "port": p}
    try:
        s = socket.create_connection((h, p), timeout=timeout_sec)
        s.close()
        return {"ok": True, "host": h, "port": p}
    except Exception as e:
        return {"ok": False, "host": h, "port": p, "error": str(e)}

