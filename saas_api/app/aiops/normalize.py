from __future__ import annotations

import datetime as dt
from typing import Any

from .types import NormalizedAlert, clamp_str, compute_fingerprint, normalize_severity


def _parse_ts(v: Any) -> int | None:
    """
    Accept:
    - epoch seconds (int/float)
    - epoch ms (int >= 10^12)
    - RFC3339 string (Alertmanager style)
    """
    if v is None:
        return None
    if isinstance(v, (int, float)):
        n = int(v)
        if n <= 0:
            return None
        # ms heuristics
        if n >= 10**12:
            return int(n / 1000)
        return n
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        # common: 2026-01-29T08:00:00Z / +00:00
        try:
            # normalize Z
            if s.endswith("Z"):
                s2 = s[:-1] + "+00:00"
            else:
                s2 = s
            return int(dt.datetime.fromisoformat(s2).timestamp())
        except Exception:
            return None
    return None


def normalize_payload(payload: Any) -> list[NormalizedAlert]:
    """
    Supported inputs:
    - Generic event:
      {source?, fingerprint?, severity?, title, description?, labels?, annotations?, startsAt?, endsAt?}
    - Alertmanager webhook:
      {receiver, status, alerts:[{labels,annotations,startsAt,endsAt,status}], commonLabels, commonAnnotations}
    """
    if not isinstance(payload, dict):
        return []

    # Alertmanager
    if isinstance(payload.get("alerts"), list):
        src = str(payload.get("source") or "alertmanager").strip() or "alertmanager"
        out: list[NormalizedAlert] = []
        common_labels = payload.get("commonLabels") if isinstance(payload.get("commonLabels"), dict) else {}
        common_ann = payload.get("commonAnnotations") if isinstance(payload.get("commonAnnotations"), dict) else {}
        for a in payload.get("alerts") or []:
            if not isinstance(a, dict):
                continue
            labels = {}
            if isinstance(common_labels, dict):
                labels.update(common_labels)
            if isinstance(a.get("labels"), dict):
                labels.update(a.get("labels") or {})

            ann = {}
            if isinstance(common_ann, dict):
                ann.update(common_ann)
            if isinstance(a.get("annotations"), dict):
                ann.update(a.get("annotations") or {})

            title = str(ann.get("summary") or labels.get("alertname") or "Alert").strip() or "Alert"
            desc = str(ann.get("description") or ann.get("message") or "").strip()
            sev = normalize_severity(str(labels.get("severity") or labels.get("level") or payload.get("status") or ""))
            fp = str(a.get("fingerprint") or "").strip()
            if not fp:
                fp = compute_fingerprint(title, labels)
            out.append(
                NormalizedAlert(
                    source=src,
                    fingerprint=clamp_str(fp, 80),
                    severity=sev,
                    title=clamp_str(title, 160),
                    description=clamp_str(desc, 4000),
                    labels=labels if isinstance(labels, dict) else {},
                    annotations=ann if isinstance(ann, dict) else {},
                    starts_at=_parse_ts(a.get("startsAt")),
                    ends_at=_parse_ts(a.get("endsAt")),
                    raw=a,
                )
            )
        return out

    # Generic single event
    title = str(payload.get("title") or payload.get("name") or payload.get("summary") or "").strip()
    if not title:
        return []
    src = str(payload.get("source") or "webhook").strip() or "webhook"
    labels = payload.get("labels") if isinstance(payload.get("labels"), dict) else {}
    ann = payload.get("annotations") if isinstance(payload.get("annotations"), dict) else {}
    desc = str(payload.get("description") or payload.get("message") or ann.get("description") or "").strip()
    sev = normalize_severity(str(payload.get("severity") or labels.get("severity") or labels.get("level") or ""))
    fp = str(payload.get("fingerprint") or payload.get("dedupKey") or payload.get("dedup_key") or "").strip()
    if not fp:
        fp = compute_fingerprint(title, labels)
    return [
        NormalizedAlert(
            source=src,
            fingerprint=clamp_str(fp, 80),
            severity=sev,
            title=clamp_str(title, 160),
            description=clamp_str(desc, 4000),
            labels=labels if isinstance(labels, dict) else {},
            annotations=ann if isinstance(ann, dict) else {},
            starts_at=_parse_ts(payload.get("startsAt") or payload.get("starts_at")),
            ends_at=_parse_ts(payload.get("endsAt") or payload.get("ends_at")),
            raw=payload,
        )
    ]

