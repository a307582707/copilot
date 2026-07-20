from __future__ import annotations

import os
import subprocess
import time
from typing import Any

from .types import clamp_str


def _run_shell_ro(cmd: str, *, timeout_sec: int = 10) -> dict[str, Any]:
    """
    Read-only shell runner for MVP.
    Security notes:
    - Only allow a very small set of commands (hard-coded allowlist).
    - Hard timeout.
    """
    allow = {
        "uptime",
        "df -h",
        "free -m",
        "uname -a",
        "whoami",
    }
    c = " ".join((cmd or "").strip().split())
    if c not in allow:
        return {"ok": False, "error": "command_not_allowed", "cmd": clamp_str(c, 200)}
    try:
        p = subprocess.run(
            ["bash", "-lc", c],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=max(1, min(30, int(timeout_sec))),
            check=False,
            env={**os.environ},
            text=True,
        )
        return {
            "ok": p.returncode == 0,
            "cmd": c,
            "exitCode": int(p.returncode),
            "stdout": clamp_str(p.stdout or "", 40_000),
            "stderr": clamp_str(p.stderr or "", 8_000),
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "cmd": c, "error": "timeout"}
    except Exception as e:
        return {"ok": False, "cmd": c, "error": f"{e.__class__.__name__}"}


def execute_runbook(runbook: dict[str, Any]) -> dict[str, Any]:
    """
    Runbook schema (MVP):
    {
      "kind": "runbook",
      "steps": [
        {"type":"shell_ro","cmd":"uptime"},
        ...
      ],
      "verify": [{"type":"shell_ro","cmd":"df -h"}]?
    }
    """
    steps = runbook.get("steps") if isinstance(runbook, dict) else None
    if not isinstance(steps, list) or not steps:
        return {"ok": False, "error": "empty_runbook"}

    out_steps: list[dict[str, Any]] = []
    started_at = int(time.time())
    rolled_back = False
    rollback_steps_out: list[dict[str, Any]] = []

    def _run_steps(seq: list[Any], *, limit: int) -> tuple[bool, list[dict[str, Any]]]:
        out: list[dict[str, Any]] = []
        for st in seq[:limit]:
            if not isinstance(st, dict):
                continue
            t = str(st.get("type") or "").strip().lower()
            if t != "shell_ro":
                out.append({"ok": False, "error": "unsupported_step_type", "type": t})
                return False, out
            cmd = str(st.get("cmd") or "").strip()
            r = _run_shell_ro(cmd, timeout_sec=int(st.get("timeoutSec") or 10))
            out.append(r)
            if not r.get("ok"):
                return False, out
        return True, out

    for st in steps[:20]:
        ok, out = _run_steps([st], limit=1)
        out_steps.extend(out)
        if not ok:
            # rollback (best-effort)
            rb = runbook.get("rollback")
            if isinstance(rb, list) and rb:
                rolled_back = True
                _, rollback_steps_out = _run_steps(rb, limit=10)
            return {
                "ok": False,
                "startedAt": started_at,
                "steps": out_steps,
                "rolledBack": rolled_back,
                "rollback": rollback_steps_out,
            }

    # verify (best-effort)
    ver = runbook.get("verify")
    out_verify: list[dict[str, Any]] = []
    if isinstance(ver, list):
        for st in ver[:10]:
            if not isinstance(st, dict):
                continue
            t = str(st.get("type") or "").strip().lower()
            if t != "shell_ro":
                out_verify.append({"ok": False, "error": "unsupported_verify_type", "type": t})
                continue
            cmd = str(st.get("cmd") or "").strip()
            out_verify.append(_run_shell_ro(cmd, timeout_sec=int(st.get("timeoutSec") or 10)))

    return {
        "ok": True,
        "startedAt": started_at,
        "steps": out_steps,
        "verify": out_verify,
        "rolledBack": rolled_back,
        "rollback": rollback_steps_out,
    }

