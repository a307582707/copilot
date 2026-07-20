from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from .accounting import mask_email, ms, new_id
from .db import connect, exec_one, fetch_all, fetch_one, init_db
from .saas import current_user, require_admin

router = APIRouter()

_DB = connect()
init_db(_DB)


def _json_loads(raw: object, default):
    text = str(raw or "").strip()
    if not text:
        return default
    try:
        return json.loads(text)
    except Exception:
        return default


def _audit_log(*, actor_user_id: int, target_type: str, target_id: str, action: str, before: dict, after: dict, reason: str) -> None:
    exec_one(
        _DB,
        """
INSERT INTO admin_audit_events(id,actor_user_id,target_type,target_id,action,before_json,after_json,reason,created_at)
VALUES(?,?,?,?,?,?,?,?,?);
""",
        (
            new_id("audit"),
            int(actor_user_id),
            target_type,
            target_id,
            action,
            json.dumps(before or {}, ensure_ascii=False),
            json.dumps(after or {}, ensure_ascii=False),
            reason,
            ms(),
        ),
    )


def _load_subscription_row(uid: int) -> dict | None:
    return fetch_one(
        _DB,
        """
SELECT user_id,status,trial_ends_at,current_period_end,created_at,updated_at
FROM subscriptions
WHERE user_id=?
LIMIT 1;
""",
        (uid,),
    )


def _load_user_row(uid: int) -> dict | None:
    return fetch_one(
        _DB,
        """
SELECT id,email,status,role,created_at,updated_at
FROM users
WHERE id=?
LIMIT 1;
""",
        (uid,),
    )


def _adjust_node_active_users(region: str, delta: int) -> None:
    region_name = str(region or "").strip()
    if not region_name or int(delta or 0) == 0:
        return
    exec_one(
        _DB,
        """
UPDATE node_inventory
SET active_users = CASE
  WHEN (active_users + ?) < 0 THEN 0
  ELSE (active_users + ?)
END,
updated_at=?
WHERE region=?;
""",
        (int(delta), int(delta), ms(), region_name),
    )


def _ticket_payload(row: dict) -> dict:
    return {
        "id": str(row.get("id") or ""),
        "userId": int(row.get("user_id") or 0),
        "category": str(row.get("category") or ""),
        "subject": str(row.get("subject") or ""),
        "content": str(row.get("content") or ""),
        "status": str(row.get("status") or "open"),
        "adminNote": str(row.get("admin_note") or ""),
        "assignedTo": int(row.get("assigned_to") or 0) or None,
        "createdAt": int(row.get("created_at") or 0) or None,
        "updatedAt": int(row.get("updated_at") or 0) or None,
        "resolvedAt": int(row.get("resolved_at") or 0) or None,
    }


def _resume_subscription_status(row: dict | None) -> str:
    if not row:
        return "active"
    now = ms()
    trial_ends_at = int((row or {}).get("trial_ends_at") or 0)
    current_period_end = int((row or {}).get("current_period_end") or 0)
    if trial_ends_at and trial_ends_at >= now:
        return "trialing"
    if current_period_end and current_period_end >= now:
        return "active"
    return "expired"


def _subscription_payload(uid: int) -> dict:
    row = _load_subscription_row(uid)
    if not row:
        return {
            "status": "none",
            "plan": "monthly",
            "currentPeriodStart": None,
            "currentPeriodEnd": None,
            "cancelAtPeriodEnd": False,
            "trialEndsAt": None,
            "gracePeriodEndsAt": None,
            "suspendedAt": None,
            "suspendReason": "",
        }
    current_period_end = int(row.get("current_period_end") or 0) or None
    created_at = int(row.get("created_at") or 0) or None
    return {
        "status": str(row.get("status") or "none"),
        "plan": "monthly",
        "currentPeriodStart": created_at,
        "currentPeriodEnd": current_period_end,
        "cancelAtPeriodEnd": False,
        "trialEndsAt": int(row.get("trial_ends_at") or 0) or None,
        "gracePeriodEndsAt": None,
        "suspendedAt": None,
        "suspendReason": "",
    }


def _entitlements_payload(uid: int) -> dict:
    row = fetch_one(
        _DB,
        """
SELECT device_limit, region_limit
FROM delivery_records
WHERE user_id=? AND status IN ('pending','active')
ORDER BY updated_at DESC, issued_at DESC
LIMIT 1;
""",
        (uid,),
    )
    return {
        "deviceLimit": int((row or {}).get("device_limit") or 3),
        "regionLimit": int((row or {}).get("region_limit") or 2),
        "supportTier": "ticket",
    }


@router.get("/api/me/subscription")
def api_me_subscription(u: dict = Depends(current_user)):
    uid = int(u["id"])
    return {
        "ok": True,
        "subscription": _subscription_payload(uid),
        "entitlements": _entitlements_payload(uid),
    }


@router.get("/api/me/deliveries")
def api_me_deliveries(u: dict = Depends(current_user)):
    uid = int(u["id"])
    rows = fetch_all(
        _DB,
        """
SELECT id,status,delivery_type,region,device_limit,region_limit,config_version,issued_at,expires_at,revoked_at,updated_at
FROM delivery_records
WHERE user_id=?
ORDER BY updated_at DESC, issued_at DESC
LIMIT 50;
""",
        (uid,),
    )
    items = [
        {
            "id": str(r.get("id") or ""),
            "status": str(r.get("status") or "pending"),
            "deliveryType": str(r.get("delivery_type") or "subscription_bundle"),
            "region": str(r.get("region") or ""),
            "deviceLimit": int(r.get("device_limit") or 0),
            "regionLimit": int(r.get("region_limit") or 0),
            "configVersion": int(r.get("config_version") or 0),
            "issuedAt": int(r.get("issued_at") or 0) or None,
            "expiresAt": int(r.get("expires_at") or 0) or None,
            "revokedAt": int(r.get("revoked_at") or 0) or None,
            "updatedAt": int(r.get("updated_at") or 0) or None,
        }
        for r in rows
    ]
    return {"ok": True, "items": items}


@router.get("/api/me/support/tickets")
def api_me_support_tickets(u: dict = Depends(current_user)):
    uid = int(u["id"])
    rows = fetch_all(
        _DB,
        """
SELECT id,user_id,category,subject,content,status,admin_note,assigned_to,created_at,updated_at,resolved_at
FROM support_tickets
WHERE user_id=?
ORDER BY updated_at DESC, created_at DESC
LIMIT 50;
""",
        (uid,),
    )
    return {"ok": True, "items": [_ticket_payload(r) for r in rows]}


@router.post("/api/me/support/tickets")
def api_me_support_tickets_create(payload: dict, u: dict = Depends(current_user)):
    uid = int(u["id"])
    category = str(payload.get("category") or "").strip().lower() or "billing"
    subject = str(payload.get("subject") or "").strip()
    content = str(payload.get("content") or "").strip()
    if not subject:
        raise HTTPException(status_code=400, detail="Missing subject")
    if not content:
        raise HTTPException(status_code=400, detail="Missing content")
    now = ms()
    ticket_id = new_id("ticket")
    exec_one(
        _DB,
        """
INSERT INTO support_tickets(id,user_id,category,subject,content,status,admin_note,assigned_to,created_at,updated_at,resolved_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?);
""",
        (ticket_id, uid, category, subject, content, "open", "", None, now, now, None),
    )
    _audit_log(
        actor_user_id=uid,
        target_type="support_ticket",
        target_id=ticket_id,
        action="create_support_ticket",
        before={},
        after={"category": category, "subject": subject, "status": "open"},
        reason="user_create",
    )
    return {"ok": True, "id": ticket_id}


@router.get("/api/admin/overseas/overview")
def api_admin_overseas_overview(_: dict = Depends(require_admin)):
    users_total = fetch_one(_DB, "SELECT COUNT(1) AS n FROM users;", ())
    active_subs = fetch_one(_DB, "SELECT COUNT(1) AS n FROM subscriptions WHERE status='active';", ())
    trialing = fetch_one(_DB, "SELECT COUNT(1) AS n FROM subscriptions WHERE status='trialing';", ())
    pending_orders = fetch_one(_DB, "SELECT COUNT(1) AS n FROM recharge_orders WHERE status IN ('created','submitted','paid');", ())
    refunds_pending = fetch_one(_DB, "SELECT COUNT(1) AS n FROM payment_refunds WHERE status IN ('pending','disputed');", ())
    abuse_open = fetch_one(_DB, "SELECT COUNT(1) AS n FROM abuse_events WHERE status IN ('open','reviewing');", ())
    healthy_nodes = fetch_one(_DB, "SELECT COUNT(1) AS n FROM node_inventory WHERE status='healthy';", ())
    nodes_total = fetch_one(_DB, "SELECT COUNT(1) AS n FROM node_inventory;", ())
    incidents_open = fetch_one(_DB, "SELECT COUNT(1) AS n FROM status_incidents WHERE status<>'resolved';", ())
    return {
        "ok": True,
        "summary": {
            "usersTotal": int((users_total or {}).get("n") or 0),
            "subscriptionsActive": int((active_subs or {}).get("n") or 0),
            "trialingUsers": int((trialing or {}).get("n") or 0),
            "pendingOrders": int((pending_orders or {}).get("n") or 0),
            "refundsPending": int((refunds_pending or {}).get("n") or 0),
            "abuseOpen": int((abuse_open or {}).get("n") or 0),
            "healthyNodes": int((healthy_nodes or {}).get("n") or 0),
            "nodesTotal": int((nodes_total or {}).get("n") or 0),
            "incidentsOpen": int((incidents_open or {}).get("n") or 0),
        },
    }


@router.get("/api/admin/subscriptions")
def api_admin_subscriptions(
    page: int = 1,
    pageSize: int = 20,
    status: Optional[str] = None,
    keyword: Optional[str] = None,
    _: dict = Depends(require_admin),
):
    page_num = max(1, int(page or 1))
    size = max(1, min(100, int(pageSize or 20)))
    offset = (page_num - 1) * size
    where: list[str] = []
    args: list[object] = []
    st = (status or "").strip().lower()
    if st:
        where.append("s.status=?")
        args.append(st)
    kw = (keyword or "").strip().lower()
    if kw:
        like = f"%{kw}%"
        where.append("(LOWER(u.email) LIKE ? OR CAST(s.user_id AS CHAR) LIKE ?)")
        args.extend([like, like])
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    total = fetch_one(
        _DB,
        f"""
SELECT COUNT(1) AS n
FROM subscriptions s
JOIN users u ON u.id=s.user_id
{where_sql};
""",
        tuple(args),
    )
    rows = fetch_all(
        _DB,
        f"""
SELECT s.user_id,u.email,u.status AS user_status,s.status,s.trial_ends_at,s.current_period_end,s.updated_at,
       (
         SELECT d.id
         FROM delivery_records d
         WHERE d.user_id=s.user_id AND d.status IN ('pending','active')
         ORDER BY d.updated_at DESC, d.issued_at DESC
         LIMIT 1
       ) AS active_delivery_id,
       (
         SELECT d.region
         FROM delivery_records d
         WHERE d.user_id=s.user_id AND d.status IN ('pending','active')
         ORDER BY d.updated_at DESC, d.issued_at DESC
         LIMIT 1
       ) AS active_delivery_region
FROM subscriptions s
JOIN users u ON u.id=s.user_id
{where_sql}
ORDER BY COALESCE(s.current_period_end, 0) ASC, s.user_id DESC
LIMIT ? OFFSET ?;
""",
        tuple([*args, size, offset]),
    )
    items = [
        {
            "userId": int(r.get("user_id") or 0),
            "email": mask_email(str(r.get("email") or "")),
            "userStatus": str(r.get("user_status") or "active"),
            "status": str(r.get("status") or ""),
            "trialEndsAt": int(r.get("trial_ends_at") or 0) or None,
            "currentPeriodEnd": int(r.get("current_period_end") or 0) or None,
            "updatedAt": int(r.get("updated_at") or 0) or None,
            "activeDeliveryId": str(r.get("active_delivery_id") or ""),
            "activeDeliveryRegion": str(r.get("active_delivery_region") or ""),
        }
        for r in rows
    ]
    return {"ok": True, "items": items, "page": page_num, "pageSize": size, "total": int((total or {}).get("n") or 0)}


@router.get("/api/admin/abuse-events")
def api_admin_abuse_events(status: Optional[str] = None, _: dict = Depends(require_admin)):
    st = (status or "").strip().lower()
    where = ""
    args: tuple[object, ...] = ()
    if st:
        where = "WHERE status=?"
        args = (st,)
    rows = fetch_all(
        _DB,
        f"""
SELECT id,user_id,category,severity,status,action_taken,created_at,resolved_at
FROM abuse_events
{where}
ORDER BY created_at DESC
LIMIT 100;
""",
        args,
    )
    items = [
        {
            "id": str(r.get("id") or ""),
            "userId": int(r.get("user_id") or 0) or None,
            "category": str(r.get("category") or ""),
            "severity": str(r.get("severity") or ""),
            "status": str(r.get("status") or ""),
            "actionTaken": str(r.get("action_taken") or ""),
            "createdAt": int(r.get("created_at") or 0) or None,
            "resolvedAt": int(r.get("resolved_at") or 0) or None,
        }
        for r in rows
    ]
    return {"ok": True, "items": items}


@router.get("/api/admin/support/tickets")
def api_admin_support_tickets(status: Optional[str] = None, _: dict = Depends(require_admin)):
    st = (status or "").strip().lower()
    where = ""
    args: tuple[object, ...] = ()
    if st:
        where = "WHERE t.status=?"
        args = (st,)
    rows = fetch_all(
        _DB,
        f"""
SELECT t.id,t.user_id,u.email,t.category,t.subject,t.content,t.status,t.admin_note,t.assigned_to,t.created_at,t.updated_at,t.resolved_at
FROM support_tickets t
JOIN users u ON u.id=t.user_id
{where}
ORDER BY t.updated_at DESC, t.created_at DESC
LIMIT 100;
""",
        args,
    )
    items = []
    for r in rows:
        item = _ticket_payload(r)
        item["email"] = mask_email(str(r.get("email") or ""))
        items.append(item)
    return {"ok": True, "items": items}


@router.post("/api/admin/support/tickets/{ticket_id}/status")
def api_admin_support_ticket_status(ticket_id: str, payload: dict, admin: dict = Depends(require_admin)):
    tid = str(ticket_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="Missing ticket id")
    row = fetch_one(
        _DB,
        """
SELECT id,user_id,category,subject,content,status,admin_note,assigned_to,created_at,updated_at,resolved_at
FROM support_tickets
WHERE id=?
LIMIT 1;
""",
        (tid,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Ticket not found")
    status = str(payload.get("status") or "").strip().lower()
    if status not in {"open", "in_progress", "resolved"}:
        raise HTTPException(status_code=400, detail="Invalid status")
    admin_note = str(payload.get("adminNote") or payload.get("admin_note") or row.get("admin_note") or "").strip()
    now = ms()
    resolved_at = now if status == "resolved" else None
    exec_one(
        _DB,
        """
UPDATE support_tickets
SET status=?, admin_note=?, assigned_to=?, updated_at=?, resolved_at=?
WHERE id=?;
""",
        (status, admin_note, int(admin["id"]), now, resolved_at, tid),
    )
    _audit_log(
        actor_user_id=int(admin["id"]),
        target_type="support_ticket",
        target_id=tid,
        action="update_support_ticket_status",
        before={"status": str(row.get("status") or ""), "adminNote": str(row.get("admin_note") or "")},
        after={"status": status, "adminNote": admin_note},
        reason="admin_update",
    )
    return {"ok": True, "id": tid, "status": status}


@router.post("/api/admin/deliveries/assign")
def api_admin_delivery_assign(payload: dict, admin: dict = Depends(require_admin)):
    user_id = int(payload.get("userId") or payload.get("user_id") or 0)
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="Missing userId")
    region = str(payload.get("region") or "").strip()
    if not region:
        raise HTTPException(status_code=400, detail="Missing region")
    device_limit = max(1, int(payload.get("deviceLimit") or payload.get("device_limit") or 3))
    region_limit = max(1, int(payload.get("regionLimit") or payload.get("region_limit") or 2))
    user = _load_user_row(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if str(user.get("status") or "active") == "disabled":
        raise HTTPException(status_code=400, detail="User disabled")
    sub = _load_subscription_row(user_id)
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")
    sub_status = str(sub.get("status") or "")
    if sub_status not in {"active", "trialing"}:
        raise HTTPException(status_code=400, detail="Subscription inactive")
    now = ms()
    expires_at = int(sub.get("current_period_end") or 0) or int(sub.get("trial_ends_at") or 0) or None
    existing = fetch_all(
        _DB,
        """
SELECT id,region,status
FROM delivery_records
WHERE user_id=? AND status IN ('pending','active');
""",
        (user_id,),
    )
    for row in existing:
        existing_region = str(row.get("region") or "")
        exec_one(
            _DB,
            "UPDATE delivery_records SET status='revoked', revoked_at=?, updated_at=? WHERE id=?;",
            (now, now, str(row.get("id") or "")),
        )
        _adjust_node_active_users(existing_region, -1)
    delivery_id = new_id("delivery")
    exec_one(
        _DB,
        """
INSERT INTO delivery_records(id,user_id,subscription_period_key,delivery_type,status,region,device_limit,region_limit,config_version,issued_at,expires_at,revoked_at,updated_at,meta_json)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?);
""",
        (
            delivery_id,
            user_id,
            f"user-{user_id}",
            "subscription_bundle",
            "active",
            region,
            device_limit,
            region_limit,
            1,
            now,
            expires_at,
            None,
            now,
            json.dumps({"assignedBy": int(admin["id"])}, ensure_ascii=False),
        ),
    )
    _adjust_node_active_users(region, 1)
    _audit_log(
        actor_user_id=int(admin["id"]),
        target_type="delivery",
        target_id=delivery_id,
        action="assign_delivery",
        before={"existingCount": len(existing)},
        after={"userId": user_id, "region": region, "deviceLimit": device_limit, "regionLimit": region_limit},
        reason="admin_assign",
    )
    return {"ok": True, "id": delivery_id, "region": region}


@router.post("/api/admin/deliveries/{delivery_id}/revoke")
def api_admin_delivery_revoke(delivery_id: str, payload: Optional[dict] = None, admin: dict = Depends(require_admin)):
    did = str(delivery_id or "").strip()
    if not did:
        raise HTTPException(status_code=400, detail="Missing delivery id")
    row = fetch_one(
        _DB,
        """
SELECT id,user_id,status,region,device_limit,region_limit,issued_at,expires_at,revoked_at
FROM delivery_records
WHERE id=?
LIMIT 1;
""",
        (did,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Delivery not found")
    now = ms()
    exec_one(
        _DB,
        "UPDATE delivery_records SET status='revoked', revoked_at=?, updated_at=? WHERE id=?;",
        (now, now, did),
    )
    _adjust_node_active_users(str(row.get("region") or ""), -1)
    _audit_log(
        actor_user_id=int(admin["id"]),
        target_type="delivery",
        target_id=did,
        action="revoke_delivery",
        before={"status": str(row.get("status") or ""), "region": str(row.get("region") or "")},
        after={"status": "revoked"},
        reason=str((payload or {}).get("reason") or "admin_revoke"),
    )
    return {"ok": True, "id": did, "status": "revoked"}


@router.post("/api/admin/subscriptions/{user_id}/suspend")
def api_admin_subscription_suspend(user_id: int, payload: Optional[dict] = None, admin: dict = Depends(require_admin)):
    sub = _load_subscription_row(int(user_id))
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")
    before = {
        "status": str(sub.get("status") or ""),
        "trialEndsAt": int(sub.get("trial_ends_at") or 0) or None,
        "currentPeriodEnd": int(sub.get("current_period_end") or 0) or None,
    }
    reason = str((payload or {}).get("reason") or "admin_suspend").strip() or "admin_suspend"
    now = ms()
    exec_one(
        _DB,
        "UPDATE subscriptions SET status=?, updated_at=? WHERE user_id=?;",
        ("suspended", now, int(user_id)),
    )
    exec_one(
        _DB,
        "UPDATE delivery_records SET status='revoked', revoked_at=?, updated_at=? WHERE user_id=? AND status IN ('pending','active');",
        (now, now, int(user_id)),
    )
    after = {**before, "status": "suspended"}
    _audit_log(
        actor_user_id=int(admin["id"]),
        target_type="subscription",
        target_id=str(user_id),
        action="suspend_subscription",
        before=before,
        after=after,
        reason=reason,
    )
    return {"ok": True, "userId": int(user_id), "status": "suspended"}


@router.post("/api/admin/subscriptions/{user_id}/resume")
def api_admin_subscription_resume(user_id: int, payload: Optional[dict] = None, admin: dict = Depends(require_admin)):
    sub = _load_subscription_row(int(user_id))
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")
    before = {
        "status": str(sub.get("status") or ""),
        "trialEndsAt": int(sub.get("trial_ends_at") or 0) or None,
        "currentPeriodEnd": int(sub.get("current_period_end") or 0) or None,
    }
    new_status = _resume_subscription_status(sub)
    reason = str((payload or {}).get("reason") or "admin_resume").strip() or "admin_resume"
    now = ms()
    exec_one(
        _DB,
        "UPDATE subscriptions SET status=?, updated_at=? WHERE user_id=?;",
        (new_status, now, int(user_id)),
    )
    after = {**before, "status": new_status}
    _audit_log(
        actor_user_id=int(admin["id"]),
        target_type="subscription",
        target_id=str(user_id),
        action="resume_subscription",
        before=before,
        after=after,
        reason=reason,
    )
    return {"ok": True, "userId": int(user_id), "status": new_status}


@router.post("/api/admin/users/{user_id}/ban")
def api_admin_user_ban(user_id: int, payload: Optional[dict] = None, admin: dict = Depends(require_admin)):
    user = _load_user_row(int(user_id))
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    reason = str((payload or {}).get("reason") or "abuse_detected").strip() or "abuse_detected"
    before = {"status": str(user.get("status") or "active")}
    now = ms()
    exec_one(
        _DB,
        "UPDATE users SET status=?, updated_at=? WHERE id=?;",
        ("disabled", now, int(user_id)),
    )
    exec_one(
        _DB,
        "UPDATE subscriptions SET status=?, updated_at=? WHERE user_id=? AND status IN ('trialing','active');",
        ("suspended", now, int(user_id)),
    )
    exec_one(
        _DB,
        "UPDATE delivery_records SET status='revoked', revoked_at=?, updated_at=? WHERE user_id=? AND status IN ('pending','active');",
        (now, now, int(user_id)),
    )
    exec_one(
        _DB,
        """
INSERT INTO abuse_events(id,user_id,category,severity,status,action_taken,evidence_json,created_by,created_at,resolved_at)
VALUES(?,?,?,?,?,?,?,?,?,?);
""",
        (
            new_id("abuse"),
            int(user_id),
            "admin_ban",
            "high",
            "resolved",
            "ban",
            json.dumps({"reason": reason}, ensure_ascii=False),
            int(admin["id"]),
            now,
            now,
        ),
    )
    after = {"status": "disabled"}
    _audit_log(
        actor_user_id=int(admin["id"]),
        target_type="user",
        target_id=str(user_id),
        action="ban_user",
        before=before,
        after=after,
        reason=reason,
    )
    return {"ok": True, "userId": int(user_id), "status": "disabled"}


@router.post("/api/admin/users/{user_id}/unban")
def api_admin_user_unban(user_id: int, payload: Optional[dict] = None, admin: dict = Depends(require_admin)):
    user = _load_user_row(int(user_id))
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    reason = str((payload or {}).get("reason") or "admin_unban").strip() or "admin_unban"
    before = {"status": str(user.get("status") or "active")}
    now = ms()
    exec_one(
        _DB,
        "UPDATE users SET status=?, updated_at=? WHERE id=?;",
        ("active", now, int(user_id)),
    )
    after = {"status": "active"}
    _audit_log(
        actor_user_id=int(admin["id"]),
        target_type="user",
        target_id=str(user_id),
        action="unban_user",
        before=before,
        after=after,
        reason=reason,
    )
    return {"ok": True, "userId": int(user_id), "status": "active"}


@router.get("/api/admin/nodes")
def api_admin_nodes(_: dict = Depends(require_admin)):
    rows = fetch_all(
        _DB,
        """
SELECT id,region,provider,status,capacity_limit,active_users,cost_monthly_cents,latency_p50_ms,online_rate,updated_at
FROM node_inventory
ORDER BY region ASC, provider ASC, updated_at DESC
LIMIT 200;
""",
        (),
    )
    items = [
        {
            "id": str(r.get("id") or ""),
            "region": str(r.get("region") or ""),
            "provider": str(r.get("provider") or ""),
            "status": str(r.get("status") or ""),
            "capacityLimit": int(r.get("capacity_limit") or 0),
            "activeUsers": int(r.get("active_users") or 0),
            "costMonthlyCents": int(r.get("cost_monthly_cents") or 0),
            "latencyP50Ms": int(r.get("latency_p50_ms") or 0),
            "onlineRate": float(r.get("online_rate") or 0),
            "updatedAt": int(r.get("updated_at") or 0) or None,
        }
        for r in rows
    ]
    return {"ok": True, "items": items}


@router.get("/api/admin/status/incidents")
def api_admin_status_incidents(_: dict = Depends(require_admin)):
    rows = fetch_all(
        _DB,
        """
SELECT id,status,title,severity,scope_json,message_md,created_at,updated_at,resolved_at
FROM status_incidents
ORDER BY updated_at DESC, created_at DESC
LIMIT 100;
""",
        (),
    )
    items = [
        {
            "id": str(r.get("id") or ""),
            "status": str(r.get("status") or ""),
            "title": str(r.get("title") or ""),
            "severity": str(r.get("severity") or ""),
            "scope": _json_loads(r.get("scope_json"), {}),
            "messageMd": str(r.get("message_md") or ""),
            "createdAt": int(r.get("created_at") or 0) or None,
            "updatedAt": int(r.get("updated_at") or 0) or None,
            "resolvedAt": int(r.get("resolved_at") or 0) or None,
        }
        for r in rows
    ]
    return {"ok": True, "items": items}


@router.post("/api/admin/status/incidents")
def api_admin_status_incidents_create(payload: dict, admin: dict = Depends(require_admin)):
    title = str(payload.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Missing title")
    status = str(payload.get("status") or "investigating").strip().lower() or "investigating"
    severity = str(payload.get("severity") or "minor").strip().lower() or "minor"
    scope_json = json.dumps(payload.get("scope") or {}, ensure_ascii=False)
    message_md = str(payload.get("messageMd") or payload.get("message_md") or "").strip()
    now = ms()
    incident_id = new_id("incident")
    exec_one(
        _DB,
        """
INSERT INTO status_incidents(id,status,title,severity,scope_json,message_md,created_by,created_at,updated_at,resolved_at)
VALUES(?,?,?,?,?,?,?,?,?,?);
""",
        (incident_id, status, title, severity, scope_json, message_md, int(admin["id"]), now, now, None),
    )
    _audit_log(
        actor_user_id=int(admin["id"]),
        target_type="status_incident",
        target_id=incident_id,
        action="create_incident",
        before={},
        after={"status": status, "severity": severity, "title": title},
        reason="admin_create",
    )
    return {"ok": True, "id": incident_id}
