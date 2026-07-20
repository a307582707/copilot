#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
discover_starrocks_deep.py
StarRocks 深度发现：
- cluster / warehouse / FE / BE
- 结构化解析 SHOW FRONTENDS / SHOW BACKENDS / SHOW WAREHOUSES
- 采集参数到 sr_param_details
- 优先实时查询，失败时回退到周报 CSV 事实
"""

from __future__ import print_function

import argparse
import csv
import datetime as dt
import json
import os
import re
import subprocess
import sys
from typing import Any, Dict, List, Optional, Tuple

import pymysql

from asset_domain_v2 import (
    cleanup_stale_sr_nodes,
    cleanup_stale_sr_params,
    get_db,
    make_asset_id,
    upsert_sr_node_detail,
    upsert_sr_param_detail,
    write_sync_log,
)
from discover_aliyun_assets_v2_impl import SR_WAREHOUSE_PURPOSE, _asset, _tag_health, persist_assets


WEEKLY_CSV = os.environ.get("AIOPS_STARROCKS_FALLBACK_CSV", "")
DEFAULT_ENV_JSON = os.environ.get("AIOPS_SYNC_ENV_JSON", "")


def _sync_region(default: str = "us-west-1") -> str:
    return (os.environ.get("AIOPS_SYNC_REGION") or "").strip() or default


def _sync_env(region: str) -> str:
    default = region
    return (os.environ.get("AIOPS_SYNC_ENV") or "").strip() or default


def _sync_account_name(default: str = "default") -> str:
    return (os.environ.get("AIOPS_SYNC_ACCOUNT_NAME") or "").strip() or default


def _sync_env_json(default: str = DEFAULT_ENV_JSON) -> str:
    return (os.environ.get("AIOPS_SYNC_ENV_JSON") or "").strip() or default

FE_COLUMNS = [
    "Name", "Host", "EditLogPort", "HttpPort", "QueryPort", "RpcPort",
    "Role", "IsMaster", "ClusterId", "Join", "Alive",
    "ReplayedJournalId", "LastHeartbeat", "IsHelper", "ErrMsg", "StartTime", "Version",
]

BE_COLUMNS = [
    "BackendId", "Host", "HeartbeatPort", "BePort", "HttpPort", "BrpcPort",
    "StarletPort", "LastStartTime", "LastHeartbeat", "Alive",
    "SystemDecommissioned", "TabletNum", "DataUsedCapacity", "AvailCapacity",
    "TotalCapacity", "UsedPct", "MaxDiskUsedPct", "ErrMsg", "Version", "Status",
    "DataTotalCapacity", "DataUsedPct", "CpuCores", "MemUsedPct",
    "WarehouseId", "NumRunningQueries", "MemLimitBytes", "MemUsedBytes", "CpuUsedPermille",
]

WH_COLUMNS = [
    "Id", "Name", "State", "NodeCount", "CurrentClusterCount", "MaxClusterCount",
    "RunningSQL", "QueuedSQL", "CreatedOn", "ResumedOn", "UpdatedOn",
]


def _load_json(path: str) -> Dict[str, Any]:
    if not path or not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _run(argv: List[str], timeout: int = 30) -> Tuple[bool, str, str]:
    try:
        cp = subprocess.run(argv, check=False, universal_newlines=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        return cp.returncode == 0, cp.stdout or "", cp.stderr or ""
    except Exception as e:
        return False, "", str(e)


def _parse_tab_rows(output: str, columns: List[str]) -> List[Dict[str, str]]:
    """Parse tab-separated output (mysql -N) into list of dicts using predefined column names."""
    rows = []
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        cols = [x.strip() for x in line.split("\t")]
        row = {}
        for i, name in enumerate(columns):
            row[name] = cols[i] if i < len(cols) else ""
        rows.append(row)
    return rows


def _safe_int(v: Any) -> Optional[int]:
    if v is None or v == "" or v == "\\N" or v == "NULL":
        return None
    try:
        return int(float(str(v).replace(",", "")))
    except (ValueError, TypeError):
        return None


def _safe_float(v: Any) -> Optional[float]:
    if v is None or v == "" or v == "\\N" or v == "NULL":
        return None
    try:
        return float(str(v).replace(",", "").replace("%", ""))
    except (ValueError, TypeError):
        return None


def _parse_capacity_gb(s: str) -> Optional[int]:
    """Parse strings like '1.234 TB' or '500.00 GB' to GB int."""
    if not s:
        return None
    s = s.strip()
    m = re.match(r"([0-9.]+)\s*(TB|GB|MB|KB|B)", s, re.IGNORECASE)
    if not m:
        return _safe_int(s)
    val = float(m.group(1))
    unit = m.group(2).upper()
    multipliers = {"TB": 1024, "GB": 1, "MB": 1.0 / 1024, "KB": 1.0 / (1024 * 1024), "B": 0}
    return int(val * multipliers.get(unit, 1))


def _is_alive(v: str) -> Optional[bool]:
    if not v:
        return None
    return v.strip().lower() in ("true", "1", "yes")


def parse_weekly_csv(path: str) -> Dict[str, Any]:
    data = {
        "cluster_id": "",
        "fe_nodes": [],
        "fe_cpu": {},
        "warehouses": {},
    }
    if not os.path.exists(path):
        return data
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) < 4:
                continue
            category = row[0].strip()
            item = row[1].strip()
            detail = row[2].strip()
            value = row[3].strip()
            if category == "资源开通情况" and item == "StarRocks" and detail == "集群 ID":
                data["cluster_id"] = value
            elif category == "资源开通情况" and item == "StarRocks" and detail == "FE pod 数量":
                m = re.search(r"（(.+?)）", value)
                if m:
                    raw_nodes = [x.strip() for x in m.group(1).split("/") if x.strip()]
                    fe_nodes = []
                    prefix = ""
                    for idx, node in enumerate(raw_nodes):
                        if idx == 0 and "-" in node:
                            prefix = node.rsplit("-", 1)[0]
                            fe_nodes.append(node)
                            continue
                        if prefix and node.isdigit():
                            fe_nodes.append("%s-%s" % (prefix, node))
                        else:
                            fe_nodes.append(node)
                    data["fe_nodes"] = fe_nodes
            elif category == "资源利用率分析" and item == "FE CPU（汇总）":
                for name, pct in re.findall(r"(frontend-\d+)\s*峰值\s*([0-9.]+)%", value):
                    data["fe_cpu"][name] = float(pct)
            elif category == "资源利用率分析" and item not in ("Warehouse", "FE CPU（汇总）"):
                wh = item
                data["warehouses"][wh] = {
                    "fe_cpu_peak_pct": value,
                    "disk_io_peak_pct": row[4].strip() if len(row) > 4 else "",
                    "disk_io_avg_pct": row[5].strip() if len(row) > 5 else "",
                    "risk": row[6].strip() if len(row) > 6 else "",
                }
    return data


def _get_sr_connection() -> Tuple[str, str, str, str]:
    """Return (fe_host, port, user, pwd) or empty strings if not configured."""
    cfg = _load_json(_sync_env_json(DEFAULT_ENV_JSON)).get("starrocks", {})
    fe_host = str(cfg.get("fe_host") or "").strip()
    port = str(cfg.get("mysql_port") or 9030)
    user = os.environ.get("STARROCKS_USER", "").strip()
    pwd = os.environ.get("STARROCKS_PASSWORD", "").strip()
    return fe_host, port, user, pwd


def _sr_query(fe_host: str, port: str, user: str, pwd: str, sql: str, timeout: int = 20) -> Tuple[bool, str]:
    if not fe_host or fe_host.startswith("<") or not user or not pwd:
        return False, ""
    conn = None
    try:
        conn = pymysql.connect(
            host=fe_host,
            port=int(port or 9030),
            user=user,
            password=pwd,
            charset="utf8mb4",
            connect_timeout=timeout,
            read_timeout=timeout,
            write_timeout=timeout,
        )
        with conn.cursor() as cur:
            cur.execute(sql)
            rows = cur.fetchall() or []
        lines = []
        for row in rows:
            cols = ["" if value is None else str(value) for value in row]
            lines.append("\t".join(cols))
        return True, "\n".join(lines)
    except Exception:
        return False, ""
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def try_query_sr_nodes(fe_host: str, port: str, user: str, pwd: str) -> Tuple[
    List[Dict[str, str]], List[Dict[str, str]], List[Dict[str, str]]
]:
    frontends: List[Dict[str, str]] = []
    backends: List[Dict[str, str]] = []
    warehouses: List[Dict[str, str]] = []

    ok, out = _sr_query(fe_host, port, user, pwd, "SHOW FRONTENDS")
    if ok and out.strip():
        frontends = _parse_tab_rows(out, FE_COLUMNS)

    ok, out = _sr_query(fe_host, port, user, pwd, "SHOW BACKENDS")
    if ok and out.strip():
        backends = _parse_tab_rows(out, BE_COLUMNS)

    ok, out = _sr_query(fe_host, port, user, pwd, "SHOW WAREHOUSES")
    if ok and out.strip():
        warehouses = _parse_tab_rows(out, WH_COLUMNS)

    return frontends, backends, warehouses


def try_query_sr_variables(fe_host: str, port: str, user: str, pwd: str) -> List[Dict[str, str]]:
    """SHOW VARIABLES returns Variable_name / Value pairs."""
    ok, out = _sr_query(fe_host, port, user, pwd, "SHOW VARIABLES", timeout=15)
    if not ok or not out.strip():
        return []
    rows = []
    for line in out.splitlines():
        parts = line.split("\t", 1)
        if len(parts) == 2:
            rows.append({"Variable_name": parts[0].strip(), "Value": parts[1].strip()})
    return rows


def build_assets(region: str = "us-west-1", env: str = "production") -> Tuple[
    List[Dict[str, Any]],
    List[Dict[str, str]],
    List[Dict[str, str]],
    List[Dict[str, str]],
    List[Dict[str, str]],
]:
    """Return (assets, frontends_live, backends_live, warehouses_live, variables_live)."""
    facts = parse_weekly_csv(WEEKLY_CSV)
    account_name = _sync_account_name("default")
    fe_host, port, user, pwd = _get_sr_connection()
    frontends_live, backends_live, warehouses_live = try_query_sr_nodes(fe_host, port, user, pwd)
    variables_live = try_query_sr_variables(fe_host, port, user, pwd)

    cluster_id = facts["cluster_id"] or "c-aadf14269a2bb8da"
    cluster_asset_id = make_asset_id("aliyun", "StarRocks_Cluster", region, cluster_id)
    assets: List[Dict[str, Any]] = []

    assets.append(
        _asset(
            "StarRocks_Cluster",
            cluster_id,
            "starrocks-%s" % cluster_id,
            region,
            env,
            "Running",
            "ok",
            purpose="EMR Serverless StarRocks 集群",
            owner_team="bigdata-platform-sre",
            criticality="P1",
            spec_json={"display": "EMR Serverless"},
            raw_json={"source": "weekly_csv_or_api", "cluster_id": cluster_id},
            account_name=account_name,
        )
    )

    # -- FE nodes --
    fe_names = facts["fe_nodes"]
    if not fe_names and frontends_live:
        fe_names = [fe.get("Name") or ("frontend-%d" % idx) for idx, fe in enumerate(frontends_live)]

    fe_live_map: Dict[str, Dict[str, str]] = {}
    for fe in frontends_live:
        fe_live_map[fe.get("Name", "")] = fe

    for name in fe_names:
        cpu_pct = facts["fe_cpu"].get(name)
        live = fe_live_map.get(name, {})
        alive = _is_alive(live.get("Alive", ""))
        health = "warn" if (cpu_pct and cpu_pct >= 80) or alive is False else "ok"
        fe_host_ip = live.get("Host", "")
        fe_version = live.get("Version", "")
        fe_role = live.get("Role", "FOLLOWER")
        query_port = _safe_int(live.get("QueryPort"))

        spec_parts = ["FE Pod"]
        if fe_role:
            spec_parts.append(fe_role)
        if fe_version:
            spec_parts.append("v" + fe_version)

        assets.append(
            _asset(
                "StarRocks_FE_Node",
                name,
                name,
                region,
                env,
                "Running" if alive is not False else "Down",
                health,
                parent_resource_id=cluster_id,
                purpose="StarRocks FE 节点",
                owner_team="bigdata-platform-sre",
                criticality="P1",
                spec_json={"display": " | ".join(spec_parts), "role": fe_role, "version": fe_version},
                capacity_json={"cpu_peak_pct": cpu_pct},
                network_json={"primary_endpoint": fe_host_ip, "query_port": query_port},
                raw_json={"source": "show_frontends" if live else "weekly_csv", "frontend": name, "live": live},
                relations=[("member_of_cluster", cluster_asset_id)],
                account_name=account_name,
            )
        )

    # -- BE nodes --
    for idx, be in enumerate(backends_live):
        be_host = be.get("Host", "")
        be_id_raw = be.get("BackendId", "be-%02d" % idx)
        be_id = "be-%s" % be_id_raw
        alive = _is_alive(be.get("Alive", ""))
        version = be.get("Version", "")
        cpu_cores = _safe_int(be.get("CpuCores"))
        mem_limit = _safe_int(be.get("MemLimitBytes"))
        mem_gb = round(mem_limit / (1024**3), 1) if mem_limit else None
        total_cap = _parse_capacity_gb(be.get("TotalCapacity", ""))
        data_used = _parse_capacity_gb(be.get("DataUsedCapacity", ""))
        wh_id_raw = be.get("WarehouseId", "")

        health = "ok"
        if alive is False:
            health = "error"
        elif _safe_float(be.get("MaxDiskUsedPct", "")) and _safe_float(be.get("MaxDiskUsedPct", "")) > 85:
            health = "warn"

        spec_parts = ["BE Node"]
        if cpu_cores:
            spec_parts.append("%dC" % cpu_cores)
        if mem_gb:
            spec_parts.append("%.0fGB" % mem_gb)
        if version:
            spec_parts.append("v" + version)

        wh_asset_id = None
        relations = [("member_of_cluster", cluster_asset_id)]
        if wh_id_raw:
            for wh_live in warehouses_live:
                if wh_live.get("Id") == wh_id_raw:
                    wh_name = wh_live.get("Name", "")
                    if wh_name:
                        wh_asset_id = make_asset_id("aliyun", "StarRocks_Warehouse", region, wh_name)
                        relations.append(("node_of_compute_group", wh_asset_id))
                    break

        assets.append(
            _asset(
                "StarRocks_BE_Node",
                be_id,
                be_id,
                region,
                env,
                "Running" if alive is not False else "Down",
                health,
                parent_resource_id=cluster_id,
                purpose="StarRocks BE 节点",
                owner_team="bigdata-platform-sre",
                criticality="P1",
                spec_json={
                    "display": " | ".join(spec_parts),
                    "version": version,
                    "cpu_cores": cpu_cores,
                    "memory_gb": mem_gb,
                },
                capacity_json={
                    "total_disk_gb": total_cap,
                    "data_used_gb": data_used,
                    "disk_used_pct": be.get("UsedPct", ""),
                    "max_disk_used_pct": be.get("MaxDiskUsedPct", ""),
                },
                network_json={"primary_endpoint": be_host, "be_port": _safe_int(be.get("BePort"))},
                raw_json={"source": "show_backends", "backend": be, "_warehouse_asset_id": wh_asset_id},
                relations=relations,
                account_name=account_name,
            )
        )

    # -- Warehouses --
    wh_live_map: Dict[str, Dict[str, str]] = {}
    for wh in warehouses_live:
        wh_live_map[wh.get("Name", "")] = wh

    wh_names = sorted(set(list(SR_WAREHOUSE_PURPOSE.keys()) + list(facts["warehouses"].keys()) + list(wh_live_map.keys())))
    for wh in wh_names:
        if not wh:
            continue
        fact = facts["warehouses"].get(wh, {})
        live = wh_live_map.get(wh, {})
        disk_peak = str(fact.get("disk_io_peak_pct") or "").replace("%", "")
        disk_avg = str(fact.get("disk_io_avg_pct") or "").replace("%", "")
        risk = fact.get("risk") or ""
        health = "warn" if ("高" in risk or "瓶颈" in risk or "超限" in risk) else "ok"

        node_count = _safe_int(live.get("NodeCount"))
        state = live.get("State", "Running")

        assets.append(
            _asset(
                "StarRocks_Warehouse",
                wh,
                wh,
                region,
                env,
                state,
                health,
                parent_resource_id=cluster_id,
                purpose=SR_WAREHOUSE_PURPOSE.get(wh, ""),
                owner_team="bigdata-platform-sre",
                service_name="starrocks",
                criticality="P1" if wh in ("default_warehouse", "us_bi_etl_warehouse") else "P2",
                spec_json={
                    "display": "EMR Serverless Warehouse",
                    "node_count": node_count,
                },
                capacity_json={"disk_io_peak_pct": disk_peak, "disk_io_avg_pct": disk_avg},
                raw_json={
                    "source": "show_warehouses" if live else "weekly_csv",
                    "warehouse": wh,
                    "risk": risk,
                    "live": live,
                },
                relations=[("warehouse_of_cluster", cluster_asset_id)],
                account_name=account_name,
            )
        )

    return assets, frontends_live, backends_live, warehouses_live, variables_live


def persist_sr_node_details(
    conn,
    frontends: List[Dict[str, str]],
    backends: List[Dict[str, str]],
    warehouses_live: List[Dict[str, str]],
    cluster_asset_id: str,
    region: str,
) -> int:
    """Write structured FE/BE details to sr_node_details. Returns count."""
    seen_node_ids: List[str] = []
    count = 0

    for fe in frontends:
        name = fe.get("Name", "")
        if not name:
            continue
        node_asset_id = make_asset_id("aliyun", "StarRocks_FE_Node", region, name)
        seen_node_ids.append(node_asset_id)
        upsert_sr_node_detail(
            conn,
            node_asset_id,
            cluster_asset_id,
            None,
            "FE",
            host_or_ip=fe.get("Host"),
            port=_safe_int(fe.get("QueryPort")),
            version=fe.get("Version") or None,
            spec_display="FE %s" % (fe.get("Role") or "FOLLOWER"),
            alive=_is_alive(fe.get("Alive", "")),
            node_status="Running" if _is_alive(fe.get("Alive", "")) else "Down",
            description="IsMaster=%s Role=%s" % (fe.get("IsMaster", ""), fe.get("Role", "")),
        )
        count += 1

    wh_id_to_name: Dict[str, str] = {}
    for wh in warehouses_live:
        wh_id_to_name[wh.get("Id", "")] = wh.get("Name", "")

    for be in backends:
        be_id_raw = be.get("BackendId", "")
        if not be_id_raw:
            continue
        be_id = "be-%s" % be_id_raw
        node_asset_id = make_asset_id("aliyun", "StarRocks_BE_Node", region, be_id)
        seen_node_ids.append(node_asset_id)

        wh_name = wh_id_to_name.get(be.get("WarehouseId", ""), "")
        wh_asset_id = make_asset_id("aliyun", "StarRocks_Warehouse", region, wh_name) if wh_name else None

        cpu_cores = _safe_int(be.get("CpuCores"))
        mem_limit = _safe_int(be.get("MemLimitBytes"))
        mem_gb = round(mem_limit / (1024**3), 1) if mem_limit else None
        total_cap = _parse_capacity_gb(be.get("TotalCapacity", ""))

        spec_parts = ["BE"]
        if cpu_cores:
            spec_parts.append("%dC" % cpu_cores)
        if mem_gb:
            spec_parts.append("%.0fGB" % mem_gb)

        upsert_sr_node_detail(
            conn,
            node_asset_id,
            cluster_asset_id,
            wh_asset_id,
            "BE",
            host_or_ip=be.get("Host"),
            port=_safe_int(be.get("BePort")),
            version=be.get("Version") or None,
            spec_display=" | ".join(spec_parts),
            cpu_cores=cpu_cores,
            memory_gb=mem_gb,
            disk_size_gb=total_cap,
            alive=_is_alive(be.get("Alive", "")),
            node_status="Running" if _is_alive(be.get("Alive", "")) else "Down",
            description="TabletNum=%s UsedPct=%s" % (be.get("TabletNum", ""), be.get("UsedPct", "")),
        )
        count += 1

    cleanup_stale_sr_nodes(conn, cluster_asset_id, seen_node_ids)
    return count


def persist_sr_params(
    conn,
    variables: List[Dict[str, str]],
    cluster_asset_id: str,
    cluster_name: str,
) -> int:
    seen_keys: List[str] = []
    count = 0
    for var in variables:
        vname = var.get("Variable_name", "").strip()
        vval = var.get("Value", "").strip()
        if not vname:
            continue
        param_key = "%s:%s" % (cluster_asset_id, vname)
        seen_keys.append(param_key)
        upsert_sr_param_detail(
            conn,
            scope_type="cluster",
            scope_asset_id=cluster_asset_id,
            scope_name=cluster_name,
            param_name=vname,
            current_value=vval,
            default_value=None,
            param_source="SHOW VARIABLES",
        )
        count += 1
    cleanup_stale_sr_params(conn, cluster_asset_id, seen_keys)
    return count


def main() -> int:
    ap = argparse.ArgumentParser(description="Deep discover StarRocks assets into v2 asset domain.")
    ap.add_argument("--region", default=_sync_region("us-west-1"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    started = dt.datetime.now()
    region = str(args.region or _sync_region("us-west-1")).strip() or "us-west-1"
    env = _sync_env(region)
    assets, frontends_live, backends_live, warehouses_live, variables_live = build_assets(region=region, env=env)
    print("[info] starrocks_deep assets=%d fe=%d be=%d wh=%d vars=%d" % (
        len(assets), len(frontends_live), len(backends_live), len(warehouses_live), len(variables_live),
    ))

    if args.dry_run:
        for asset in assets:
            print("[dry-run] %s | %s | %s" % (asset["resource_type"], asset["resource_id"], asset["resource_name"]))
        return 0

    conn = get_db()
    try:
        upserted, errors, _ = persist_assets(conn, assets, collector_name="discover_starrocks_deep", dry_run=False)

        cluster_id = "c-aadf14269a2bb8da"
        cluster_asset_id = make_asset_id("aliyun", "StarRocks_Cluster", region, cluster_id)

        node_count = 0
        param_count = 0
        if frontends_live or backends_live:
            node_count = persist_sr_node_details(conn, frontends_live, backends_live, warehouses_live, cluster_asset_id, region)
            print("[info] sr_node_details persisted=%d" % node_count)

        if variables_live:
            param_count = persist_sr_params(conn, variables_live, cluster_asset_id, "starrocks-%s" % cluster_id)
            print("[info] sr_param_details persisted=%d" % param_count)

        detail = "nodes=%d params=%d" % (node_count, param_count)
        write_sync_log(conn, "discover_starrocks_deep", region, env,
                       "ok" if errors == 0 else "partial",
                       len(assets), upserted, errors, detail, started)
        conn.commit()
        print("[done] starrocks_deep upserted=%d errors=%d nodes=%d params=%d" % (upserted, errors, node_count, param_count))
        return 0 if errors == 0 else 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
