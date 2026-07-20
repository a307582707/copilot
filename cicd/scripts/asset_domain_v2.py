#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asset_domain_v2.py
v2 资产域模型的通用读写工具。
"""

from __future__ import print_function

import datetime as dt
import hashlib
import json
import os
from typing import Any, Dict, Iterable, List, Optional, Tuple

import pymysql
import pymysql.cursors


MYSQL_HOST = os.environ.get("ASSET_DB_HOST", "127.0.0.1")
MYSQL_PORT = int(os.environ.get("ASSET_DB_PORT", "3306"))
MYSQL_USER = os.environ.get("ASSET_DB_USER", "codesprite_assets_rw")
MYSQL_PASS = os.environ.get("ASSET_DB_PASS", "")
MYSQL_DB = os.environ.get("ASSET_DB_NAME", "codesprite_assets")


def get_db():
    if not MYSQL_PASS:
        raise RuntimeError("ASSET_DB_PASS is required")
    return pymysql.connect(
        host=MYSQL_HOST,
        port=MYSQL_PORT,
        user=MYSQL_USER,
        password=MYSQL_PASS,
        database=MYSQL_DB,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=10,
        autocommit=False,
    )


def utcnow() -> dt.datetime:
    return dt.datetime.utcnow()


def make_asset_id(cloud_vendor: str, resource_type: str, region: Optional[str], resource_id: str) -> str:
    region_part = region or "global"
    return "%s:%s:%s:%s" % (cloud_vendor, resource_type, region_part, resource_id)


def json_hash(payload: Dict[str, Any]) -> str:
    text = json.dumps(payload or {}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def dumps_json(payload: Any) -> str:
    return json.dumps(payload if payload is not None else {}, ensure_ascii=False, sort_keys=True)


def write_sync_log(
    conn,
    sync_type: str,
    region: Optional[str],
    env: Optional[str],
    status: str,
    total: int,
    upserted: int,
    errors: int,
    detail: Optional[str],
    started_at: dt.datetime,
) -> None:
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO asset_sync_log
              (sync_type, region, env, status, total, upserted, errors, detail, started_at, finished_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                sync_type,
                region,
                env,
                status,
                total,
                upserted,
                errors,
                detail[:4000] if detail else None,
                started_at.strftime("%Y-%m-%d %H:%M:%S"),
                now,
            ),
        )


def ensure_metadata_curated(
    conn,
    asset_id: str,
    purpose: Optional[str] = None,
    owner_team: Optional[str] = None,
    service_name: Optional[str] = None,
    system_name: Optional[str] = None,
    criticality: Optional[str] = None,
    manual_tags: Optional[str] = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT asset_id FROM asset_metadata_curated WHERE asset_id=%s", (asset_id,))
        exists = cur.fetchone()
        if exists:
            updates = []
            params: List[Any] = []
            if purpose:
                updates.append("purpose = COALESCE(NULLIF(purpose,''), %s)")
                params.append(purpose)
            if owner_team:
                updates.append("owner_team = COALESCE(NULLIF(owner_team,''), %s)")
                params.append(owner_team)
            if service_name:
                updates.append("service_name = COALESCE(NULLIF(service_name,''), %s)")
                params.append(service_name)
            if system_name:
                updates.append("system_name = COALESCE(NULLIF(system_name,''), %s)")
                params.append(system_name)
            if criticality:
                updates.append("criticality = COALESCE(NULLIF(criticality,''), %s)")
                params.append(criticality)
            if manual_tags:
                updates.append("manual_tags = COALESCE(NULLIF(manual_tags,''), %s)")
                params.append(manual_tags)
            if updates:
                sql = "UPDATE asset_metadata_curated SET " + ", ".join(updates) + " WHERE asset_id=%s"
                params.append(asset_id)
                cur.execute(sql, params)
        else:
            cur.execute(
                """
                INSERT INTO asset_metadata_curated
                  (asset_id, owner_team, service_name, system_name, purpose, criticality, manual_tags)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (asset_id, owner_team, service_name, system_name, purpose, criticality, manual_tags),
            )


def record_lifecycle_event(
    conn,
    asset_id: str,
    event_type: str,
    before_json: Optional[Dict[str, Any]] = None,
    after_json: Optional[Dict[str, Any]] = None,
    remark: Optional[str] = None,
    source: str = "system",
    operator_name: Optional[str] = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO asset_lifecycle_events
              (asset_id, event_type, event_time, operator_name, before_json, after_json, source, remark)
            VALUES (%s, %s, NOW(), %s, %s, %s, %s, %s)
            """,
            (
                asset_id,
                event_type,
                operator_name,
                dumps_json(before_json) if before_json is not None else None,
                dumps_json(after_json) if after_json is not None else None,
                source,
                remark,
            ),
        )


def upsert_asset_master(conn, asset: Dict[str, Any]) -> Tuple[str, bool, Optional[Dict[str, Any]]]:
    asset_id = asset.get("asset_id") or make_asset_id(
        asset.get("cloud_vendor", "aliyun"),
        asset["resource_type"],
        asset.get("region"),
        asset["resource_id"],
    )
    prev = None
    created = False
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM asset_master WHERE asset_id=%s", (asset_id,))
        prev = cur.fetchone()
        if prev:
            cur.execute(
                """
                UPDATE asset_master
                   SET account_name=%s,
                       resource_name=%s,
                       region=%s,
                       zone_id=%s,
                       env=%s,
                       resource_group=%s,
                       parent_resource_id=%s,
                       lifecycle_status='active',
                       last_seen_at=NOW(),
                       missing_since=NULL,
                       source_of_truth=%s
                 WHERE asset_id=%s
                """,
                (
                    asset.get("account_name"),
                    asset.get("resource_name", ""),
                    asset.get("region"),
                    asset.get("zone_id"),
                    asset.get("env"),
                    asset.get("resource_group"),
                    asset.get("parent_resource_id"),
                    asset.get("source_of_truth", "aliyun_cli"),
                    asset_id,
                ),
            )
        else:
            created = True
            cur.execute(
                """
                INSERT INTO asset_master
                  (asset_id, cloud_vendor, account_name, resource_type, resource_id, resource_name,
                   region, zone_id, env, resource_group, parent_resource_id, lifecycle_status,
                   first_seen_at, last_seen_at, source_of_truth)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'active', NOW(), NOW(), %s)
                """,
                (
                    asset_id,
                    asset.get("cloud_vendor", "aliyun"),
                    asset.get("account_name"),
                    asset["resource_type"],
                    asset["resource_id"],
                    asset.get("resource_name", ""),
                    asset.get("region"),
                    asset.get("zone_id"),
                    asset.get("env"),
                    asset.get("resource_group"),
                    asset.get("parent_resource_id"),
                    asset.get("source_of_truth", "aliyun_cli"),
                ),
            )
    return asset_id, created, prev


def upsert_observation(
    conn,
    asset_id: str,
    status: str,
    health: str,
    alert_24h: int,
    summary: Optional[str],
    details_json: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    prev = None
    with conn.cursor() as cur:
        cur.execute("SELECT status, health, alert_24h, summary FROM asset_observations_latest WHERE asset_id=%s", (asset_id,))
        prev = cur.fetchone()
        cur.execute(
            """
            INSERT INTO asset_observations_latest
              (asset_id, observed_at, status, health, alert_24h, summary, details_json)
            VALUES (%s, NOW(), %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              observed_at=VALUES(observed_at),
              status=VALUES(status),
              health=VALUES(health),
              alert_24h=VALUES(alert_24h),
              summary=VALUES(summary),
              details_json=VALUES(details_json)
            """,
            (asset_id, status, health, int(alert_24h or 0), summary, dumps_json(details_json) if details_json is not None else None),
        )
    return prev


def upsert_config_snapshot(
    conn,
    asset_id: str,
    collector_name: str,
    spec_json: Dict[str, Any],
    capacity_json: Dict[str, Any],
    network_json: Dict[str, Any],
    labels_json: Dict[str, Any],
    raw_json: Dict[str, Any],
) -> bool:
    payload = {
        "spec_json": spec_json or {},
        "capacity_json": capacity_json or {},
        "network_json": network_json or {},
        "labels_json": labels_json or {},
        "raw_json": raw_json or {},
    }
    cfg_hash = json_hash(payload)
    inserted = False
    with conn.cursor() as cur:
        cur.execute("SELECT snapshot_id FROM asset_config_snapshots WHERE asset_id=%s AND config_hash=%s", (asset_id, cfg_hash))
        existing = cur.fetchone()
        if not existing:
            cur.execute("UPDATE asset_config_snapshots SET is_latest=0 WHERE asset_id=%s AND is_latest=1", (asset_id,))
            cur.execute(
                """
                INSERT INTO asset_config_snapshots
                  (asset_id, collector_name, config_hash, spec_json, capacity_json, network_json, labels_json, raw_json, collected_at, is_latest)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW(), 1)
                """,
                (
                    asset_id,
                    collector_name,
                    cfg_hash,
                    dumps_json(spec_json),
                    dumps_json(capacity_json),
                    dumps_json(network_json),
                    dumps_json(labels_json),
                    dumps_json(raw_json),
                ),
            )
            inserted = True
        else:
            cur.execute("UPDATE asset_config_snapshots SET is_latest=1 WHERE snapshot_id=%s", (existing["snapshot_id"],))
            cur.execute(
                "UPDATE asset_config_snapshots SET is_latest=0 WHERE asset_id=%s AND snapshot_id<>%s",
                (asset_id, existing["snapshot_id"]),
            )
    return inserted


def replace_active_relations(
    conn,
    src_asset_id: str,
    relation_type: str,
    dst_asset_ids: Iterable[str],
    source: str = "system",
    remark: Optional[str] = None,
) -> None:
    desired = set([x for x in dst_asset_ids if x])
    if desired:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT asset_id FROM asset_master WHERE asset_id IN (%s)" % ", ".join(["%s"] * len(desired)),
                tuple(desired),
            )
            desired = set([row["asset_id"] for row in (cur.fetchall() or [])])
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT relation_id, dst_asset_id
              FROM asset_relations
             WHERE src_asset_id=%s AND relation_type=%s AND effective_to IS NULL
            """,
            (src_asset_id, relation_type),
        )
        existing = cur.fetchall() or []
        existing_set = set([r["dst_asset_id"] for r in existing])
        to_close = existing_set - desired
        to_add = desired - existing_set
        if to_close:
            cur.execute(
                """
                UPDATE asset_relations
                   SET effective_to=NOW()
                 WHERE src_asset_id=%s AND relation_type=%s AND effective_to IS NULL AND dst_asset_id IN (%s)
                """ % ("%s", "%s", ", ".join(["%s"] * len(to_close))),
                tuple([src_asset_id, relation_type] + list(to_close)),
            )
        for dst in sorted(to_add):
            cur.execute(
                """
                INSERT INTO asset_relations
                  (src_asset_id, dst_asset_id, relation_type, source, effective_from, effective_to, remark)
                VALUES (%s, %s, %s, %s, NOW(), NULL, %s)
                """,
                (src_asset_id, dst, relation_type, source, remark),
            )


def upsert_legacy_projection(conn, asset: Dict[str, Any]) -> None:
    spec_json = asset.get("spec_json") or {}
    capacity_json = asset.get("capacity_json") or {}
    network_json = asset.get("network_json") or {}
    display_spec = spec_json.get("display") or capacity_json.get("display") or ""
    endpoint = network_json.get("primary_endpoint") or network_json.get("cidr") or ""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO aliyun_assets
              (instance_id, instance_name, product_type, region, env, status, health, spec, purpose, ip_or_domain, alert_24h, tags, extra_json, last_sync_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON DUPLICATE KEY UPDATE
              instance_name=VALUES(instance_name),
              product_type=VALUES(product_type),
              status=VALUES(status),
              health=VALUES(health),
              spec=VALUES(spec),
              purpose=VALUES(purpose),
              ip_or_domain=VALUES(ip_or_domain),
              alert_24h=VALUES(alert_24h),
              tags=VALUES(tags),
              extra_json=VALUES(extra_json),
              last_sync_at=VALUES(last_sync_at)
            """,
            (
                asset["legacy_instance_id"],
                asset.get("resource_name", ""),
                asset["resource_type"],
                asset.get("region") or "global",
                asset.get("env"),
                asset.get("status", "Unknown"),
                asset.get("health", "unknown"),
                display_spec[:512],
                asset.get("purpose"),
                endpoint[:256],
                int(asset.get("alert_24h") or 0),
                asset.get("manual_tags"),
                dumps_json(asset.get("raw_json") or {}),
            ),
        )


def upsert_sr_node_detail(
    conn,
    node_asset_id: str,
    cluster_asset_id: str,
    warehouse_asset_id: Optional[str],
    node_role: str,
    *,
    host_or_ip: Optional[str] = None,
    port: Optional[int] = None,
    version: Optional[str] = None,
    spec_display: Optional[str] = None,
    cpu_cores: Optional[int] = None,
    memory_gb: Optional[float] = None,
    disk_type: Optional[str] = None,
    disk_size_gb: Optional[int] = None,
    az: Optional[str] = None,
    alive: Optional[bool] = None,
    node_status: Optional[str] = None,
    description: Optional[str] = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO sr_node_details
              (node_asset_id, cluster_asset_id, warehouse_asset_id, node_role,
               host_or_ip, port, version, spec_display, cpu_cores, memory_gb,
               disk_type, disk_size_gb, az, alive, node_status, description, last_sync_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())
            ON DUPLICATE KEY UPDATE
              cluster_asset_id=VALUES(cluster_asset_id),
              warehouse_asset_id=VALUES(warehouse_asset_id),
              node_role=VALUES(node_role),
              host_or_ip=VALUES(host_or_ip),
              port=VALUES(port),
              version=VALUES(version),
              spec_display=VALUES(spec_display),
              cpu_cores=VALUES(cpu_cores),
              memory_gb=VALUES(memory_gb),
              disk_type=VALUES(disk_type),
              disk_size_gb=VALUES(disk_size_gb),
              az=VALUES(az),
              alive=VALUES(alive),
              node_status=VALUES(node_status),
              description=VALUES(description),
              last_sync_at=NOW()
            """,
            (
                node_asset_id, cluster_asset_id, warehouse_asset_id, node_role,
                host_or_ip, port, version, spec_display, cpu_cores, memory_gb,
                disk_type, disk_size_gb, az,
                int(alive) if alive is not None else None,
                node_status, description,
            ),
        )


def upsert_sr_param_detail(
    conn,
    scope_type: str,
    scope_asset_id: str,
    scope_name: Optional[str],
    param_name: str,
    current_value: Optional[str],
    default_value: Optional[str] = None,
    param_source: Optional[str] = None,
    remark: Optional[str] = None,
) -> None:
    param_key = "%s:%s" % (scope_asset_id, param_name)
    is_non_default = 0
    if current_value is not None and default_value is not None and str(current_value) != str(default_value):
        is_non_default = 1
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO sr_param_details
              (param_key, scope_type, scope_asset_id, scope_name, param_name,
               current_value, default_value, is_non_default, param_source, last_sync_at, remark)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),%s)
            ON DUPLICATE KEY UPDATE
              scope_type=VALUES(scope_type),
              scope_name=VALUES(scope_name),
              current_value=VALUES(current_value),
              default_value=VALUES(default_value),
              is_non_default=VALUES(is_non_default),
              param_source=VALUES(param_source),
              last_sync_at=NOW(),
              remark=VALUES(remark)
            """,
            (
                param_key, scope_type, scope_asset_id, scope_name, param_name,
                current_value, default_value, is_non_default, param_source, remark,
            ),
        )


def cleanup_stale_sr_nodes(conn, cluster_asset_id: str, seen_node_ids: Iterable[str]) -> int:
    """Mark stale sr_node_details rows by removing those not seen in this sync round."""
    seen = set(seen_node_ids)
    removed = 0
    with conn.cursor() as cur:
        cur.execute(
            "SELECT node_asset_id FROM sr_node_details WHERE cluster_asset_id=%s",
            (cluster_asset_id,),
        )
        for row in cur.fetchall() or []:
            nid = row["node_asset_id"]
            if nid not in seen:
                cur.execute("DELETE FROM sr_node_details WHERE node_asset_id=%s", (nid,))
                removed += 1
    return removed


def cleanup_stale_sr_params(conn, scope_asset_id: str, seen_param_keys: Iterable[str]) -> int:
    """Remove params no longer present for a scope."""
    seen = set(seen_param_keys)
    removed = 0
    with conn.cursor() as cur:
        cur.execute(
            "SELECT param_key FROM sr_param_details WHERE scope_asset_id=%s",
            (scope_asset_id,),
        )
        for row in cur.fetchall() or []:
            pk = row["param_key"]
            if pk not in seen:
                cur.execute("DELETE FROM sr_param_details WHERE param_key=%s", (pk,))
                removed += 1
    return removed


def mark_missing_assets(
    conn,
    sync_scope: str,
    region: Optional[str],
    env: Optional[str],
    seen_asset_ids: Iterable[str],
    account_names: Optional[Iterable[str]] = None,
) -> int:
    seen = set(seen_asset_ids)
    accounts = sorted({str(v).strip() for v in (account_names or []) if str(v).strip()})
    missing_count = 0
    with conn.cursor() as cur:
        if region == "all" or region is None:
            sql = """
                SELECT asset_id, lifecycle_status
                  FROM asset_master
                 WHERE cloud_vendor='aliyun'
                   AND (env=%s OR %s IS NULL)
            """
            args: List[Any] = [env, env]
        else:
            sql = """
                SELECT asset_id, lifecycle_status
                  FROM asset_master
                 WHERE cloud_vendor='aliyun'
                   AND region=%s
                   AND (env=%s OR %s IS NULL)
            """
            args = [region, env, env]
        if accounts:
            sql += " AND account_name IN (%s)" % ", ".join(["%s"] * len(accounts))
            args.extend(accounts)
        cur.execute(sql, tuple(args))
        rows = cur.fetchall() or []
        for row in rows:
            asset_id = row["asset_id"]
            if asset_id in seen:
                continue
            cur.execute(
                """
                UPDATE asset_master
                   SET lifecycle_status='missing',
                       missing_since=COALESCE(missing_since, NOW())
                 WHERE asset_id=%s AND lifecycle_status<>'retired'
                """,
                (asset_id,),
            )
            missing_count += 1
    return missing_count

