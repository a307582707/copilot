#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
discover_dataworks_deep.py
DataWorks 深度发现，使用环境变量指定的只读 CLI Profile。
"""

from __future__ import print_function

import argparse
import datetime as dt
import json
import os
from typing import Any, Dict, List, Tuple

from asset_domain_v2 import get_db, make_asset_id, write_sync_log
from discover_aliyun_assets_v2_impl import _asset, _tag_health, aliyun_json, persist_assets


def _sync_profile(default: str = "default") -> str:
    return (os.environ.get("AIOPS_SYNC_PROFILE_DATAWORKS") or "").strip() or default


def _sync_account_name(default: str) -> str:
    return (os.environ.get("AIOPS_SYNC_ACCOUNT_NAME") or "").strip() or default


def _sync_env_name(region: str) -> str:
    default = region
    return (os.environ.get("AIOPS_SYNC_ENV") or "").strip() or default


def _env_json_path(region: str) -> str:
    return (os.environ.get("AIOPS_SYNC_ENV_JSON") or "").strip()


def load_env_json(region: str) -> Dict[str, Any]:
    path = _env_json_path(region)
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def list_projects(region: str, profile: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for page_no in range(1, 5):
        j = aliyun_json(profile, ["dataworks-public", "--RegionId", region, "ListProjects", "--PageNumber", str(page_no), "--PageSize", "50"], timeout=30)
        if not j:
            break
        page_rows = ((j.get("Projects") or {}).get("ProjectItem") or ((j.get("Data") or {}).get("Projects") or []))
        rows.extend(page_rows)
        if len(page_rows) < 50:
            break
    return rows


def list_resource_groups(region: str, profile: str) -> List[Dict[str, Any]]:
    j = aliyun_json(profile, ["dataworks-public", "--RegionId", region, "ListResourceGroups", "--PageNumber", "1", "--PageSize", "100"], timeout=30)
    if not j:
        return []
    return ((j.get("ResourceGroups") or {}).get("ResourceGroup") or ((j.get("Data") or {}).get("ResourceGroups") or []))


def list_project_members(region: str, project_id: str, profile: str) -> List[Dict[str, Any]]:
    j = aliyun_json(profile, ["dataworks-public", "--RegionId", region, "ListProjectMembers", "--ProjectId", str(project_id), "--PageNumber", "1", "--PageSize", "100"], timeout=30)
    if not j:
        return []
    return ((j.get("Members") or {}).get("Member") or ((j.get("Data") or {}).get("Members") or []))


def list_task_instances(region: str, project_id: str, profile: str) -> List[Dict[str, Any]]:
    j = aliyun_json(profile, ["dataworks-public", "--RegionId", region, "ListTaskInstances", "--ProjectId", str(project_id), "--PageSize", "20", "--PageNumber", "1"], timeout=30)
    if not j:
        return []
    return ((j.get("TaskInstances") or {}).get("TaskInstance") or ((j.get("Data") or {}).get("TaskInstances") or []))


def build_assets(region: str, env: str, *, profile: str, account_name: str) -> List[Dict[str, Any]]:
    env_cfg = load_env_json(region)
    configured_project_id = str(((env_cfg.get("dataworks") or {}).get("project_id") or "")).strip()
    assets: List[Dict[str, Any]] = []
    projects = list_projects(region, profile)
    resource_groups = list_resource_groups(region, profile)
    project_asset_ids: Dict[str, str] = {}

    for proj in projects:
        proj_id = str(proj.get("ProjectId") or proj.get("Id") or "").strip()
        proj_name = str(proj.get("ProjectName") or proj.get("Name") or proj_id).strip()
        status_val = proj.get("ProjectStatus") or proj.get("Status") or 1
        status_str = "Running" if str(status_val) in ("1", "Running", "running") else "Stopped"
        asset = _asset(
            "DataWorks_Project",
            proj_id,
            proj_name,
            region,
            env,
            status_str,
            _tag_health(status_str),
            purpose="DataWorks 调度项目",
            owner_team="bigdata-platform-sre",
            service_name="dataworks",
            raw_json=proj,
            account_name=account_name,
        )
        assets.append(asset)
        project_asset_ids[proj_id] = make_asset_id("aliyun", "DataWorks_Project", region, proj_id)

        for member in list_project_members(region, proj_id, profile):
            member_id = str(member.get("MemberId") or member.get("OperatorId") or member.get("UserId") or "").strip()
            if not member_id:
                continue
            member_name = str(member.get("DisplayName") or member.get("Nick") or member.get("UserName") or member_id).strip()
            assets.append(
                _asset(
                    "DataWorks_ProjectMember",
                    "%s:%s" % (proj_id, member_id),
                    member_name,
                    region,
                    env,
                    "Active",
                    "ok",
                    parent_resource_id=proj_id,
                    purpose="DataWorks 项目成员",
                    owner_team="bigdata-platform-sre",
                    raw_json=member,
                    relations=[("member_of_project", project_asset_ids[proj_id])],
                    account_name=account_name,
                )
            )

        if configured_project_id and proj_id == configured_project_id:
            for task in list_task_instances(region, proj_id, profile):
                task_id = str(task.get("TaskInstanceId") or task.get("InstanceId") or task.get("Id") or "").strip()
                if not task_id:
                    continue
                task_name = str(task.get("NodeName") or task.get("TaskName") or task_id).strip()
                task_status = str(task.get("Status") or task.get("TaskStatus") or "Unknown").strip()
                assets.append(
                    _asset(
                        "DataWorks_TaskInstance",
                        task_id,
                        task_name,
                        region,
                        env,
                        task_status,
                        _tag_health(task_status),
                        parent_resource_id=proj_id,
                        purpose="DataWorks 任务实例",
                        owner_team="bigdata-platform-sre",
                        raw_json=task,
                        relations=[("task_of_project", project_asset_ids[proj_id])],
                        account_name=account_name,
                    )
                )

    for rg in resource_groups:
        rg_id = str(rg.get("ResourceGroupId") or rg.get("Id") or "").strip()
        if not rg_id:
            continue
        assets.append(
            _asset(
                "DataWorks_ResourceGroup",
                rg_id,
                str(rg.get("ResourceGroupName") or rg.get("Name") or rg_id).strip(),
                region,
                env,
                str(rg.get("Status") or "Available").strip(),
                _tag_health(str(rg.get("Status") or "Available").strip()),
                purpose="DataWorks 资源组",
                owner_team="bigdata-platform-sre",
                service_name="dataworks",
                raw_json=rg,
                account_name=account_name,
            )
        )
    return assets


def main() -> int:
    ap = argparse.ArgumentParser(description="Deep discover DataWorks assets into v2 asset domain.")
    ap.add_argument("--region", default=(os.environ.get("AIOPS_SYNC_REGION") or "all"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    started = dt.datetime.now()
    all_assets: List[Dict[str, Any]] = []
    profile = _sync_profile("default")
    account_name = _sync_account_name(profile)
    regions = ["us-west-1", "cn-shenzhen"] if args.region == "all" else [str(args.region).strip()]
    for region in regions:
        env = _sync_env_name(region)
        all_assets.extend(build_assets(region, env, profile=profile, account_name=account_name))
    print("[info] dataworks_deep assets=%d" % len(all_assets))

    if args.dry_run:
        for asset in all_assets:
            print("[dry-run] %s | %s | %s" % (asset["resource_type"], asset["resource_id"], asset["resource_name"]))
        return 0

    conn = get_db()
    try:
        upserted, errors, _ = persist_assets(conn, all_assets, collector_name="discover_dataworks_deep", dry_run=False)
        write_sync_log(conn, "discover_dataworks_deep", args.region, "all", "ok" if errors == 0 else "partial", len(all_assets), upserted, errors, None, started)
        conn.commit()
        print("[done] dataworks_deep upserted=%d errors=%d" % (upserted, errors))
        return 0 if errors == 0 else 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
