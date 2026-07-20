from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _releases_path() -> Path:
    # Prefer explicit path for ops; fallback to repo-local file for dev.
    p = os.environ.get("RELEASES_JSON", "").strip()
    if p:
        return Path(p)
    return _repo_root() / "releases.json"


def load_releases_payload() -> dict[str, Any]:
    """
    Public releases list for download page.
    Expected schema (example):
      { "ok": true, "assets": [ { "platform": "windows", "kind": "installer", "version": "0.1.0", "fileName": "...", "url": "...", "sha256": "..."} ] }
    """
    path = _releases_path()
    if not path.exists():
        return {
            "ok": True,
            "assets": [],
            "note": "releases.json not found; publish artifacts first",
        }
    try:
        raw = path.read_text(encoding="utf-8")
        obj = json.loads(raw) if raw else {}
        assets = obj.get("assets") if isinstance(obj, dict) else None
        if not isinstance(assets, list):
            assets = []
        return {"ok": True, "assets": assets}
    except Exception as e:
        return {"ok": False, "assets": [], "error": str(e)}


