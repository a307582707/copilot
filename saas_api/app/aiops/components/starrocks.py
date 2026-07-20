from __future__ import annotations

from typing import Any

from .base import CheckResult, tcp_probe


def connectivity(config: dict[str, Any]) -> CheckResult:
    host = str(config.get("fe_host") or config.get("host") or "").strip()
    mysql_port = int(config.get("mysql_port") or 9030)
    http_port = int(config.get("http_port") or 8030)

    p1 = tcp_probe(host, mysql_port, timeout_sec=2.5)
    p2 = tcp_probe(host, http_port, timeout_sec=2.5)
    ok = bool(p1.get("ok")) and bool(p2.get("ok"))
    status = "ok" if ok else "down"
    summary = f"StarRocks FE {host} mysql={mysql_port} http={http_port} ok={ok}"
    return CheckResult(ok=ok, status=status, summary=summary, details={"mysql": p1, "http": p2})


def status_snapshot(config: dict[str, Any]) -> CheckResult:
    # MVP: reuse connectivity as status.
    return connectivity(config)

