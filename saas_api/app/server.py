from __future__ import annotations

import os
from pathlib import Path

def _load_env_file(path: str = "/app/.env") -> None:
    """
    Minimal .env loader (no external deps).
    - Only sets keys that are not already present in os.environ
    - Supports KEY=VALUE, ignores blank lines and lines starting with '#'
    """
    try:
        p = Path(path)
        if not p.exists() or not p.is_file():
            return
        for raw in p.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            key = k.strip()
            if not key:
                continue
            if key in os.environ:
                continue
            val = v.strip()
            # strip optional quotes
            if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                val = val[1:-1]
            os.environ[key] = val
    except Exception:
        # best-effort; never block app start
        return


# Ensure /app/.env (bind-mounted on prod) is loaded into process env
_load_env_file("/app/.env")

# IMPORTANT: load env BEFORE importing modules that initialize DB at import time.
from .main import app  # noqa: E402
from .saas import router as saas_router  # noqa: E402
from .overseas_subscription import router as overseas_subscription_router  # noqa: E402
from .auth_login import router as auth_login_router  # noqa: E402
from .auth_wechat import router as auth_wechat_router  # noqa: E402
from .remote_router import router as remote_router  # noqa: E402
from .inventory import router as inventory_router  # noqa: E402
from .rules import router as rules_router  # noqa: E402
from .aiops.asset_sync_runner import start_asset_sync_runtime, stop_asset_sync_runtime  # noqa: E402

app.include_router(saas_router)
app.include_router(overseas_subscription_router)
app.include_router(auth_login_router)
app.include_router(auth_wechat_router)
app.include_router(remote_router)
app.include_router(inventory_router)
app.include_router(rules_router)


def _move_spa_fallback_to_end() -> None:
    """
    main.py may auto-register the SPA catch-all before server.py includes SaaS routers.
    Keep API routes ahead of /{path:path}; otherwise /api/me and admin APIs can be
    swallowed by the static frontend fallback when frontend/dist exists.
    """
    try:
        routes = list(app.router.routes)
        fallback = [r for r in routes if getattr(r, "path", "") == "/{path:path}"]
        if not fallback:
            return
        app.router.routes = [r for r in routes if getattr(r, "path", "") != "/{path:path}"] + fallback
    except Exception:
        return


_move_spa_fallback_to_end()


@app.on_event("startup")
def _startup_asset_sync_runtime() -> None:
    try:
        start_asset_sync_runtime()
    except Exception:
        # Best effort; sync APIs can still return explicit runtime errors later.
        pass


@app.on_event("shutdown")
def _shutdown_asset_sync_runtime() -> None:
    try:
        stop_asset_sync_runtime()
    except Exception:
        pass

# AIOps router is optional in some deployments; don't block API start if missing.
try:  # noqa: E402
    from .aiops.router import router as aiops_router  # type: ignore

    app.include_router(aiops_router)
except Exception:
    pass