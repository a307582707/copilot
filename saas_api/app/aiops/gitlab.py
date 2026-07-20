from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx


@dataclass(frozen=True)
class GitLabTriggerResult:
    ok: bool
    status_code: int | None
    pipeline_id: int | None
    web_url: str
    error: str
    raw: dict[str, Any] | None = None


def _api_base(url: str) -> str:
    u = (url or "").strip().rstrip("/")
    return u


def trigger_pipeline(
    *,
    gitlab_url: str,
    project: str,
    ref: str,
    trigger_token: str,
    variables: dict[str, str] | None = None,
    timeout_sec: float = 12.0,
) -> GitLabTriggerResult:
    """
    Trigger a GitLab pipeline via trigger token.

    API: POST /api/v4/projects/:id/ref/:ref/trigger/pipeline
    - project can be numeric id OR URL-encoded path (group%2Fproject)
    - variables are passed as variables[KEY]=VALUE
    """
    base = _api_base(gitlab_url)
    proj = (project or "").strip()
    tok = (trigger_token or "").strip()
    rref = (ref or "").strip() or "codesprite"

    if not base or not proj or not tok:
        return GitLabTriggerResult(ok=False, status_code=None, pipeline_id=None, web_url="", error="missing_gitlab_config")

    # project path needs url-encoding (slash -> %2F)
    proj_enc = quote(proj, safe="")
    ref_enc = quote(rref, safe="")
    url = f"{base}/api/v4/projects/{proj_enc}/ref/{ref_enc}/trigger/pipeline"

    data: dict[str, Any] = {"token": tok}
    if variables:
        # GitLab expects variables[KEY]=VALUE (form-encoded)
        for k, v in variables.items():
            if not k:
                continue
            data[f"variables[{k}]"] = str(v)

    try:
        with httpx.Client(timeout=timeout_sec, follow_redirects=True) as client:
            resp = client.post(url, data=data)
            sc = int(resp.status_code)
            txt = resp.text or ""
            try:
                j = resp.json()
            except Exception:
                j = None
            if sc >= 200 and sc < 300 and isinstance(j, dict):
                pid = j.get("id")
                web_url = str(j.get("web_url") or j.get("webUrl") or "")
                return GitLabTriggerResult(ok=True, status_code=sc, pipeline_id=int(pid) if isinstance(pid, int) else None, web_url=web_url, error="", raw=j)
            # error message best-effort
            err = ""
            if isinstance(j, dict):
                err = json.dumps(j, ensure_ascii=False)[:500]
            else:
                err = txt[:500]
            return GitLabTriggerResult(ok=False, status_code=sc, pipeline_id=None, web_url="", error=err or "trigger_failed", raw=j if isinstance(j, dict) else None)
    except Exception as e:
        return GitLabTriggerResult(ok=False, status_code=None, pipeline_id=None, web_url="", error=f"exception:{e.__class__.__name__}")

