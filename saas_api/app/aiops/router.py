from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..db import connect, fetch_all, fetch_one
from ..saas import current_user, require_admin
from .components.registry import status_snapshot
from .components_store import (
    add_snapshot,
    ensure_component_catalog,
    get_instance,
    get_latest_snapshot,
    list_instances,
    list_latest_snapshots,
    upsert_instance,
)
from .asset_sync_runner import enqueue_sync_run
from .asset_sync_store import (
    create_sync_run,
    delete_sync_schedule,
    find_active_sync_run,
    get_sync_run,
    list_sync_runs,
    list_sync_schedules,
    next_cron_ts,
    upsert_sync_schedule,
)
from .settings import get_setting, set_setting

router = APIRouter()

_DB = connect()
try:
    ensure_component_catalog(_DB)
except Exception:
    pass

_ASSET_TABLE_CACHE: dict[str, bool] = {}


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _asset_db_name() -> str:
    return (os.environ.get("AIOPS_ASSET_DB_NAME") or os.environ.get("ASSET_DB_NAME") or "codesprite_assets").strip() or "codesprite_assets"


def _inspection_out_root() -> Path:
    raw = (os.environ.get("AIOPS_INSPECTION_OUT_ROOT") or "").strip()
    if raw:
        return Path(raw)
    return _repo_root() / "data" / "aiops"


def _ts(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return int(v)
    if isinstance(v, float):
        return int(v)
    if isinstance(v, datetime):
        return int(v.timestamp())
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        try:
            return int(float(s))
        except Exception:
            pass
        try:
            if s.endswith("Z"):
                return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
        except Exception:
            return None
    return None


def _safe_json(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return {}
    s = raw.strip()
    if not s:
        return {}
    try:
        obj = json.loads(s)
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def _health_to_ok(health: str, lifecycle_status: str) -> bool | None:
    life = str(lifecycle_status or "").strip().lower()
    if life == "missing":
        return False
    x = str(health or "").strip().lower()
    if x == "ok":
        return True
    if x in {"warn", "error"}:
        return False
    return None


def _component_key_for_resource_type(resource_type: str) -> str:
    rt = str(resource_type or "").strip().lower()
    if "starrocks" in rt:
        return "starrocks"
    if "flink" in rt:
        return "flink"
    if "dataworks" in rt:
        return "dataworks"
    if "dlf" in rt:
        return "dlf"
    if "actiontrail" in rt:
        return "actiontrail"
    if any(x in rt for x in ["ecs", "host", "server"]):
        return "host"
    if any(x in rt for x in ["vpc", "vswitch", "nat", "eip", "vbr", "cen", "slb", "nlb", "network", "route", "securitygroup"]):
        return "network"
    return rt or "other"


def _component_label(component_key: str) -> str:
    return {
        "host": "主机",
        "network": "网络",
        "starrocks": "StarRocks",
        "flink": "Flink",
        "dataworks": "DataWorks",
        "dlf": "DLF",
        "actiontrail": "ActionTrail",
    }.get(component_key, component_key or "other")


def _asset_table_name(table: str) -> str:
    if _DB.kind == "mysql":
        return f"`{_asset_db_name()}`.`{table}`"
    return table


def _asset_table_exists(table: str) -> bool:
    cached = _ASSET_TABLE_CACHE.get(table)
    if cached is not None:
        return cached
    try:
        if _DB.kind == "mysql":
            row = fetch_one(
                _DB,
                "SELECT table_name FROM information_schema.tables WHERE table_schema=? AND table_name=? LIMIT 1;",
                (_asset_db_name(), table),
            )
            ok = bool(row)
        else:
            row = fetch_one(_DB, "SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1;", (table,))
            ok = bool(row)
    except Exception:
        ok = False
    _ASSET_TABLE_CACHE[table] = ok
    return ok


def _asset_domain_ready() -> bool:
    return _asset_table_exists("asset_master") and _asset_table_exists("asset_observations_latest")


def _parse_settings_list(raw: str) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        obj = json.loads(raw)
    except Exception:
        return []
    if not isinstance(obj, list):
        return []
    return [it for it in obj if isinstance(it, dict)]


def _asset_account_names() -> list[str]:
    if not _asset_domain_ready():
        return []
    try:
        rows = fetch_all(
            _DB,
            f"""
SELECT DISTINCT COALESCE(account_name, '') AS account_name
FROM {_asset_table_name('asset_master')}
WHERE lifecycle_status <> 'retired' AND COALESCE(account_name, '') <> ''
ORDER BY account_name ASC;
""",
            (),
        )
    except Exception:
        return []
    return [str(r.get("account_name") or "").strip() for r in rows if str(r.get("account_name") or "").strip()]


def _default_cloud_accounts() -> list[dict[str, Any]]:
    discovered_accounts = _asset_account_names()
    return [
        {
            "key": "aliyun-cn",
            "label": "国内-阿里云",
            "enabled": True,
            # 当前资产域模型里的 account_name 还是 CLI profile 名，先把已发现账号默认归到国内账号，避免页面一上来筛不到数据。
            "assetAccountNames": discovered_accounts,
        },
        {
            "key": "aliyun-intl",
            "label": "国际-阿里云",
            "enabled": True,
            "assetAccountNames": [],
        },
    ]


def _normalize_cloud_accounts(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in items:
        key = str(raw.get("key") or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        labels = str(raw.get("label") or key).strip() or key
        asset_account_names = sorted(
            {
                str(v).strip()
                for v in (raw.get("assetAccountNames") if isinstance(raw.get("assetAccountNames"), list) else [])
                if str(v).strip()
            }
        )
        out.append(
            {
                "key": key,
                "label": labels,
                "enabled": bool(raw.get("enabled") if raw.get("enabled") is not None else True),
                "assetAccountNames": asset_account_names,
            }
        )
    return out


def _load_cloud_accounts() -> list[dict[str, Any]]:
    items = _normalize_cloud_accounts(_parse_settings_list(get_setting(_DB, "asset_sync.cloud_accounts")))
    return items or _default_cloud_accounts()


def _save_cloud_accounts(items: list[dict[str, Any]], *, by_user_id: int | None) -> None:
    payload = json.dumps(_normalize_cloud_accounts(items), ensure_ascii=False, separators=(",", ":"))
    set_setting(_DB, key="asset_sync.cloud_accounts", value=payload, by_user_id=by_user_id)


def _normalize_cli_accounts(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    now = int(datetime.now().timestamp())
    for raw in items:
        cli_id = str(raw.get("id") or "").strip()
        name = str(raw.get("name") or "").strip()
        if not cli_id or cli_id in seen or not name:
            continue
        seen.add(cli_id)
        cloud_account_keys = sorted(
            {
                str(v).strip()
                for v in (raw.get("cloudAccountKeys") if isinstance(raw.get("cloudAccountKeys"), list) else [])
                if str(v).strip()
            }
        )
        regions = sorted(
            {
                str(v).strip()
                for v in (raw.get("regions") if isinstance(raw.get("regions"), list) else [])
                if str(v).strip()
            }
        )
        out.append(
            {
                "id": cli_id,
                "name": name,
                "profileDefault": str(raw.get("profileDefault") or "").strip(),
                "profileDataworks": str(raw.get("profileDataworks") or "").strip(),
                "cloudAccountKeys": cloud_account_keys,
                "regions": regions,
                "enabled": bool(raw.get("enabled") if raw.get("enabled") is not None else True),
                "updatedAt": int(raw.get("updatedAt") or now),
            }
        )
    return sorted(out, key=lambda x: (0 if x.get("enabled") else 1, str(x.get("name") or "").lower(), str(x.get("id") or "")))


def _load_cli_accounts() -> list[dict[str, Any]]:
    return _normalize_cli_accounts(_parse_settings_list(get_setting(_DB, "asset_sync.cli_accounts")))


def _save_cli_accounts(items: list[dict[str, Any]], *, by_user_id: int | None) -> None:
    payload = json.dumps(_normalize_cli_accounts(items), ensure_ascii=False, separators=(",", ":"))
    set_setting(_DB, key="asset_sync.cli_accounts", value=payload, by_user_id=by_user_id)


def _list_cli_accounts_for_cloud(account_key: str = "") -> list[dict[str, Any]]:
    key = str(account_key or "").strip()
    items = [it for it in _load_cli_accounts() if bool(it.get("enabled"))]
    if not key:
        return items
    return [it for it in items if key in (it.get("cloudAccountKeys") or [])]


def _get_enabled_cli_account(cli_account_id: str) -> dict[str, Any] | None:
    target = str(cli_account_id or "").strip()
    for item in _load_cli_accounts():
        if str(item.get("id") or "") == target and bool(item.get("enabled")):
            return item
    return None


def _resolve_account_scope(account: str) -> tuple[str, tuple[Any, ...]]:
    key = str(account or "").strip()
    if not key:
        return "", ()
    cloud_accounts = _load_cloud_accounts()
    cloud = next((it for it in cloud_accounts if str(it.get("key") or "") == key), None)
    if cloud:
        names = {
            str(v).strip()
            for v in (cloud.get("assetAccountNames") if isinstance(cloud.get("assetAccountNames"), list) else [])
            if str(v).strip()
        }
        for cli in _list_cli_accounts_for_cloud(key):
            for candidate in [cli.get("profileDefault"), cli.get("profileDataworks"), cli.get("name")]:
                val = str(candidate or "").strip()
                if val:
                    names.add(val)
        if not names:
            return " AND 1=0", ()
        placeholders = ",".join(["?"] * len(names))
        return f" AND COALESCE(m.account_name, '') IN ({placeholders})", tuple(sorted(names))
    return " AND COALESCE(m.account_name, '') = ?", (key,)


def _latest_sync_ts() -> int | None:
    try:
        if _asset_table_exists("asset_sync_log"):
            row = fetch_one(
                _DB,
                f"SELECT finished_at FROM {_asset_table_name('asset_sync_log')} WHERE sync_type IN ('discover_v2','discover','discover_dataworks_deep','discover_flink_deep','discover_starrocks_deep') ORDER BY finished_at DESC LIMIT 1;",
                (),
            )
            if row:
                ts = _ts(row.get("finished_at"))
                if ts:
                    return ts
    except Exception:
        pass
    try:
        row = fetch_one(_DB, f"SELECT MAX(last_seen_at) AS finished_at FROM {_asset_table_name('asset_master')};", ())
        return _ts((row or {}).get("finished_at"))
    except Exception:
        return None


def _flatten_numeric(prefix: str, value: Any, out: list[dict[str, Any]], *, limit: int = 40) -> None:
    if len(out) >= limit:
        return
    if isinstance(value, bool):
        return
    if isinstance(value, (int, float)):
        out.append({"name": prefix, "value": value})
        return
    if isinstance(value, dict):
        for k, v in value.items():
            if len(out) >= limit:
                break
            child = f"{prefix}.{k}" if prefix else str(k)
            _flatten_numeric(child, v, out, limit=limit)
        return
    if isinstance(value, list):
        for idx, v in enumerate(value):
            if len(out) >= limit:
                break
            child = f"{prefix}[{idx}]"
            _flatten_numeric(child, v, out, limit=limit)


def _manual_items(limit: int = 200) -> list[dict[str, Any]]:
    try:
        instances = list_instances(_DB, limit=limit)
        latest = {str(r.get("instance_id") or ""): r for r in list_latest_snapshots(_DB, limit=limit)}
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for inst in instances:
        iid = str(inst.get("id") or "")
        out.append(
            {
                "instance": {
                    "id": iid,
                    "component_key": str(inst.get("component_key") or ""),
                    "component_label": _component_label(str(inst.get("component_key") or "")),
                    "name": str(inst.get("name") or iid),
                    "env": str(inst.get("env") or ""),
                    "region": str(inst.get("region") or ""),
                    "enabled": bool(inst.get("enabled") if inst.get("enabled") is not None else True),
                    "updated_at": _ts(inst.get("updated_at")) or _ts(inst.get("created_at")),
                    "source": "manual",
                    "role_arn": str(inst.get("role_arn") or ""),
                    "config_json": str(inst.get("config_json") or "{}"),
                },
                "snapshot": latest.get(iid),
            }
        )
    return out


def _asset_items(limit: int = 200, q: str = "") -> list[dict[str, Any]]:
    if not _asset_domain_ready():
        return []
    kw = str(q or "").strip()
    where = "WHERE m.lifecycle_status <> 'retired'"
    args: list[Any] = []
    if kw:
        where += " AND (m.resource_name LIKE ? OR m.resource_id LIKE ? OR m.resource_type LIKE ?)"
        like = f"%{kw}%"
        args.extend([like, like, like])
    sql = f"""
SELECT
  m.asset_id,
  m.resource_type,
  m.resource_id,
  m.resource_name,
  COALESCE(m.account_name, '') AS account_name,
  COALESCE(m.region, 'global') AS region,
  COALESCE(m.env, '') AS env,
  m.lifecycle_status,
  m.last_seen_at,
  o.observed_at,
  o.status,
  o.health,
  o.alert_24h,
  o.summary,
  s.spec_json,
  s.capacity_json,
  s.network_json
FROM {_asset_table_name('asset_master')} m
LEFT JOIN {_asset_table_name('asset_observations_latest')} o ON o.asset_id = m.asset_id
LEFT JOIN {_asset_table_name('asset_config_snapshots')} s ON s.asset_id = m.asset_id AND s.is_latest = 1
{where}
ORDER BY COALESCE(o.observed_at, m.last_seen_at) DESC
LIMIT ?
"""
    args.append(max(1, min(500, int(limit))))
    try:
        rows = fetch_all(_DB, sql, tuple(args))
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        component_key = _component_key_for_resource_type(str(row.get("resource_type") or ""))
        out.append(
            {
                "instance": {
                    "id": str(row.get("asset_id") or ""),
                    "component_key": component_key,
                    "component_label": _component_label(component_key),
                    "name": str(row.get("resource_name") or row.get("resource_id") or row.get("asset_id") or ""),
                    "env": str(row.get("env") or ""),
                    "region": str(row.get("region") or ""),
                    "enabled": str(row.get("lifecycle_status") or "") != "missing",
                    "updated_at": _ts(row.get("observed_at")) or _ts(row.get("last_seen_at")),
                    "source": "asset_domain",
                    "resource_type": str(row.get("resource_type") or ""),
                    "lifecycle_status": str(row.get("lifecycle_status") or ""),
                    "alert_24h": int(row.get("alert_24h") or 0),
                    "spec_json": row.get("spec_json"),
                    "capacity_json": row.get("capacity_json"),
                    "network_json": row.get("network_json"),
                },
                "snapshot": {
                    "ts": _ts(row.get("observed_at")) or _ts(row.get("last_seen_at")),
                    "ok": _health_to_ok(str(row.get("health") or ""), str(row.get("lifecycle_status") or "")),
                    "status": str(row.get("status") or row.get("health") or row.get("lifecycle_status") or ""),
                    "summary": str(row.get("summary") or ""),
                },
            }
        )
    return out


def _summary_from_asset_domain(region: str = "", account: str = "") -> dict[str, Any]:
    if not _asset_domain_ready():
        return _summary_manual_fallback(region=region, account=account)
    region_where = ""
    region_args: tuple = ()
    if region:
        region_where = " AND COALESCE(m.region, 'global') = ?"
        region_args = (region,)
    account_where, account_args = _resolve_account_scope(account)
    try:
        summary_row = fetch_one(
            _DB,
            f"""
SELECT
  COUNT(1) AS total,
  SUM(CASE WHEN COALESCE(o.health, 'unknown') = 'ok' AND m.lifecycle_status <> 'missing' THEN 1 ELSE 0 END) AS healthy,
  SUM(CASE WHEN COALESCE(o.health, 'unknown') = 'warn' AND m.lifecycle_status <> 'missing' THEN 1 ELSE 0 END) AS warning,
  SUM(CASE WHEN COALESCE(o.health, 'unknown') = 'error' AND m.lifecycle_status <> 'missing' THEN 1 ELSE 0 END) AS error,
  SUM(CASE WHEN COALESCE(o.health, 'unknown') = 'unknown' AND m.lifecycle_status <> 'missing' THEN 1 ELSE 0 END) AS unknown_cnt,
  SUM(CASE WHEN m.lifecycle_status = 'missing' THEN 1 ELSE 0 END) AS missing
FROM {_asset_table_name('asset_master')} m
LEFT JOIN {_asset_table_name('asset_observations_latest')} o ON o.asset_id = m.asset_id
WHERE m.lifecycle_status <> 'retired'{region_where}{account_where};
""",
            region_args + account_args,
        ) or {}
        type_rows = fetch_all(
            _DB,
            f"""
SELECT m.resource_type, COUNT(1) AS cnt
FROM {_asset_table_name('asset_master')} m
WHERE m.lifecycle_status <> 'retired'{region_where}{account_where}
GROUP BY m.resource_type
ORDER BY cnt DESC, m.resource_type ASC;
""",
            region_args + account_args,
        )
        region_rows = fetch_all(
            _DB,
            f"""
SELECT COALESCE(m.region, 'global') AS region, COUNT(1) AS cnt
FROM {_asset_table_name('asset_master')} m
WHERE m.lifecycle_status <> 'retired'{account_where}
GROUP BY COALESCE(m.region, 'global')
ORDER BY cnt DESC, region ASC;
""",
            account_args,
        )
        env_rows = fetch_all(
            _DB,
            f"""
SELECT COALESCE(NULLIF(m.env, ''), 'unknown') AS env, COUNT(1) AS cnt
FROM {_asset_table_name('asset_master')} m
WHERE m.lifecycle_status <> 'retired'{region_where}{account_where}
GROUP BY COALESCE(NULLIF(m.env, ''), 'unknown')
ORDER BY cnt DESC, env ASC;
""",
            region_args + account_args,
        )
    except Exception:
        return _summary_manual_fallback(region=region, account=account)
    domain_counts = {"bigdata": 0, "host": 0, "network": 0, "other": 0}
    by_type: list[dict[str, Any]] = []
    for row in type_rows:
        rt = str(row.get("resource_type") or "")
        cnt = int(row.get("cnt") or 0)
        ck = _component_key_for_resource_type(rt)
        if ck in {"starrocks", "flink", "dataworks", "dlf", "actiontrail"}:
            domain_counts["bigdata"] += cnt
        elif ck == "host":
            domain_counts["host"] += cnt
        elif ck == "network":
            domain_counts["network"] += cnt
        else:
            domain_counts["other"] += cnt
        by_type.append({"key": rt, "componentKey": ck, "label": _component_label(ck), "count": cnt})
    return {
        "resources": {
            "total": int(summary_row.get("total") or 0),
            "healthy": int(summary_row.get("healthy") or 0),
            "warning": int(summary_row.get("warning") or 0),
            "error": int(summary_row.get("error") or 0),
            "unknown": int(summary_row.get("unknown_cnt") or 0),
            "missing": int(summary_row.get("missing") or 0),
        },
        "domains": domain_counts,
        "byType": by_type,
        "byRegion": [{"key": str(r.get("region") or "global"), "count": int(r.get("cnt") or 0)} for r in region_rows],
        "byEnv": [{"key": str(r.get("env") or "unknown"), "count": int(r.get("cnt") or 0)} for r in env_rows],
        "lastSyncAt": _latest_sync_ts(),
        "refreshStrategy": {
            "mode": "jenkins_to_mysql_readonly",
            "source": f"{_asset_db_name()}.asset_master",
            "writable": False,
            "note": "阿里云资源由 Jenkins/发现脚本定时写入资产域模型，SaaS 侧只读消费，不在页面内直接改发现链路。",
        },
    }


def _summary_manual_fallback(region: str = "", account: str = "") -> dict[str, Any]:
    items = _manual_items(limit=500)
    if region:
        items = [it for it in items if str(it.get("instance", {}).get("region") or "global") == region]
    _ = account
    total = len(items)
    healthy = sum(1 for it in items if it.get("snapshot", {}).get("ok") is True)
    unhealthy = sum(1 for it in items if it.get("snapshot", {}).get("ok") is False)
    return {
        "resources": {
            "total": total,
            "healthy": healthy,
            "warning": 0,
            "error": unhealthy,
            "unknown": max(0, total - healthy - unhealthy),
            "missing": 0,
        },
        "domains": {
            "bigdata": sum(1 for it in items if str(it["instance"].get("component_key") or "") in {"starrocks", "flink", "dataworks", "dlf", "actiontrail", "network"}),
            "host": sum(1 for it in items if str(it["instance"].get("component_key") or "") == "host"),
            "network": sum(1 for it in items if str(it["instance"].get("component_key") or "") == "network"),
            "other": sum(1 for it in items if str(it["instance"].get("component_key") or "") not in {"starrocks", "flink", "dataworks", "dlf", "actiontrail", "network", "host"}),
        },
        "byType": [],
        "byRegion": [],
        "byEnv": [],
        "lastSyncAt": None,
        "refreshStrategy": {
            "mode": "manual_components_only",
            "source": "saas_api.aiops_component_instances",
            "writable": True,
            "note": "当前未检测到 codesprite_assets 资产域模型，已回退到 SaaS 内置组件实例表。",
        },
    }



def _asset_changes(limit: int = 20) -> list[dict[str, Any]]:
    if not (_asset_domain_ready() and _asset_table_exists("asset_lifecycle_events")):
        return []
    try:
        rows = fetch_all(
            _DB,
            f"""
SELECT
  e.event_id,
  e.asset_id,
  e.event_type,
  e.event_time,
  e.source,
  e.remark,
  m.resource_name,
  m.resource_type,
  COALESCE(m.region, 'global') AS region,
  COALESCE(m.env, '') AS env
FROM {_asset_table_name('asset_lifecycle_events')} e
LEFT JOIN {_asset_table_name('asset_master')} m ON m.asset_id = e.asset_id
ORDER BY e.event_time DESC
LIMIT ?;
""",
            (max(1, min(100, int(limit))),),
        )
    except Exception:
        return []
    return [
        {
            "id": r.get("event_id"),
            "assetId": str(r.get("asset_id") or ""),
            "assetName": str(r.get("resource_name") or r.get("asset_id") or ""),
            "resourceType": str(r.get("resource_type") or ""),
            "componentKey": _component_key_for_resource_type(str(r.get("resource_type") or "")),
            "eventType": str(r.get("event_type") or ""),
            "eventTime": _ts(r.get("event_time")),
            "region": str(r.get("region") or ""),
            "env": str(r.get("env") or ""),
            "source": str(r.get("source") or ""),
            "remark": str(r.get("remark") or ""),
        }
        for r in rows
    ]


def _inspection_files() -> list[Path]:
    root = _inspection_out_root()
    if not root.exists():
        return []
    return sorted(root.glob("*/inspection.bigdata.*.json"), reverse=True)


def _load_inspection(path: Path) -> dict[str, Any] | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(raw, dict):
        return None
    items = raw.get("items") if isinstance(raw.get("items"), list) else []
    bad = sum(1 for it in items if isinstance(it, dict) and it.get("ok") is False)
    warn = sum(1 for it in items if isinstance(it, dict) and it.get("ok") is False and "警告" in str(((it.get("columns") or {}) if isinstance(it.get("columns"), dict) else {}).get("健康度") or ""))
    return {
        "id": path.parent.name,
        "path": str(path),
        "ts": _ts(raw.get("ts")),
        "env": str(raw.get("env") or ""),
        "region": str(raw.get("region") or ""),
        "ok": bool(raw.get("ok")),
        "status": "normal" if bool(raw.get("ok")) else ("warning" if warn and warn == bad else "error"),
        "summary": f"共 {len(items)} 项，异常 {bad} 项",
        "items": items,
    }


def _asset_metric_detail(asset_id: str) -> dict[str, Any]:
    if not _asset_domain_ready():
        raise HTTPException(status_code=404, detail="Asset metrics are unavailable")
    row = fetch_one(
        _DB,
        f"""
SELECT
  m.asset_id,
  m.resource_type,
  m.resource_name,
  COALESCE(m.region, 'global') AS region,
  COALESCE(m.env, '') AS env,
  m.lifecycle_status,
  o.observed_at,
  o.status,
  o.health,
  o.alert_24h,
  o.summary,
  o.details_json,
  s.spec_json,
  s.capacity_json,
  s.network_json,
  s.raw_json
FROM {_asset_table_name('asset_master')} m
LEFT JOIN {_asset_table_name('asset_observations_latest')} o ON o.asset_id = m.asset_id
LEFT JOIN {_asset_table_name('asset_config_snapshots')} s ON s.asset_id = m.asset_id AND s.is_latest = 1
WHERE m.asset_id=?
LIMIT 1;
""",
        (str(asset_id or "").strip(),),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Asset not found")
    metrics: list[dict[str, Any]] = []
    details = _safe_json(row.get("details_json"))
    spec = _safe_json(row.get("spec_json"))
    capacity = _safe_json(row.get("capacity_json"))
    network = _safe_json(row.get("network_json"))
    raw = _safe_json(row.get("raw_json"))
    _flatten_numeric("details", details, metrics)
    _flatten_numeric("capacity", capacity, metrics)
    _flatten_numeric("spec", spec, metrics)
    _flatten_numeric("network", network, metrics)
    if len(metrics) < 30:
        _flatten_numeric("raw", raw, metrics, limit=30)
    starrocks_nodes: list[dict[str, Any]] = []
    if _asset_table_exists("sr_node_details") and "starrocks" in str(row.get("resource_type") or "").lower():
        sr_rows = fetch_all(
            _DB,
            f"""
SELECT node_role, COUNT(1) AS total, SUM(CASE WHEN alive = 1 THEN 1 ELSE 0 END) AS alive_total
FROM {_asset_table_name('sr_node_details')}
WHERE cluster_asset_id=? OR warehouse_asset_id=?
GROUP BY node_role
ORDER BY node_role ASC;
""",
            (str(asset_id or "").strip(), str(asset_id or "").strip()),
        )
        starrocks_nodes = [
            {"role": str(r.get("node_role") or ""), "total": int(r.get("total") or 0), "alive": int(r.get("alive_total") or 0)}
            for r in sr_rows
        ]
    return {
        "resourceId": str(row.get("asset_id") or ""),
        "metric": "snapshot",
        "timeseriesUnavailable": True,
        "current": {
            "resourceType": str(row.get("resource_type") or ""),
            "resourceName": str(row.get("resource_name") or ""),
            "region": str(row.get("region") or ""),
            "env": str(row.get("env") or ""),
            "lifecycleStatus": str(row.get("lifecycle_status") or ""),
            "observedAt": _ts(row.get("observed_at")),
            "status": str(row.get("status") or ""),
            "health": str(row.get("health") or ""),
            "alert24h": int(row.get("alert_24h") or 0),
            "summary": str(row.get("summary") or ""),
        },
        "metrics": metrics[:30],
        "starrocksNodes": starrocks_nodes,
    }


def _starrocks_asset_row(resource_type: str, asset_id: str) -> dict[str, Any] | None:
    return fetch_one(
        _DB,
        f"""
SELECT
  m.asset_id,
  m.resource_type,
  m.resource_id,
  m.resource_name,
  COALESCE(m.account_name, '') AS account_name,
  COALESCE(m.region, 'global') AS region,
  COALESCE(m.env, '') AS env,
  m.parent_resource_id,
  m.lifecycle_status,
  m.last_seen_at,
  o.observed_at,
  o.status,
  o.health,
  o.alert_24h,
  o.summary,
  o.details_json,
  s.spec_json,
  s.capacity_json,
  s.network_json,
  s.raw_json
FROM {_asset_table_name('asset_master')} m
LEFT JOIN {_asset_table_name('asset_observations_latest')} o ON o.asset_id = m.asset_id
LEFT JOIN {_asset_table_name('asset_config_snapshots')} s ON s.asset_id = m.asset_id AND s.is_latest = 1
WHERE m.asset_id=? AND m.resource_type=?
LIMIT 1;
""",
        (str(asset_id or "").strip(), str(resource_type or "").strip()),
    )


def _starrocks_node_role_summary(*, cluster_asset_id: str | None = None, warehouse_asset_id: str | None = None) -> list[dict[str, Any]]:
    if not _asset_table_exists("sr_node_details"):
        return []
    if cluster_asset_id:
        where = "cluster_asset_id=?"
        args: tuple[Any, ...] = (str(cluster_asset_id or "").strip(),)
    elif warehouse_asset_id:
        where = "warehouse_asset_id=?"
        args = (str(warehouse_asset_id or "").strip(),)
    else:
        return []
    rows = fetch_all(
        _DB,
        f"""
SELECT
  node_role,
  COUNT(1) AS total,
  SUM(CASE WHEN alive = 1 THEN 1 ELSE 0 END) AS alive_total,
  SUM(COALESCE(cpu_cores, 0)) AS cpu_total,
  SUM(COALESCE(memory_gb, 0)) AS memory_total_gb,
  SUM(COALESCE(disk_size_gb, 0)) AS disk_total_gb
FROM {_asset_table_name('sr_node_details')}
WHERE {where}
GROUP BY node_role
ORDER BY node_role ASC;
""",
        args,
    )
    return [
        {
            "role": str(r.get("node_role") or ""),
            "total": int(r.get("total") or 0),
            "alive": int(r.get("alive_total") or 0),
            "cpuTotal": int(r.get("cpu_total") or 0),
            "memoryTotalGb": float(r.get("memory_total_gb") or 0),
            "diskTotalGb": int(r.get("disk_total_gb") or 0),
        }
        for r in rows
    ]


def _starrocks_be_nodes_for_warehouse(warehouse_asset_id: str, *, limit: int = 50) -> list[dict[str, Any]]:
    if not _asset_table_exists("sr_node_details"):
        return []
    rows = fetch_all(
        _DB,
        f"""
SELECT
  node_asset_id,
  node_role,
  host_or_ip,
  port,
  version,
  spec_display,
  cpu_cores,
  memory_gb,
  disk_type,
  disk_size_gb,
  az,
  alive,
  node_status,
  description,
  last_sync_at
FROM {_asset_table_name('sr_node_details')}
WHERE warehouse_asset_id=? AND node_role='BE'
ORDER BY COALESCE(cpu_cores, 0) DESC, node_asset_id ASC
LIMIT ?;
""",
        (str(warehouse_asset_id or "").strip(), max(1, min(int(limit), 200))),
    )
    return [
        {
            "assetId": str(r.get("node_asset_id") or ""),
            "role": str(r.get("node_role") or ""),
            "host": str(r.get("host_or_ip") or ""),
            "port": r.get("port"),
            "version": str(r.get("version") or ""),
            "specDisplay": str(r.get("spec_display") or ""),
            "cpuCores": r.get("cpu_cores"),
            "memoryGb": r.get("memory_gb"),
            "diskType": str(r.get("disk_type") or ""),
            "diskSizeGb": r.get("disk_size_gb"),
            "az": str(r.get("az") or ""),
            "alive": (bool(r.get("alive")) if r.get("alive") is not None else None),
            "status": str(r.get("node_status") or ""),
            "description": str(r.get("description") or ""),
            "lastSyncAt": _ts(r.get("last_sync_at")),
        }
        for r in rows
    ]


def _starrocks_warehouse_live(raw_json: Any) -> dict[str, Any]:
    raw = _safe_json(raw_json)
    live = raw.get("live") if isinstance(raw.get("live"), dict) else {}
    if not isinstance(live, dict):
        live = {}
    out: dict[str, Any] = {
        "id": live.get("Id"),
        "name": live.get("Name"),
        "state": live.get("State"),
        "nodeCount": live.get("NodeCount"),
        "currentClusterCount": live.get("CurrentClusterCount"),
        "maxClusterCount": live.get("MaxClusterCount"),
        "runningSql": live.get("RunningSQL"),
        "queuedSql": live.get("QueuedSQL"),
        "createdOn": live.get("CreatedOn"),
        "resumedOn": live.get("ResumedOn"),
        "updatedOn": live.get("UpdatedOn"),
    }
    return {k: v for k, v in out.items() if v not in (None, "", [])}


def _starrocks_warehouse_rows(cluster_row: dict[str, Any], *, limit: int = 100) -> list[dict[str, Any]]:
    if not _asset_domain_ready():
        return []
    use_relations = _asset_table_exists("asset_relations")
    relation_clause = ""
    args: list[Any] = []
    if use_relations:
        relation_clause = f"""
OR EXISTS (
  SELECT 1
  FROM {_asset_table_name('asset_relations')} r
  WHERE r.src_asset_id = m.asset_id
    AND r.dst_asset_id = ?
    AND r.relation_type = 'warehouse_of_cluster'
    AND r.effective_to IS NULL
)
"""
        args.append(str(cluster_row.get("asset_id") or ""))
    args = [str(cluster_row.get("resource_id") or "")] + args + [max(1, min(int(limit), 200))]
    rows = fetch_all(
        _DB,
        f"""
SELECT
  m.asset_id,
  m.resource_type,
  m.resource_id,
  m.resource_name,
  COALESCE(m.region, 'global') AS region,
  COALESCE(m.env, '') AS env,
  m.parent_resource_id,
  m.lifecycle_status,
  m.last_seen_at,
  o.observed_at,
  o.status,
  o.health,
  o.alert_24h,
  o.summary,
  s.spec_json,
  s.capacity_json,
  s.network_json,
  s.raw_json
FROM {_asset_table_name('asset_master')} m
LEFT JOIN {_asset_table_name('asset_observations_latest')} o ON o.asset_id = m.asset_id
LEFT JOIN {_asset_table_name('asset_config_snapshots')} s ON s.asset_id = m.asset_id AND s.is_latest = 1
WHERE m.resource_type='StarRocks_Warehouse'
  AND (
    m.parent_resource_id = ?
    {relation_clause}
  )
ORDER BY COALESCE(o.observed_at, m.last_seen_at) DESC, m.resource_name ASC
LIMIT ?;
""",
        tuple(args),
    )
    items: list[dict[str, Any]] = []
    for row in rows:
        role_summary = _starrocks_node_role_summary(warehouse_asset_id=str(row.get("asset_id") or ""))
        spec = _safe_json(row.get("spec_json"))
        capacity = _safe_json(row.get("capacity_json"))
        items.append(
            {
                "assetId": str(row.get("asset_id") or ""),
                "name": str(row.get("resource_name") or row.get("resource_id") or ""),
                "region": str(row.get("region") or ""),
                "env": str(row.get("env") or ""),
                "lifecycleStatus": str(row.get("lifecycle_status") or ""),
                "observedAt": _ts(row.get("observed_at")) or _ts(row.get("last_seen_at")),
                "status": str(row.get("status") or ""),
                "health": str(row.get("health") or ""),
                "alert24h": int(row.get("alert_24h") or 0),
                "summary": str(row.get("summary") or ""),
                "spec": spec,
                "capacity": capacity,
                "network": _safe_json(row.get("network_json")),
                "live": _starrocks_warehouse_live(row.get("raw_json")),
                "nodeRoleSummary": role_summary,
                "beNodeCount": sum(int(r.get("total") or 0) for r in role_summary if str(r.get("role") or "") == "BE"),
                "nodeCount": spec.get("node_count"),
                "diskIoPeakPct": capacity.get("disk_io_peak_pct"),
                "diskIoAvgPct": capacity.get("disk_io_avg_pct"),
            }
        )
    return items


def _starrocks_cluster_detail(cluster_asset_id: str) -> dict[str, Any]:
    row = _starrocks_asset_row("StarRocks_Cluster", cluster_asset_id)
    if not row:
        raise HTTPException(status_code=404, detail="StarRocks cluster not found")
    role_summary = _starrocks_node_role_summary(cluster_asset_id=str(row.get("asset_id") or ""))
    warehouses = _starrocks_warehouse_rows(row)
    return {
        "assetId": str(row.get("asset_id") or ""),
        "resourceId": str(row.get("resource_id") or ""),
        "name": str(row.get("resource_name") or row.get("resource_id") or ""),
        "accountName": str(row.get("account_name") or ""),
        "region": str(row.get("region") or ""),
        "env": str(row.get("env") or ""),
        "lifecycleStatus": str(row.get("lifecycle_status") or ""),
        "observedAt": _ts(row.get("observed_at")) or _ts(row.get("last_seen_at")),
        "status": str(row.get("status") or ""),
        "health": str(row.get("health") or ""),
        "alert24h": int(row.get("alert_24h") or 0),
        "summary": str(row.get("summary") or ""),
        "spec": _safe_json(row.get("spec_json")),
        "capacity": _safe_json(row.get("capacity_json")),
        "network": _safe_json(row.get("network_json")),
        "raw": _safe_json(row.get("raw_json")),
        "nodeRoleSummary": role_summary,
        "warehouses": warehouses,
        "warehouseCount": len(warehouses),
    }


def _starrocks_filter_options() -> dict[str, list[str]]:
    if not _asset_domain_ready():
        return {"regions": [], "accounts": []}
    rows = fetch_all(
        _DB,
        f"""
SELECT DISTINCT
  COALESCE(region, 'global') AS region,
  COALESCE(account_name, '') AS account_name
FROM {_asset_table_name('asset_master')}
WHERE resource_type='StarRocks_Cluster'
  AND lifecycle_status <> 'retired'
ORDER BY region ASC, account_name ASC;
""",
        (),
    )
    regions = sorted({str(r.get("region") or "global").strip() for r in rows if str(r.get("region") or "").strip()})
    accounts = sorted({str(r.get("account_name") or "").strip() for r in rows if str(r.get("account_name") or "").strip()})
    return {"regions": regions, "accounts": accounts}


def _starrocks_warehouse_detail(warehouse_asset_id: str) -> dict[str, Any]:
    row = _starrocks_asset_row("StarRocks_Warehouse", warehouse_asset_id)
    if not row:
        raise HTTPException(status_code=404, detail="StarRocks warehouse not found")
    cluster_asset_id = ""
    cluster_name = ""
    if _asset_table_exists("asset_relations"):
        rel = fetch_one(
            _DB,
            f"""
SELECT dst_asset_id
FROM {_asset_table_name('asset_relations')}
WHERE src_asset_id=? AND relation_type='warehouse_of_cluster' AND effective_to IS NULL
ORDER BY relation_id DESC
LIMIT 1;
""",
            (str(warehouse_asset_id or "").strip(),),
        )
        cluster_asset_id = str((rel or {}).get("dst_asset_id") or "")
    if not cluster_asset_id and row.get("parent_resource_id"):
        cluster = fetch_one(
            _DB,
            f"SELECT asset_id, resource_name FROM {_asset_table_name('asset_master')} WHERE resource_type='StarRocks_Cluster' AND resource_id=? LIMIT 1;",
            (str(row.get("parent_resource_id") or ""),),
        )
        cluster_asset_id = str((cluster or {}).get("asset_id") or "")
        cluster_name = str((cluster or {}).get("resource_name") or "")
    elif cluster_asset_id:
        cluster = fetch_one(
            _DB,
            f"SELECT asset_id, resource_name FROM {_asset_table_name('asset_master')} WHERE asset_id=? LIMIT 1;",
            (cluster_asset_id,),
        )
        cluster_name = str((cluster or {}).get("resource_name") or "")
    role_summary = _starrocks_node_role_summary(warehouse_asset_id=str(row.get("asset_id") or ""))
    be_nodes = _starrocks_be_nodes_for_warehouse(str(row.get("asset_id") or ""))
    return {
        "assetId": str(row.get("asset_id") or ""),
        "resourceId": str(row.get("resource_id") or ""),
        "name": str(row.get("resource_name") or row.get("resource_id") or ""),
        "region": str(row.get("region") or ""),
        "env": str(row.get("env") or ""),
        "lifecycleStatus": str(row.get("lifecycle_status") or ""),
        "observedAt": _ts(row.get("observed_at")) or _ts(row.get("last_seen_at")),
        "status": str(row.get("status") or ""),
        "health": str(row.get("health") or ""),
        "alert24h": int(row.get("alert_24h") or 0),
        "summary": str(row.get("summary") or ""),
        "spec": _safe_json(row.get("spec_json")),
        "capacity": _safe_json(row.get("capacity_json")),
        "network": _safe_json(row.get("network_json")),
        "raw": _safe_json(row.get("raw_json")),
        "live": _starrocks_warehouse_live(row.get("raw_json")),
        "cluster": {"assetId": cluster_asset_id, "name": cluster_name},
        "nodeRoleSummary": role_summary,
        "beNodes": be_nodes,
    }


def _starrocks_clusters(limit: int = 100, q: str = "", region: str = "", account: str = "") -> list[dict[str, Any]]:
    if not _asset_domain_ready():
        return []
    args: list[Any] = []
    where = "WHERE m.resource_type='StarRocks_Cluster' AND m.lifecycle_status <> 'retired'"
    if q.strip():
        like = f"%{q.strip()}%"
        where += " AND (m.resource_name LIKE ? OR m.resource_id LIKE ?)"
        args.extend([like, like])
    if region.strip():
        where += " AND COALESCE(m.region, 'global') = ?"
        args.append(region.strip())
    if account.strip():
        where += " AND COALESCE(m.account_name, '') = ?"
        args.append(account.strip())
    args.append(max(1, min(int(limit), 200)))
    rows = fetch_all(
        _DB,
        f"""
SELECT
  m.asset_id,
  m.resource_id,
  m.resource_name,
  COALESCE(m.account_name, '') AS account_name,
  COALESCE(m.region, 'global') AS region,
  COALESCE(m.env, '') AS env,
  m.lifecycle_status,
  m.last_seen_at,
  o.observed_at,
  o.status,
  o.health,
  o.alert_24h,
  o.summary
FROM {_asset_table_name('asset_master')} m
LEFT JOIN {_asset_table_name('asset_observations_latest')} o ON o.asset_id = m.asset_id
{where}
ORDER BY COALESCE(o.observed_at, m.last_seen_at) DESC, m.resource_name ASC
LIMIT ?;
""",
        tuple(args),
    )
    items: list[dict[str, Any]] = []
    for row in rows:
        detail = _starrocks_cluster_detail(str(row.get("asset_id") or ""))
        items.append(
            {
                "assetId": detail["assetId"],
                "resourceId": detail["resourceId"],
                "name": detail["name"],
                "accountName": detail["accountName"],
                "region": detail["region"],
                "env": detail["env"],
                "lifecycleStatus": detail["lifecycleStatus"],
                "observedAt": detail["observedAt"],
                "status": detail["status"],
                "health": detail["health"],
                "alert24h": detail["alert24h"],
                "summary": detail["summary"],
                "warehouseCount": detail["warehouseCount"],
                "nodeRoleSummary": detail["nodeRoleSummary"],
            }
        )
    return items


@router.get("/api/aiops/components_public")
def api_aiops_components_public(limit: int = 200, q: str = "", _: dict = Depends(current_user)):
    items = _asset_items(limit=limit, q=q)
    items.extend(_manual_items(limit=max(20, min(int(limit), 200))))
    return {"ok": True, "items": items[: max(1, min(int(limit), 500))]}


@router.get("/api/aiops/starrocks/clusters")
def api_aiops_starrocks_clusters(limit: int = 100, q: str = "", region: str = "", account: str = "", _: dict = Depends(current_user)):
    items = _starrocks_clusters(limit=limit, q=q, region=region, account=account)
    return {"ok": True, "items": items, "total": len(items)}


@router.get("/api/aiops/starrocks/filters")
def api_aiops_starrocks_filters(_: dict = Depends(current_user)):
    return {"ok": True, **_starrocks_filter_options()}


@router.get("/api/aiops/starrocks/clusters/{cluster_asset_id}")
def api_aiops_starrocks_cluster_detail(cluster_asset_id: str, _: dict = Depends(current_user)):
    return {"ok": True, "cluster": _starrocks_cluster_detail(cluster_asset_id)}


@router.get("/api/aiops/starrocks/clusters/{cluster_asset_id}/warehouses")
def api_aiops_starrocks_cluster_warehouses(cluster_asset_id: str, _: dict = Depends(current_user)):
    row = _starrocks_asset_row("StarRocks_Cluster", cluster_asset_id)
    if not row:
        raise HTTPException(status_code=404, detail="StarRocks cluster not found")
    return {"ok": True, "items": _starrocks_warehouse_rows(row)}


@router.get("/api/aiops/starrocks/warehouses/{warehouse_asset_id}")
def api_aiops_starrocks_warehouse_detail(warehouse_asset_id: str, _: dict = Depends(current_user)):
    return {"ok": True, "warehouse": _starrocks_warehouse_detail(warehouse_asset_id)}


@router.get("/api/aiops/assets/summary")
def api_aiops_assets_summary(region: str = "", account: str = "", _: dict = Depends(current_user)):
    return {"ok": True, **_summary_from_asset_domain(region=region.strip(), account=account.strip())}


@router.get("/api/aiops/sync/options")
def api_aiops_sync_options(account: str = "", _: dict = Depends(current_user)):
    selected_account = str(account or "").strip()
    cloud_accounts = [it for it in _load_cloud_accounts() if bool(it.get("enabled"))]
    cli_accounts = _list_cli_accounts_for_cloud(selected_account)
    return {
        "ok": True,
        "cloudAccounts": [
            {
                "key": str(it.get("key") or ""),
                "label": str(it.get("label") or ""),
                "enabled": bool(it.get("enabled")),
            }
            for it in cloud_accounts
        ],
        "cliAccounts": cli_accounts,
    }


@router.post("/api/aiops/sync/cli-accounts")
def api_aiops_upsert_cli_account(payload: dict, u: dict = Depends(require_admin)):
    name = str(payload.get("name") or "").strip()
    cli_id = str(payload.get("id") or "").strip()
    profile_default = str(payload.get("profileDefault") or "").strip()
    profile_dataworks = str(payload.get("profileDataworks") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="CLI 账号名称不能为空")
    if not profile_default and not profile_dataworks:
        raise HTTPException(status_code=400, detail="至少需要填写一个 profile")
    if not cli_id:
        cli_id = f"cli-{int(datetime.now().timestamp() * 1000)}"
    cloud_account_keys = [str(v).strip() for v in (payload.get("cloudAccountKeys") if isinstance(payload.get("cloudAccountKeys"), list) else []) if str(v).strip()]
    regions = [str(v).strip() for v in (payload.get("regions") if isinstance(payload.get("regions"), list) else []) if str(v).strip()]
    enabled = bool(payload.get("enabled") if payload.get("enabled") is not None else True)

    cli_accounts = _load_cli_accounts()
    updated = False
    for idx, item in enumerate(cli_accounts):
        if str(item.get("id") or "") != cli_id:
            continue
        cli_accounts[idx] = {
            "id": cli_id,
            "name": name,
            "profileDefault": profile_default,
            "profileDataworks": profile_dataworks,
            "cloudAccountKeys": cloud_account_keys,
            "regions": regions,
            "enabled": enabled,
            "updatedAt": int(datetime.now().timestamp()),
        }
        updated = True
        break
    if not updated:
        cli_accounts.append(
            {
                "id": cli_id,
                "name": name,
                "profileDefault": profile_default,
                "profileDataworks": profile_dataworks,
                "cloudAccountKeys": cloud_account_keys,
                "regions": regions,
                "enabled": enabled,
                "updatedAt": int(datetime.now().timestamp()),
            }
        )
    _save_cli_accounts(cli_accounts, by_user_id=int(u.get("id")) if isinstance(u.get("id"), int) else None)
    _save_cloud_accounts(_load_cloud_accounts(), by_user_id=int(u.get("id")) if isinstance(u.get("id"), int) else None)
    return {"ok": True, "id": cli_id}


@router.post("/api/aiops/sync/run")
def api_aiops_sync_run(payload: dict, u: dict = Depends(require_admin)):
    account = str(payload.get("account") or "").strip()
    cli_account_id = str(payload.get("cliAccountId") or "").strip()
    region = str(payload.get("region") or "").strip() or "all"
    if not account:
        raise HTTPException(status_code=400, detail="missing account")
    if not cli_account_id:
        raise HTTPException(status_code=400, detail="missing cli account")
    cli = _get_enabled_cli_account(cli_account_id)
    if not cli:
        raise HTTPException(status_code=404, detail="CLI 账号不存在或已停用")
    if account not in (cli.get("cloudAccountKeys") or []):
        raise HTTPException(status_code=400, detail="当前 CLI 账号不适用于所选阿里云账号")
    if not str(cli.get("profileDefault") or "").strip():
        raise HTTPException(status_code=400, detail="当前 CLI 账号缺少 Default Profile")
    if not str(cli.get("profileDataworks") or "").strip():
        raise HTTPException(status_code=400, detail="当前 CLI 账号缺少 DataWorks Profile")
    allowed_regions = [str(v).strip() for v in (cli.get("regions") if isinstance(cli.get("regions"), list) else []) if str(v).strip()]
    if region != "all" and allowed_regions and region not in allowed_regions:
        raise HTTPException(status_code=400, detail="当前 CLI 账号未覆盖所选区域")

    active = find_active_sync_run(
        _DB,
        cloud_account_key=account,
        cli_account_id=cli_account_id,
        region=region,
    )
    if active:
        return {"ok": True, "queued": True, "runId": active.get("id"), "run": active, "message": "已有运行中的同步任务，已直接返回当前任务。"}

    run_id = create_sync_run(
        _DB,
        cloud_account_key=account,
        cli_account_id=cli_account_id,
        region=region,
        trigger_mode="manual",
        triggered_by=int(u.get("id")) if isinstance(u.get("id"), int) else None,
    )
    enqueue_sync_run(run_id)
    run = get_sync_run(_DB, run_id)
    return {
        "ok": True,
        "queued": True,
        "runId": run_id,
        "run": run,
        "message": "已提交本机同步任务。",
    }


@router.get("/api/aiops/sync/runs")
def api_aiops_sync_runs(limit: int = 20, account: str = "", status: str = "", _: dict = Depends(require_admin)):
    items = list_sync_runs(_DB, limit=limit, cloud_account_key=str(account or "").strip(), status=str(status or "").strip())
    return {"ok": True, "items": items}


@router.get("/api/aiops/sync/runs/{run_id}")
def api_aiops_sync_run_detail(run_id: str, _: dict = Depends(require_admin)):
    row = get_sync_run(_DB, run_id)
    if not row:
        raise HTTPException(status_code=404, detail="sync run not found")
    return {"ok": True, "run": row}


@router.get("/api/aiops/sync/schedules")
def api_aiops_sync_schedules(_: dict = Depends(require_admin)):
    return {"ok": True, "items": list_sync_schedules(_DB)}


@router.post("/api/aiops/sync/schedules")
def api_aiops_sync_schedule_upsert(payload: dict, u: dict = Depends(require_admin)):
    schedule_id = str(payload.get("id") or "").strip()
    account = str(payload.get("account") or "").strip()
    cli_account_id = str(payload.get("cliAccountId") or "").strip()
    region = str(payload.get("region") or "").strip() or "all"
    cron_expr = str(payload.get("cronExpr") or "").strip()
    enabled = bool(payload.get("enabled") if payload.get("enabled") is not None else True)
    if not account:
        raise HTTPException(status_code=400, detail="missing account")
    if not cli_account_id:
        raise HTTPException(status_code=400, detail="missing cli account")
    if not cron_expr:
        raise HTTPException(status_code=400, detail="missing cronExpr")
    cli = _get_enabled_cli_account(cli_account_id)
    if not cli:
        raise HTTPException(status_code=404, detail="CLI 账号不存在或已停用")
    if account not in (cli.get("cloudAccountKeys") or []):
        raise HTTPException(status_code=400, detail="当前 CLI 账号不适用于所选阿里云账号")
    try:
        next_ts = next_cron_ts(cron_expr)
    except Exception:
        raise HTTPException(status_code=400, detail="cronExpr 非法，当前仅支持标准 5 段 cron")
    schedule_id = upsert_sync_schedule(
        _DB,
        schedule_id=schedule_id,
        cloud_account_key=account,
        cli_account_id=cli_account_id,
        region=region,
        cron_expr=cron_expr,
        enabled=enabled,
        updated_by=int(u.get("id")) if isinstance(u.get("id"), int) else None,
    )
    return {"ok": True, "id": schedule_id, "nextRunAt": next_ts if enabled else None}


@router.post("/api/aiops/sync/schedules/{schedule_id}/delete")
def api_aiops_sync_schedule_delete(schedule_id: str, _: dict = Depends(require_admin)):
    delete_sync_schedule(_DB, schedule_id)
    return {"ok": True}


@router.get("/api/aiops/assets/changes")
def api_aiops_assets_changes(limit: int = 20, _: dict = Depends(current_user)):
    return {"ok": True, "items": _asset_changes(limit=limit)}


@router.get("/api/aiops/monitoring/dashboard")
def api_aiops_monitoring_dashboard(_: dict = Depends(current_user)):
    summary = _summary_from_asset_domain()
    resources = summary.get("resources") or {}
    return {
        "ok": True,
        "alerts": {
            "critical": int(resources.get("error") or 0),
            "warning": int(resources.get("warning") or 0),
            "info": int(resources.get("healthy") or 0),
        },
        "resources": {
            "total": int(resources.get("total") or 0),
            "healthy": int(resources.get("healthy") or 0),
            "unhealthy": int(resources.get("warning") or 0) + int(resources.get("error") or 0) + int(resources.get("missing") or 0),
        },
        "domains": summary.get("domains") or {},
        "lastSyncAt": summary.get("lastSyncAt"),
        "refreshStrategy": summary.get("refreshStrategy") or {},
    }


@router.get("/api/aiops/monitoring/metrics/{resource_id}")
def api_aiops_monitoring_metrics(resource_id: str, _: dict = Depends(current_user)):
    return {"ok": True, **_asset_metric_detail(resource_id)}


@router.get("/api/aiops/inspection/latest")
def api_aiops_inspection_latest(_: dict = Depends(current_user)):
    for path in _inspection_files():
        row = _load_inspection(path)
        if row:
            return {"ok": True, **row}
    return {"ok": True, "status": "unknown", "summary": "暂无巡检结果", "items": []}


@router.get("/api/aiops/inspection/history")
def api_aiops_inspection_history(page: int = 1, size: int = 20, _: dict = Depends(current_user)):
    p = max(1, int(page))
    n = max(1, min(100, int(size)))
    rows = [_load_inspection(path) for path in _inspection_files()]
    items = [r for r in rows if r]
    start = (p - 1) * n
    end = start + n
    return {"ok": True, "items": items[start:end], "total": len(items), "page": p, "size": n}


@router.get("/api/aiops/components/instances/{instance_id}/history")
def api_aiops_component_history(instance_id: str, page: int = 1, limit: int = 20, _: dict = Depends(current_user)):
    p = max(1, int(page))
    n = max(1, min(100, int(limit)))
    offset = (p - 1) * n
    inst = get_instance(_DB, instance_id)
    if inst:
        rows = fetch_all(
            _DB,
            "SELECT id,instance_id,ts,ok,status,summary FROM aiops_component_snapshots WHERE instance_id=? ORDER BY ts DESC LIMIT ? OFFSET ?;",
            (str(instance_id or "").strip(), n + 1, offset),
        )
        has_more = len(rows) > n
        return {"ok": True, "items": rows[:n], "hasMore": has_more}
    if _asset_domain_ready() and _asset_table_exists("asset_lifecycle_events"):
        rows = fetch_all(
            _DB,
            f"""
SELECT event_id AS id, asset_id AS instance_id, event_time AS ts, NULL AS ok, event_type AS status, COALESCE(remark, event_type) AS summary
FROM {_asset_table_name('asset_lifecycle_events')}
WHERE asset_id=?
ORDER BY event_time DESC
LIMIT ? OFFSET ?;
""",
            (str(instance_id or "").strip(), n + 1, offset),
        )
        items = []
        for row in rows[:n]:
            items.append(
                {
                    "id": row.get("id"),
                    "instance_id": row.get("instance_id"),
                    "ts": _ts(row.get("ts")),
                    "ok": None,
                    "status": row.get("status"),
                    "summary": row.get("summary"),
                }
            )
        return {"ok": True, "items": items, "hasMore": len(rows) > n}
    return {"ok": True, "items": [], "hasMore": False}


@router.post("/api/aiops/components/instances/upsert")
def api_aiops_component_upsert(payload: dict, u: dict = Depends(current_user)):
    iid = upsert_instance(
        _DB,
        instance_id=str(payload.get("id") or ""),
        component_key=str(payload.get("componentKey") or payload.get("component_key") or ""),
        name=str(payload.get("name") or ""),
        env=str(payload.get("env") or ""),
        region=str(payload.get("region") or ""),
        role_arn=str(payload.get("roleArn") or payload.get("role_arn") or ""),
        config=(payload.get("config") if isinstance(payload.get("config"), dict) else {}),
        enabled=bool(payload.get("enabled") if payload.get("enabled") is not None else True),
        by_user_id=int(u.get("id")) if isinstance(u.get("id"), int) else None,
    )
    inst = get_instance(_DB, iid)
    return {"ok": True, "id": iid, "instance": inst}


@router.post("/api/aiops/components/instances/{instance_id}/test")
def api_aiops_component_test(instance_id: str, _: dict = Depends(current_user)):
    inst = get_instance(_DB, instance_id)
    if inst:
        result = status_snapshot(inst)
        sid = add_snapshot(
            _DB,
            instance_id=instance_id,
            ok=result.ok,
            status=result.status,
            summary=result.summary,
            details=result.details,
        )
        snap = get_latest_snapshot(_DB, instance_id)
        return {"ok": True, "snapshotId": sid, "result": {"ok": result.ok, "status": result.status, "summary": result.summary, "details": result.details}, "snapshot": snap}
    if _asset_domain_ready():
        row = fetch_one(
            _DB,
            f"""
SELECT
  asset_id,
  resource_type,
  resource_name,
  COALESCE(region, 'global') AS region,
  COALESCE(env, '') AS env,
  lifecycle_status,
  last_seen_at
FROM {_asset_table_name('asset_master')}
WHERE asset_id=?
LIMIT 1;
""",
            (str(instance_id or "").strip(),),
        )
        if row:
            current = _asset_metric_detail(instance_id).get("current") or {}
            ok = _health_to_ok(str(current.get("health") or ""), str(current.get("lifecycleStatus") or ""))
            return {
                "ok": True,
                "readonly": True,
                "result": {
                    "ok": ok,
                    "status": current.get("status") or current.get("health") or row.get("lifecycle_status"),
                    "summary": current.get("summary") or "只读资产来自定时发现链路，本接口返回最近一次观测结果。",
                    "details": {"source": "asset_domain", "resource_type": row.get("resource_type"), "last_seen_at": _ts(row.get("last_seen_at"))},
                },
            }
    raise HTTPException(status_code=404, detail="Component instance not found")
