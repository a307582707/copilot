#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
discover_flink_deep.py
Flink 深度发现：
- workspace / namespace / deployment
- 优先 Ververica API，未配置时回退到周报 CSV 中的 deploymentId 事实
"""

from __future__ import print_function

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
from typing import Any, Dict, List, Tuple

from asset_domain_v2 import get_db, make_asset_id, write_sync_log
from discover_aliyun_assets_v2_impl import _asset, _tag_health, aliyun_json, persist_assets


WEEKLY_CSV = os.environ.get("AIOPS_FLINK_FALLBACK_CSV", "")
DEFAULT_ENV_JSON = os.environ.get("AIOPS_SYNC_ENV_JSON", "")


def _sync_region(default: str = "us-west-1") -> str:
    return (os.environ.get("AIOPS_SYNC_REGION") or "").strip() or default


def _sync_env(default: str = "production") -> str:
    return (os.environ.get("AIOPS_SYNC_ENV") or "").strip() or default


def _sync_profile(default: str = "default") -> str:
    return (os.environ.get("AIOPS_SYNC_PROFILE_DEFAULT") or "").strip() or default


def _sync_account_name(default: str) -> str:
    return (os.environ.get("AIOPS_SYNC_ACCOUNT_NAME") or "").strip() or default


def _sync_env_json(default: str = DEFAULT_ENV_JSON) -> str:
    return (os.environ.get("AIOPS_SYNC_ENV_JSON") or "").strip() or default


def parse_weekly_csv(path: str) -> Dict[str, Any]:
    out = {"namespace": "", "deployments": []}
    if not os.path.exists(path):
        return out
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) < 4:
                continue
            category = row[0].strip()
            item = row[1].strip()
            detail = row[2].strip()
            value = row[3].strip()
            if category == "资源开通情况" and item == "Flink":
                m = re.search(r"namespace:\s*([^)）]+)", detail)
                if m:
                    out["namespace"] = m.group(1).strip()
            elif category == "数据采集运行相关" and item != "deploymentId（前8位）":
                deployment_key = item.split("（", 1)[0].strip()
                if deployment_key.startswith("其余"):
                    continue
                out["deployments"].append(
                    {
                        "deployment_id": deployment_key,
                        "delay_peak": value,
                        "gt_5m": row[3].strip() if len(row) > 3 else "",
                        "gt_10m": row[4].strip() if len(row) > 4 else "",
                        "remark": row[5].strip() if len(row) > 5 else "",
                    }
                )
    return out


def load_env_cfg(path: str) -> Dict[str, Any]:
    if not path or not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def discover_live_deployments(region: str, env: str, profile: str, env_json: str) -> Tuple[str, str, List[Dict[str, Any]]]:
    cfg = load_env_cfg(env_json).get("flink", {})
    workspace = str(cfg.get("workspace") or "").strip()
    namespace = str(cfg.get("namespace") or "").strip()
    if workspace.startswith("<"):
        workspace = ""
    if namespace.startswith("<"):
        namespace = ""
    if not workspace or not namespace:
        return workspace, namespace, []
    j = aliyun_json(
        profile,
        [
            "ververica",
            "--endpoint",
            "ververica.%s.aliyuncs.com" % region,
            "ListDeployments",
            "--namespace",
            namespace,
            "--header",
            "workspace=%s" % workspace,
            "--pageSize",
            "100",
        ],
        timeout=30,
    )
    rows = []
    if j:
        rows = (j.get("deployments") or j.get("Deployments") or [])
    return workspace, namespace, rows


def build_assets(
    region: str = "us-west-1",
    env: str = "production",
    *,
    profile: str = "default",
    account_name: str = "default",
    env_json: str = DEFAULT_ENV_JSON,
) -> List[Dict[str, Any]]:
    weekly = parse_weekly_csv(WEEKLY_CSV)
    workspace, namespace, rows = discover_live_deployments(region, env, profile, env_json)
    namespace = namespace or weekly.get("namespace") or "default"
    workspace = workspace or "unknown-workspace"
    assets: List[Dict[str, Any]] = []

    workspace_asset_id = make_asset_id("aliyun", "Flink_Workspace", region, workspace)
    namespace_asset_id = make_asset_id("aliyun", "Flink_Namespace", region, namespace)

    assets.append(
        _asset(
            "Flink_Workspace",
            workspace,
            workspace,
            region,
            env,
            "Running",
            "ok",
            purpose="Ververica Flink 工作空间",
            owner_team="bigdata-platform-sre",
            spec_json={"display": "workspace"},
            raw_json={"source": "env_or_csv"},
            account_name=account_name,
        )
    )
    assets.append(
        _asset(
            "Flink_Namespace",
            namespace,
            namespace,
            region,
            env,
            "Running",
            "ok",
            purpose="Ververica Flink 命名空间",
            owner_team="bigdata-platform-sre",
            spec_json={"display": "namespace"},
            relations=[("namespace_of_workspace", workspace_asset_id)],
            raw_json={"source": "env_or_csv"},
            account_name=account_name,
        )
    )

    if rows:
        for dep in rows:
            dep_id = str(dep.get("deploymentId") or dep.get("Id") or "").strip()
            dep_name = str(dep.get("name") or dep_id).strip()
            state = str((dep.get("status") or {}).get("state") or dep.get("State") or "RUNNING").strip()
            assets.append(
                _asset(
                    "Flink_Deployment",
                    dep_id,
                    dep_name,
                    region,
                    env,
                    state,
                    _tag_health(state),
                    purpose="Flink Deployment",
                    owner_team="bigdata-platform-sre",
                    service_name="flink",
                    spec_json={"display": str(dep.get("engineVersion") or dep.get("flinkVersion") or "")},
                    raw_json=dep,
                    labels_json={"workspace": workspace, "namespace": namespace},
                    relations=[("deployment_of_workspace", workspace_asset_id), ("deployment_of_namespace", namespace_asset_id)],
                    account_name=account_name,
                )
            )
    else:
        for dep in weekly.get("deployments") or []:
            dep_id = dep["deployment_id"]
            health = "warn" if "9." in dep.get("delay_peak", "") or "6." in dep.get("delay_peak", "") else "ok"
            assets.append(
                _asset(
                    "Flink_Deployment",
                    dep_id,
                    "deployment-%s" % dep_id,
                    region,
                    env,
                    "RUNNING",
                    health,
                    purpose="Flink Deployment（周报回落）",
                    owner_team="bigdata-platform-sre",
                    service_name="flink",
                    spec_json={"display": "unknown"},
                    capacity_json={"delay_peak": dep.get("delay_peak")},
                    raw_json=dep,
                    labels_json={"workspace": workspace, "namespace": namespace},
                    relations=[("deployment_of_workspace", workspace_asset_id), ("deployment_of_namespace", namespace_asset_id)],
                    account_name=account_name,
                )
            )
    return assets


def main() -> int:
    ap = argparse.ArgumentParser(description="Deep discover Flink assets into v2 asset domain.")
    ap.add_argument("--region", default=_sync_region("us-west-1"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    started = dt.datetime.now()
    region = str(args.region or _sync_region("us-west-1")).strip() or "us-west-1"
    env = _sync_env(region)
    profile = _sync_profile("default")
    account_name = _sync_account_name(profile)
    env_json = _sync_env_json(DEFAULT_ENV_JSON)
    assets = build_assets(region=region, env=env, profile=profile, account_name=account_name, env_json=env_json)
    print("[info] flink_deep assets=%d" % len(assets))
    if args.dry_run:
        for asset in assets:
            print("[dry-run] %s | %s | %s" % (asset["resource_type"], asset["resource_id"], asset["resource_name"]))
        return 0

    conn = get_db()
    try:
        upserted, errors, _ = persist_assets(conn, assets, collector_name="discover_flink_deep", dry_run=False)
        write_sync_log(conn, "discover_flink_deep", region, env, "ok" if errors == 0 else "partial", len(assets), upserted, errors, None, started)
        conn.commit()
        print("[done] flink_deep upserted=%d errors=%d" % (upserted, errors))
        return 0 if errors == 0 else 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
