from __future__ import annotations

import csv
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal


Domain = Literal["starrocks", "flink", "dataworks", "network", "ecs", "other"]


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def default_alert_group_ledger_path() -> Path:
    """
    Default: use a local CSV exported by the operator.
    Can be overridden by env AIOPS_ALERT_GROUP_LEDGER_CSV.
    """
    p = (os.environ.get("AIOPS_ALERT_GROUP_LEDGER_CSV") or "").strip()
    if p:
        return Path(p)
    return _repo_root() / "data" / "alert-groups.csv"


def _norm(s: Any) -> str:
    return str(s or "").strip()


def _bool_zh(v: str) -> bool | None:
    s = _norm(v)
    if not s:
        return None
    if s in {"是", "yes", "y", "true", "1"}:
        return True
    if s in {"否", "no", "n", "false", "0"}:
        return False
    return None


def _infer_domain(coverage: str) -> Domain:
    c = (coverage or "").lower()
    if "starrocks" in c or "sr" in c:
        return "starrocks"
    if "flink" in c:
        return "flink"
    if "dataworks" in c:
        return "dataworks"
    if any(x in c for x in ["nat", "eip", "vbr", "专线", "network", "出口", "公网", "带宽"]):
        return "network"
    if "ecs" in c or "主机" in c:
        return "ecs"
    return "other"


def _infer_region(group_name: str, coverage: str) -> str:
    """
    Heuristic mapping for MVP:
    - names containing US / 美区 -> us-west-1
    - names containing EU / 欧区 -> eu
    - otherwise use the configurable default region
    """
    g = (group_name or "").upper()
    c = (coverage or "").upper()
    if "EU" in g or "欧区" in c:
        return "eu"
    if "US" in g or "美区" in c:
        return "us-west-1"
    return (os.environ.get("AIOPS_DEFAULT_REGION") or "us-west-1").strip()


@dataclass(frozen=True)
class AlertGroupRow:
    group_name: str
    owner: str
    source: str
    coverage: str
    severity_policy: str
    escalation: str
    phone_upgrade: str
    bot_owner_is_group_owner: str
    webhook_viewable: bool | None
    webhook_masked_tail: str
    need_group_owner_help: str
    need_others_help: str
    contact_owner: str
    status: str
    next_action: str
    note: str
    domain: Domain
    region: str

    @property
    def has_webhook(self) -> bool:
        # Viewable + tail present => we can validate & route
        return bool(self.webhook_masked_tail.strip()) or self.webhook_viewable is True


def load_alert_group_ledger_csv(path: Path) -> list[AlertGroupRow]:
    p = Path(path)
    if not p.exists() or not p.is_file():
        return []
    # Support UTF-8 with BOM (Excel exports often have BOM)
    with p.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        out: list[AlertGroupRow] = []
        for r in reader:
            group_name = _norm(r.get("告警群"))
            if not group_name:
                continue
            coverage = _norm(r.get("覆盖域|对象"))
            domain = _infer_domain(coverage)
            region = _infer_region(group_name, coverage)
            out.append(
                AlertGroupRow(
                    group_name=group_name,
                    owner=_norm(r.get("群主")),
                    source=_norm(r.get("告警来源")),
                    coverage=coverage,
                    severity_policy=_norm(r.get("告警等级口径")),
                    escalation=_norm(r.get("升级方式")),
                    phone_upgrade=_norm(r.get("是否需要电话升级")),
                    bot_owner_is_group_owner=_norm(r.get("机器人创建者是否群主")),
                    webhook_viewable=_bool_zh(_norm(r.get("我是否可查看Webhook"))),
                    webhook_masked_tail=_norm(r.get("Webhook尾号(脱敏)")),
                    need_group_owner_help=_norm(r.get("需要群主配合事项")),
                    need_others_help=_norm(r.get("需要其他人配合事项")),
                    contact_owner=_norm(r.get("对接负责人(我去找谁)")),
                    status=_norm(r.get("当前状态")),
                    next_action=_norm(r.get("下一步动作")),
                    note=_norm(r.get("备注")),
                    domain=domain,
                    region=region,
                )
            )
        return out


def catalog_health(rows: list[AlertGroupRow]) -> dict[str, Any]:
    missing_webhook = 0
    not_viewable_webhook = 0
    need_owner_help = 0
    need_others_help = 0
    phone_upgrade_needed = 0
    for r in rows:
        if not r.has_webhook:
            missing_webhook += 1
        if r.webhook_viewable is False:
            not_viewable_webhook += 1
        if r.need_group_owner_help:
            need_owner_help += 1
        if r.need_others_help:
            need_others_help += 1
        if _norm(r.phone_upgrade) in {"是"}:
            phone_upgrade_needed += 1
    return {
        "total": len(rows),
        "missingWebhook": missing_webhook,
        "webhookNotViewable": not_viewable_webhook,
        "needGroupOwnerHelp": need_owner_help,
        "needOthersHelp": need_others_help,
        "phoneUpgradeNeeded": phone_upgrade_needed,
    }

