#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
discover_aliyun_assets_v2_impl.py
全量基础资产发现：
- 分页扫描阿里云基础资源
- 双写到 legacy aliyun_assets 与 v2 域模型
- 自动记录新增/恢复/missing/状态变化/配置变化
"""

from __future__ import print_function

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import time
from collections import defaultdict
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from asset_domain_v2 import (
    ensure_metadata_curated,
    get_db,
    make_asset_id,
    mark_missing_assets,
    record_lifecycle_event,
    replace_active_relations,
    upsert_asset_master,
    upsert_config_snapshot,
    upsert_legacy_projection,
    upsert_observation,
    write_sync_log,
)


REGIONS = {
    "us-west-1": {
        "env": "production",
        "profile_default": "default",
        "profile_dataworks": "default",
        "account_name": "default",
    },
    "cn-shenzhen": {
        "env": "development",
        "profile_default": "default",
        "profile_dataworks": "default",
        "account_name": "default",
    },
}


def _sync_region_keys() -> List[str]:
    return sorted(REGIONS.keys())


def _region_env(region: str, fallback: str = "") -> str:
    env_map = {"us-west-1": "production", "cn-shenzhen": "development"}
    return env_map.get(region, fallback or region)


def region_cfg(region: str) -> Dict[str, Any]:
    base = dict(REGIONS.get(region) or {})
    if not base:
        base = {
            "env": _region_env(region, region),
            "profile_default": "default",
            "profile_dataworks": "default",
            "account_name": "default",
        }
    profile_default = os.environ.get("AIOPS_SYNC_PROFILE_DEFAULT", "").strip()
    profile_dataworks = os.environ.get("AIOPS_SYNC_PROFILE_DATAWORKS", "").strip()
    account_name = os.environ.get("AIOPS_SYNC_ACCOUNT_NAME", "").strip()
    env_name = os.environ.get("AIOPS_SYNC_ENV", "").strip()
    if profile_default:
        base["profile_default"] = profile_default
    if profile_dataworks:
        base["profile_dataworks"] = profile_dataworks
    if account_name:
        base["account_name"] = account_name
    if env_name:
        base["env"] = env_name
    return base

SR_WAREHOUSE_PURPOSE = {
    "default_warehouse": "默认计算组",
}


def _safe_str(v: Any, limit: int = 255) -> str:
    if v is None:
        return ""
    return str(v).strip()[:limit]


def _run(argv: List[str], timeout: int = 60) -> Tuple[bool, str, str]:
    try:
        cp = subprocess.run(
            argv,
            check=False,
            universal_newlines=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
        return cp.returncode == 0, (cp.stdout or "")[:400000], (cp.stderr or "")[:4000]
    except subprocess.TimeoutExpired:
        return False, "", "[timeout]"
    except Exception as e:
        return False, "", str(e)


def aliyun_json(profile: str, args: List[str], timeout: int = 60) -> Optional[Dict[str, Any]]:
    ok, out, err = _run(["aliyun", "--profile", profile] + args, timeout=timeout)
    if not ok:
        print("[warn] aliyun %s failed: %s" % (" ".join(args[:4]), err[:200]), file=sys.stderr)
        return None
    try:
        return json.loads(out)
    except Exception:
        return None


def _tag_health(status: str) -> str:
    s = (status or "").lower()
    if s in ("running", "available", "active", "normal", "online", "enabled", "inuse", "in_use"):
        return "ok"
    if s in ("stopped", "stopping", "error", "failed", "unavailable"):
        return "error"
    if s in ("starting", "pending", "creating", "warning"):
        return "warn"
    return "unknown"


def _page_collect(
    fetcher: Callable[[int], Optional[Dict[str, Any]]],
    extractor: Callable[[Dict[str, Any]], List[Dict[str, Any]]],
    page_size: int = 50,
    max_pages: int = 20,
) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for page_no in range(1, max_pages + 1):
        j = fetcher(page_no)
        if not j:
            break
        arr = extractor(j) or []
        items.extend(arr)
        if len(arr) < page_size:
            break
    return items


def _asset(
    resource_type: str,
    resource_id: str,
    resource_name: str,
    region: Optional[str],
    env: Optional[str],
    status: str,
    health: str,
    *,
    zone_id: Optional[str] = None,
    resource_group: Optional[str] = None,
    parent_resource_id: Optional[str] = None,
    purpose: Optional[str] = None,
    owner_team: Optional[str] = None,
    service_name: Optional[str] = None,
    system_name: Optional[str] = None,
    criticality: Optional[str] = None,
    manual_tags: Optional[str] = None,
    alert_24h: int = 0,
    summary: Optional[str] = None,
    spec_json: Optional[Dict[str, Any]] = None,
    capacity_json: Optional[Dict[str, Any]] = None,
    network_json: Optional[Dict[str, Any]] = None,
    labels_json: Optional[Dict[str, Any]] = None,
    raw_json: Optional[Dict[str, Any]] = None,
    relations: Optional[List[Tuple[str, str]]] = None,
    account_name: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "cloud_vendor": "aliyun",
        "account_name": account_name,
        "resource_type": resource_type,
        "resource_id": resource_id,
        "resource_name": resource_name,
        "region": region,
        "zone_id": zone_id,
        "env": env,
        "resource_group": resource_group,
        "parent_resource_id": parent_resource_id,
        "source_of_truth": "aliyun_cli",
        "status": status or "Unknown",
        "health": health or "unknown",
        "alert_24h": int(alert_24h or 0),
        "summary": summary,
        "purpose": purpose,
        "owner_team": owner_team,
        "service_name": service_name,
        "system_name": system_name,
        "criticality": criticality,
        "manual_tags": manual_tags,
        "spec_json": spec_json or {},
        "capacity_json": capacity_json or {},
        "network_json": network_json or {},
        "labels_json": labels_json or {},
        "raw_json": raw_json or {},
        "relations": relations or [],
        "legacy_instance_id": "%s:%s:%s:%s" % ("aliyun", resource_type, region or "global", resource_id),
    }


def _guess_related_asset_id(region: str, resource_id: str) -> Optional[str]:
    if not resource_id:
        return None
    if resource_id.startswith("i-"):
        return make_asset_id("aliyun", "ECS", region, resource_id)
    if resource_id.startswith("ngw-"):
        return make_asset_id("aliyun", "NAT", region, resource_id)
    if resource_id.startswith("lb-"):
        return make_asset_id("aliyun", "SLB", region, resource_id)
    if resource_id.startswith("vpc-"):
        return make_asset_id("aliyun", "VPC", region, resource_id)
    return None


def discover_vpc(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    rows = _page_collect(
        lambda page_no: aliyun_json(profile, ["vpc", "DescribeVpcs", "--RegionId", region, "--PageSize", "50", "--PageNumber", str(page_no)]),
        lambda j: ((j.get("Vpcs") or {}).get("Vpc") or []),
    )
    assets = []
    for vpc in rows:
        cidr = _safe_str(vpc.get("CidrBlock"))
        assets.append(
            _asset(
                "VPC",
                _safe_str(vpc.get("VpcId")),
                _safe_str(vpc.get("VpcName") or vpc.get("VpcId")),
                region,
                env,
                _safe_str(vpc.get("Status", "Available")),
                _tag_health(vpc.get("Status", "Available")),
                purpose="云网络 VPC",
                owner_team="bigdata-platform-sre",
                spec_json={"display": cidr},
                network_json={"cidr": cidr, "primary_endpoint": cidr},
                raw_json=vpc,
                account_name=account_name,
            )
        )
    return assets


def discover_vswitches(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    rows = _page_collect(
        lambda page_no: aliyun_json(profile, ["vpc", "DescribeVSwitches", "--RegionId", region, "--PageSize", "50", "--PageNumber", str(page_no)]),
        lambda j: ((j.get("VSwitches") or {}).get("VSwitch") or []),
    )
    assets = []
    for vs in rows:
        vswitch_id = _safe_str(vs.get("VSwitchId"))
        vpc_id = _safe_str(vs.get("VpcId"))
        assets.append(
            _asset(
                "vSwitch",
                vswitch_id,
                _safe_str(vs.get("VSwitchName") or vswitch_id),
                region,
                env,
                _safe_str(vs.get("Status", "Available")),
                _tag_health(vs.get("Status", "Available")),
                zone_id=_safe_str(vs.get("ZoneId")),
                parent_resource_id=vpc_id or None,
                purpose="子网 / 交换机",
                owner_team="bigdata-platform-sre",
                spec_json={"display": _safe_str(vs.get("CidrBlock"))},
                network_json={"cidr": _safe_str(vs.get("CidrBlock")), "primary_endpoint": _safe_str(vs.get("CidrBlock"))},
                raw_json=vs,
                relations=[("belongs_to_vpc", make_asset_id("aliyun", "VPC", region, vpc_id))] if vpc_id else [],
                account_name=account_name,
            )
        )
    return assets


def discover_nat(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    rows = _page_collect(
        lambda page_no: aliyun_json(profile, ["vpc", "DescribeNatGateways", "--RegionId", region, "--PageSize", "50", "--PageNumber", str(page_no)]),
        lambda j: ((j.get("NatGateways") or {}).get("NatGateway") or []),
    )
    assets = []
    for nat in rows:
        nat_id = _safe_str(nat.get("NatGatewayId"))
        ip_list = [str(x.get("IpAddress", "")) for x in ((nat.get("IpLists") or {}).get("IpList") or []) if x.get("IpAddress")]
        vpc_id = _safe_str(nat.get("VpcId"))
        assets.append(
            _asset(
                "NAT",
                nat_id,
                _safe_str(nat.get("Name") or nat_id),
                region,
                env,
                _safe_str(nat.get("Status", "Available")),
                _tag_health(nat.get("Status", "Available")),
                parent_resource_id=vpc_id or None,
                purpose="公网出口 NAT 网关",
                owner_team="bigdata-platform-sre",
                spec_json={"display": _safe_str(nat.get("Spec"))},
                capacity_json={"bandwidth": nat.get("BandwidthPackageCount")},
                network_json={"primary_endpoint": ", ".join(ip_list), "public_ips": ip_list},
                raw_json=nat,
                relations=[("belongs_to_vpc", make_asset_id("aliyun", "VPC", region, vpc_id))] if vpc_id else [],
                account_name=account_name,
            )
        )
    return assets


def discover_eip(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    rows = _page_collect(
        lambda page_no: aliyun_json(profile, ["vpc", "DescribeEipAddresses", "--RegionId", region, "--PageSize", "50", "--PageNumber", str(page_no)]),
        lambda j: ((j.get("EipAddresses") or {}).get("EipAddress") or []),
    )
    assets = []
    for eip in rows:
        allocation_id = _safe_str(eip.get("AllocationId"))
        related = _guess_related_asset_id(region, _safe_str(eip.get("InstanceId")))
        relations = [("attached_to_resource", related)] if related else []
        assets.append(
            _asset(
                "EIP",
                allocation_id,
                _safe_str(eip.get("Name") or eip.get("IpAddress") or allocation_id),
                region,
                env,
                _safe_str(eip.get("Status", "Available")),
                _tag_health(_safe_str(eip.get("Status", "Available"))),
                purpose="公网 IP",
                owner_team="bigdata-platform-sre",
                spec_json={"display": "%s Mbps" % _safe_str(eip.get("Bandwidth"))},
                capacity_json={"bandwidth_mbps": eip.get("Bandwidth")},
                network_json={"primary_endpoint": _safe_str(eip.get("IpAddress"))},
                raw_json=eip,
                relations=relations,
                account_name=account_name,
            )
        )
    return assets


def discover_vbr(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    rows = _page_collect(
        lambda page_no: aliyun_json(profile, ["vpc", "DescribePhysicalConnections", "--RegionId", region, "--PageSize", "50", "--PageNumber", str(page_no)]),
        lambda j: ((j.get("PhysicalConnectionSet") or {}).get("PhysicalConnectionType") or []),
    )
    assets = []
    for conn in rows:
        pc_id = _safe_str(conn.get("PhysicalConnectionId"))
        bandwidth = _safe_str(conn.get("Bandwidth"))
        assets.append(
            _asset(
                "VBR",
                pc_id,
                _safe_str(conn.get("Name") or pc_id),
                region,
                env,
                _safe_str(conn.get("Status", "Enabled")),
                _tag_health(_safe_str(conn.get("Status", "Enabled"))),
                purpose="IDC 专线 / 物理连接",
                owner_team="bigdata-platform-sre",
                criticality="P1",
                spec_json={"display": ("%s Mbps" % bandwidth) if bandwidth else ""},
                capacity_json={"bandwidth_mbps": conn.get("Bandwidth")},
                raw_json=conn,
                account_name=account_name,
            )
        )
    return assets


def discover_ecs(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    rows = _page_collect(
        lambda page_no: aliyun_json(profile, ["ecs", "DescribeInstances", "--RegionId", region, "--PageSize", "100", "--PageNumber", str(page_no)]),
        lambda j: ((j.get("Instances") or {}).get("Instance") or []),
        page_size=100,
    )
    assets = []
    for inst in rows:
        inst_id = _safe_str(inst.get("InstanceId"))
        private_ips = inst.get("VpcAttributes", {}).get("PrivateIpAddress", {}).get("IpAddress") or []
        public_ips = inst.get("PublicIpAddress", {}).get("IpAddress") or []
        vpc_id = _safe_str(inst.get("VpcAttributes", {}).get("VpcId"))
        vswitch_id = _safe_str(inst.get("VpcAttributes", {}).get("VSwitchId"))
        all_ips = list(private_ips) + list(public_ips)
        relations: List[Tuple[str, str]] = []
        if vpc_id:
            relations.append(("belongs_to_vpc", make_asset_id("aliyun", "VPC", region, vpc_id)))
        if vswitch_id:
            relations.append(("belongs_to_vswitch", make_asset_id("aliyun", "vSwitch", region, vswitch_id)))
        assets.append(
            _asset(
                "ECS",
                inst_id,
                _safe_str(inst.get("InstanceName") or inst_id),
                region,
                env,
                _safe_str(inst.get("Status", "Unknown")),
                _tag_health(_safe_str(inst.get("Status", "Unknown"))),
                zone_id=_safe_str(inst.get("ZoneId")),
                parent_resource_id=vpc_id or None,
                purpose="云主机",
                owner_team="bigdata-platform-sre",
                spec_json={"display": _safe_str(inst.get("InstanceType"))},
                capacity_json={
                    "cpu": inst.get("Cpu"),
                    "memory_mb": inst.get("Memory"),
                },
                network_json={"primary_endpoint": ", ".join(all_ips), "private_ips": private_ips, "public_ips": public_ips},
                raw_json=inst,
                relations=relations,
                account_name=account_name,
            )
        )
    return assets


def discover_security_groups(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    rows = _page_collect(
        lambda page_no: aliyun_json(profile, ["ecs", "DescribeSecurityGroups", "--RegionId", region, "--PageSize", "100", "--PageNumber", str(page_no)]),
        lambda j: ((j.get("SecurityGroups") or {}).get("SecurityGroup") or []),
        page_size=100,
    )
    assets = []
    for sg in rows:
        sg_id = _safe_str(sg.get("SecurityGroupId"))
        vpc_id = _safe_str(sg.get("VpcId"))
        relations = [("belongs_to_vpc", make_asset_id("aliyun", "VPC", region, vpc_id))] if vpc_id else []
        assets.append(
            _asset(
                "SecurityGroup",
                sg_id,
                _safe_str(sg.get("SecurityGroupName") or sg_id),
                region,
                env,
                "Available",
                "ok",
                parent_resource_id=vpc_id or None,
                purpose="安全组",
                owner_team="bigdata-platform-sre",
                spec_json={"display": _safe_str(sg.get("Description"))},
                raw_json=sg,
                relations=relations,
                account_name=account_name,
            )
        )
    return assets


def discover_slb(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    rows = _page_collect(
        lambda page_no: aliyun_json(profile, ["slb", "DescribeLoadBalancers", "--RegionId", region, "--PageSize", "50", "--PageNumber", str(page_no)]),
        lambda j: ((j.get("LoadBalancers") or {}).get("LoadBalancer") or []),
    )
    assets = []
    for lb in rows:
        lb_id = _safe_str(lb.get("LoadBalancerId"))
        assets.append(
            _asset(
                "SLB",
                lb_id,
                _safe_str(lb.get("LoadBalancerName") or lb_id),
                region,
                env,
                _safe_str(lb.get("LoadBalancerStatus", "active")),
                _tag_health(_safe_str(lb.get("LoadBalancerStatus", "active"))),
                purpose="负载均衡 SLB",
                owner_team="bigdata-platform-sre",
                spec_json={"display": _safe_str(lb.get("AddressType"))},
                network_json={"primary_endpoint": _safe_str(lb.get("Address"))},
                raw_json=lb,
                account_name=account_name,
            )
        )
    return assets


def discover_nlb(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    j = aliyun_json(profile, ["nlb", "ListLoadBalancers", "--RegionId", region, "--MaxResults", "100"], timeout=30)
    rows = []
    if j:
        rows = (j.get("LoadBalancers") or []) or ((j.get("Data") or {}).get("LoadBalancers") or [])
    assets = []
    for lb in rows:
        lb_id = _safe_str(lb.get("LoadBalancerId"))
        assets.append(
            _asset(
                "NLB",
                lb_id,
                _safe_str(lb.get("LoadBalancerName") or lb_id),
                region,
                env,
                _safe_str(lb.get("LoadBalancerStatus", "active")),
                _tag_health(_safe_str(lb.get("LoadBalancerStatus", "active"))),
                purpose="负载均衡 NLB",
                owner_team="bigdata-platform-sre",
                spec_json={"display": _safe_str(lb.get("AddressType"))},
                network_json={"primary_endpoint": _safe_str(lb.get("DNSName") or lb.get("Address"))},
                raw_json=lb,
                account_name=account_name,
            )
        )
    return assets


def discover_rds(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    rows = _page_collect(
        lambda page_no: aliyun_json(profile, ["rds", "DescribeDBInstances", "--RegionId", region, "--PageSize", "100", "--PageNumber", str(page_no)]),
        lambda j: ((j.get("Items") or {}).get("DBInstance") or []),
        page_size=100,
    )
    assets = []
    for db in rows:
        db_id = _safe_str(db.get("DBInstanceId"))
        assets.append(
            _asset(
                "RDS",
                db_id,
                _safe_str(db.get("DBInstanceDescription") or db_id),
                region,
                env,
                _safe_str(db.get("DBInstanceStatus", "Running")),
                _tag_health(_safe_str(db.get("DBInstanceStatus", "Running"))),
                zone_id=_safe_str(db.get("ZoneId")),
                purpose="关系型数据库",
                owner_team="bigdata-platform-sre",
                spec_json={"display": _safe_str(db.get("DBInstanceClass"))},
                capacity_json={"storage_gb": db.get("DBInstanceStorage")},
                network_json={"primary_endpoint": _safe_str(db.get("ConnectionString"))},
                raw_json=db,
                account_name=account_name,
            )
        )
    return assets


def discover_cen(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    rows = _page_collect(
        lambda page_no: aliyun_json(profile, ["cen", "DescribeCens", "--PageSize", "50", "--PageNumber", str(page_no)]),
        lambda j: ((j.get("Cens") or {}).get("Cen") or []),
    )
    assets = []
    for cen in rows:
        cen_id = _safe_str(cen.get("CenId"))
        assets.append(
            _asset(
                "CEN",
                cen_id,
                _safe_str(cen.get("Name") or cen_id),
                region,
                env,
                _safe_str(cen.get("Status", "Active")),
                _tag_health(_safe_str(cen.get("Status", "Active"))),
                purpose="云企业网",
                owner_team="bigdata-platform-sre",
                spec_json={"display": _safe_str(cen.get("Description"))},
                raw_json=cen,
                account_name=account_name,
            )
        )
    return assets


def discover_route_tables(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    rows = _page_collect(
        lambda page_no: aliyun_json(profile, ["vpc", "DescribeRouteTableList", "--RegionId", region, "--PageSize", "50", "--PageNumber", str(page_no)]),
        lambda j: ((j.get("RouterTableList") or {}).get("RouterTableListType") or (j.get("RouterTableList") or [])),
    )
    assets = []
    for rt in rows:
        rt_id = _safe_str(rt.get("RouteTableId"))
        vpc_id = _safe_str(rt.get("VpcId"))
        relations = [("belongs_to_vpc", make_asset_id("aliyun", "VPC", region, vpc_id))] if vpc_id else []
        assets.append(
            _asset(
                "RouteTable",
                rt_id,
                _safe_str(rt.get("RouteTableName") or rt_id),
                region,
                env,
                _safe_str(rt.get("Status", "Available")),
                _tag_health(_safe_str(rt.get("Status", "Available"))),
                purpose="路由表",
                owner_team="bigdata-platform-sre",
                raw_json=rt,
                relations=relations,
                account_name=account_name,
            )
        )
    return assets


def discover_ram_roles(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    if region != "us-west-1":
        return []
    j = aliyun_json(profile, ["ram", "ListRoles", "--MaxItems", "100"], timeout=30)
    rows = []
    if j:
        rows = ((j.get("Roles") or {}).get("Role") or [])
    assets = []
    for role in rows:
        role_name = _safe_str(role.get("RoleName"))
        assets.append(
            _asset(
                "RAM_Role",
                role_name,
                role_name,
                "global",
                env,
                "Active",
                "ok",
                purpose="RAM 角色",
                owner_team="bigdata-platform-sre",
                raw_json=role,
                account_name=account_name,
            )
        )
    return assets


def discover_oss(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    assets = []
    ok, out, _ = _run(["aliyun", "--profile", profile, "oss", "ls", "--endpoint", "oss-%s.aliyuncs.com" % region], timeout=30)
    if not ok or not out.strip():
        ok, out, _ = _run(["aliyun", "--profile", profile, "oss", "ls"], timeout=30)
    if not ok:
        return assets
    for line in out.splitlines():
        line = line.strip()
        if not line or line.startswith("Creation") or line.startswith("Bucket Number"):
            continue
        parts = line.split()
        if not parts:
            continue
        bucket_url = parts[-1]
        if not bucket_url.startswith("oss://"):
            continue
        bucket_name = bucket_url[6:]
        assets.append(
            _asset(
                "OSS",
                bucket_name,
                bucket_name,
                region,
                env,
                "Available",
                "ok",
                purpose="对象存储 Bucket",
                owner_team="bigdata-platform-sre",
                network_json={"primary_endpoint": "%s.oss-%s.aliyuncs.com" % (bucket_name, region)},
                raw_json={"bucket": bucket_name, "bucket_url": bucket_url},
                account_name=account_name,
            )
        )
    return assets


def discover_emr_starrocks(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    assets = []
    j = aliyun_json(profile, ["emr", "--version", "2021-03-20", "ListClusters", "--RegionId", region], timeout=30)
    clusters = []
    if j:
        clusters = (j.get("Clusters") or []) or ((j.get("Data") or {}).get("Clusters") or [])
    for cluster in clusters:
        cluster_id = _safe_str(cluster.get("ClusterId") or cluster.get("Id"))
        cluster_name = _safe_str(cluster.get("ClusterName") or cluster.get("Name") or cluster_id)
        cluster_status = _safe_str(cluster.get("ClusterStatus") or cluster.get("Status") or "Running")
        cluster_type = _safe_str(cluster.get("ClusterType") or "EMR Serverless")
        assets.append(
            _asset(
                "StarRocks_Cluster",
                cluster_id,
                cluster_name,
                region,
                env,
                cluster_status,
                _tag_health(cluster_status),
                purpose="EMR Serverless StarRocks 集群",
                owner_team="bigdata-platform-sre",
                criticality="P1",
                spec_json={"display": cluster_type},
                raw_json=cluster,
                account_name=account_name,
            )
        )
    wh_list = [
        ("default_warehouse", "Running"),
    ]
    if region == "us-west-1":
        wh_list = [
            ("default_warehouse", "Running"),
            ("us_bi_etl_warehouse", "Running"),
            ("us_bi_dev_warehouse", "Running"),
            ("us_adhoc_warehouse", "Running"),
            ("us_report_warehouse", "Running"),
            ("us_etl_warehouse", "Running"),
            ("fms_warehouse", "Running"),
            ("eu_bi_etl_warehouse", "Running"),
            ("eu_dlct_warehouse", "Running"),
            ("bi_tableau_warehouse", "Running"),
            ("eu_report_warehouse", "Running"),
            ("us_epss_warehouse", "Running"),
        ]
    parent_cluster_id = _safe_str((clusters[0].get("ClusterId") if clusters else "") or "")
    for wh_name, wh_status in wh_list:
        relations = []
        if parent_cluster_id:
            relations.append(("warehouse_of_cluster", make_asset_id("aliyun", "StarRocks_Cluster", region, parent_cluster_id)))
        assets.append(
            _asset(
                "StarRocks_Warehouse",
                wh_name,
                wh_name,
                region,
                env,
                wh_status,
                _tag_health(wh_status),
                parent_resource_id=parent_cluster_id or None,
                purpose=SR_WAREHOUSE_PURPOSE.get(wh_name, ""),
                owner_team="bigdata-platform-sre",
                criticality="P1" if wh_name in ("default_warehouse", "us_bi_etl_warehouse") else "P2",
                spec_json={"display": "EMR Serverless"},
                raw_json={"warehouse": wh_name, "region": region},
                relations=relations,
                account_name=account_name,
            )
        )
    return assets


def discover_flink(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    env_json_path = os.path.join(os.path.dirname(__file__), "..", "envs", env, "env.json")
    try:
        with open(env_json_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        workspace = cfg.get("flink", {}).get("workspace", "")
        namespace = cfg.get("flink", {}).get("namespace", "")
    except Exception:
        workspace, namespace = "", ""
    if not workspace or workspace.startswith("<"):
        print("[info] flink workspace not configured for %s, skip" % env, file=sys.stderr)
        return []
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
    assets = []
    for dep in rows:
        dep_id = _safe_str(dep.get("deploymentId") or dep.get("Id"))
        dep_name = _safe_str(dep.get("name") or dep_id)
        state = _safe_str((dep.get("status") or {}).get("state") or dep.get("State") or "RUNNING")
        assets.append(
            _asset(
                "Flink_Deployment",
                dep_id,
                dep_name,
                region,
                env,
                state,
                _tag_health(state),
                purpose="Flink 实时作业 Deployment",
                owner_team="bigdata-platform-sre",
                spec_json={"display": _safe_str(dep.get("engineVersion") or dep.get("flinkVersion") or "")},
                raw_json=dep,
                labels_json={"workspace": workspace, "namespace": namespace},
                account_name=account_name,
            )
        )
    return assets


def discover_dataworks(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    rows = _page_collect(
        lambda page_no: aliyun_json(profile, ["dataworks-public", "--RegionId", region, "ListProjects", "--PageNumber", str(page_no), "--PageSize", "50"], timeout=30),
        lambda j: ((j.get("Projects") or {}).get("ProjectItem") or ((j.get("Data") or {}).get("Projects") or [])),
    )
    assets = []
    for proj in rows:
        proj_id = _safe_str(proj.get("ProjectId") or proj.get("Id"))
        proj_name = _safe_str(proj.get("ProjectName") or proj.get("Name") or proj_id)
        status_val = proj.get("ProjectStatus") or proj.get("Status") or 1
        status_str = "Running" if str(status_val) in ("1", "Running", "running") else "Stopped"
        assets.append(
            _asset(
                "DataWorks_Project",
                proj_id,
                proj_name,
                region,
                env,
                status_str,
                _tag_health(status_str),
                purpose="DataWorks 调度项目",
                owner_team="bigdata-platform-sre",
                raw_json=proj,
                account_name=account_name,
            )
        )
    return assets


def discover_ram_users(profile: str, region: str, env: str, account_name: str) -> List[Dict[str, Any]]:
    if region != "us-west-1":
        return []
    j = aliyun_json(profile, ["ram", "ListUsers", "--MaxItems", "100"], timeout=30)
    rows = []
    if j:
        rows = ((j.get("Users") or {}).get("User") or [])
    assets = []
    for user in rows:
        user_name = _safe_str(user.get("UserName"))
        assets.append(
            _asset(
                "RAM_User",
                user_name,
                user_name,
                "global",
                env,
                "Active",
                "ok",
                purpose="RAM 子账号",
                owner_team="bigdata-platform-sre",
                raw_json=user,
                account_name=account_name,
            )
        )
    return assets


def discover_cms_alert_counts(profile: str, region: str) -> Dict[str, int]:
    namespaces = ["acs_nat_gateway", "acs_physical_connection", "acs_oss", "acs_emr", "acs_flink"]
    result: Dict[str, int] = {}
    for ns in namespaces:
        j = aliyun_json(
            profile,
            [
                "cms",
                "DescribeAlertLogCount",
                "--RegionId",
                region,
                "--Namespace",
                ns,
                "--GroupBy",
                "product",
                "--StartTime",
                str((int(time.time()) - 86400) * 1000),
                "--EndTime",
                str(int(time.time()) * 1000),
            ],
            timeout=20,
        )
        if j:
            result[ns] = int(j.get("TotalCount") or j.get("Count") or 0)
    return result


def _apply_alerts(assets: List[Dict[str, Any]], alert_counts: Dict[str, int], region: str) -> None:
    ns_product_map = {
        "acs_nat_gateway": "NAT",
        "acs_physical_connection": "VBR",
        "acs_oss": "OSS",
        "acs_emr": "StarRocks_Cluster",
        "acs_flink": "Flink_Deployment",
    }
    for ns, count in alert_counts.items():
        ptype = ns_product_map.get(ns)
        if not ptype:
            continue
        for asset in assets:
            if asset["resource_type"] == ptype and (asset.get("region") or "global") == region:
                asset["alert_24h"] = count


def persist_assets(
    conn,
    assets: List[Dict[str, Any]],
    *,
    collector_name: str,
    dry_run: bool,
) -> Tuple[int, int, List[str]]:
    upserted = 0
    errors = 0
    seen_asset_ids: List[str] = []
    for asset in assets:
        asset_id = make_asset_id("aliyun", asset["resource_type"], asset.get("region"), asset["resource_id"])
        asset["asset_id"] = asset_id
        seen_asset_ids.append(asset_id)
        if dry_run:
            print("[dry-run] %s | %s | %s | %s" % (asset["resource_type"], asset["resource_id"], asset["resource_name"], asset["status"]))
            upserted += 1
            continue
        try:
            asset_id, created, prev_master = upsert_asset_master(conn, asset)
            if created:
                record_lifecycle_event(conn, asset_id, "discovered", after_json={"status": asset.get("status")}, source=collector_name)
            elif prev_master and prev_master.get("lifecycle_status") == "missing":
                record_lifecycle_event(conn, asset_id, "recovered", before_json={"lifecycle_status": "missing"}, after_json={"lifecycle_status": "active"}, source=collector_name)

            ensure_metadata_curated(
                conn,
                asset_id,
                purpose=asset.get("purpose"),
                owner_team=asset.get("owner_team"),
                service_name=asset.get("service_name"),
                system_name=asset.get("system_name"),
                criticality=asset.get("criticality"),
                manual_tags=asset.get("manual_tags"),
            )
            prev_obs = upsert_observation(
                conn,
                asset_id,
                asset.get("status", "Unknown"),
                asset.get("health", "unknown"),
                int(asset.get("alert_24h") or 0),
                asset.get("summary"),
                {"collector": collector_name, "raw_type": asset["resource_type"]},
            )
            if prev_obs and (
                prev_obs.get("status") != asset.get("status")
                or prev_obs.get("health") != asset.get("health")
                or int(prev_obs.get("alert_24h") or 0) != int(asset.get("alert_24h") or 0)
            ):
                record_lifecycle_event(
                    conn,
                    asset_id,
                    "status_changed",
                    before_json=prev_obs,
                    after_json={"status": asset.get("status"), "health": asset.get("health"), "alert_24h": int(asset.get("alert_24h") or 0)},
                    source=collector_name,
                )
            changed = upsert_config_snapshot(
                conn,
                asset_id,
                collector_name,
                asset.get("spec_json") or {},
                asset.get("capacity_json") or {},
                asset.get("network_json") or {},
                asset.get("labels_json") or {},
                asset.get("raw_json") or {},
            )
            if changed and not created:
                record_lifecycle_event(conn, asset_id, "config_changed", source=collector_name)

            grouped_relations: Dict[str, List[str]] = defaultdict(list)
            for relation_type, dst_asset_id in asset.get("relations") or []:
                if dst_asset_id:
                    grouped_relations[relation_type].append(dst_asset_id)
            for relation_type, dst_ids in grouped_relations.items():
                replace_active_relations(conn, asset_id, relation_type, dst_ids, source=collector_name)

            upsert_legacy_projection(conn, asset)
            upserted += 1
        except Exception as e:
            errors += 1
            print("[warn] persist failed for %s: %s" % (asset.get("resource_id"), e), file=sys.stderr)
    return upserted, errors, seen_asset_ids


def discover_region(region: str, cfg: Dict[str, Any], dry_run: bool) -> Tuple[int, int]:
    env = cfg["env"]
    profile = cfg["profile_default"]
    profile_dw = cfg["profile_dataworks"]
    account_name = cfg["account_name"]
    started = dt.datetime.now()
    collector_name = "discover_aliyun_assets"
    all_assets: List[Dict[str, Any]] = []
    collector_errors = 0
    print("[info] === discover region=%s env=%s ===" % (region, env))

    collectors = [
        ("VPC", lambda: discover_vpc(profile, region, env, account_name)),
        ("vSwitch", lambda: discover_vswitches(profile, region, env, account_name)),
        ("NAT", lambda: discover_nat(profile, region, env, account_name)),
        ("EIP", lambda: discover_eip(profile, region, env, account_name)),
        ("VBR", lambda: discover_vbr(profile, region, env, account_name)),
        ("ECS", lambda: discover_ecs(profile, region, env, account_name)),
        ("SecurityGroup", lambda: discover_security_groups(profile, region, env, account_name)),
        ("SLB", lambda: discover_slb(profile, region, env, account_name)),
        ("NLB", lambda: discover_nlb(profile, region, env, account_name)),
        ("RDS", lambda: discover_rds(profile, region, env, account_name)),
        ("CEN", lambda: discover_cen(profile, region, env, account_name)),
        ("RouteTable", lambda: discover_route_tables(profile, region, env, account_name)),
        ("OSS", lambda: discover_oss(profile, region, env, account_name)),
        ("StarRocks", lambda: discover_emr_starrocks(profile, region, env, account_name)),
        ("Flink", lambda: discover_flink(profile, region, env, account_name)),
        ("DataWorks", lambda: discover_dataworks(profile_dw, region, env, cfg.get("profile_dataworks") or account_name)),
        ("RAM_User", lambda: discover_ram_users(profile, region, env, account_name)),
        ("RAM_Role", lambda: discover_ram_roles(profile, region, env, account_name)),
    ]
    for name, fn in collectors:
        try:
            rows = fn()
            print("[info]   %-16s : %d items" % (name, len(rows)))
            all_assets.extend(rows)
        except Exception as e:
            collector_errors += 1
            print("[warn] collector %s failed: %s" % (name, e), file=sys.stderr)

    try:
        _apply_alerts(all_assets, discover_cms_alert_counts(profile, region), region)
    except Exception as e:
        collector_errors += 1
        print("[warn] CMS alert aggregation failed: %s" % e, file=sys.stderr)

    if dry_run:
        upserted, errors, _ = persist_assets(None, all_assets, collector_name=collector_name, dry_run=True)
        print("[info] region=%s done: total=%d upserted=%d errors=%d" % (region, len(all_assets), upserted, errors + collector_errors))
        return upserted, errors + collector_errors

    conn = get_db()
    try:
        upserted, persist_errors, seen_asset_ids = persist_assets(conn, all_assets, collector_name=collector_name, dry_run=False)
        account_names = sorted({str(asset.get("account_name") or "").strip() for asset in all_assets if str(asset.get("account_name") or "").strip()})
        if collector_errors == 0:
            missing_count = mark_missing_assets(conn, collector_name, region, env, seen_asset_ids, account_names=account_names)
        else:
            missing_count = 0
        status = "ok" if (collector_errors + persist_errors) == 0 else ("partial" if upserted > 0 else "failed")
        detail = "missing=%d" % missing_count
        if collector_errors > 0:
            detail += "; skip_missing_due_to_collector_errors=%d" % collector_errors
        write_sync_log(conn, "discover_v2", region, env, status, len(all_assets), upserted, collector_errors + persist_errors, detail, started)
        conn.commit()
        print("[info] region=%s done: total=%d upserted=%d missing=%d errors=%d" % (region, len(all_assets), upserted, missing_count, collector_errors + persist_errors))
        return upserted, collector_errors + persist_errors
    finally:
        conn.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="Discover Aliyun assets into v2 asset domain.")
    ap.add_argument("--dry-run", action="store_true", help="Print assets without writing to DB")
    ap.add_argument("--region", default="all", help="Which region to scan")
    args = ap.parse_args()

    if args.region == "all":
        regions_to_scan = {region: region_cfg(region) for region in _sync_region_keys()}
    else:
        regions_to_scan = {args.region: region_cfg(args.region)}
    total_up, total_err = 0, 0
    for region, cfg in regions_to_scan.items():
        up, err = discover_region(region, cfg, args.dry_run)
        total_up += up
        total_err += err
    print("\n[done] total upserted=%d errors=%d" % (total_up, total_err))
    return 0 if total_err == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
