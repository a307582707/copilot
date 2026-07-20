from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any

from .db import fetch_all, fetch_one


def trial_days() -> int:
    v = (os.environ.get("TRIAL_DAYS") or "").strip()
    try:
        n = int(v)
        return n if n > 0 else 7
    except Exception:
        return 7


def ms() -> int:
    return int(time.time())


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _env_bool(name: str, default: bool = False) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "y", "on"}:
        return True
    if raw in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _env_int(name: str, default: int, *, minimum: int = 0) -> int:
    raw = (os.environ.get(name) or "").strip()
    try:
        return max(minimum, int(raw))
    except Exception:
        return max(minimum, int(default))


def mask_email(email: str) -> str:
    if "@" not in email:
        return email
    name, dom = email.split("@", 1)
    if len(name) <= 2:
        return name[:1] + "***@" + dom
    return name[:2] + "***@" + dom


def sum_cents(rows: list[dict[str, Any]], key: str) -> int:
    total = 0
    for r in rows:
        v = r.get(key)
        if isinstance(v, int):
            total += v
    return total


def get_user_balance_cents(conn, user_id: int) -> int:
    # Use SQL aggregation for efficiency.
    r = fetch_one(conn, "SELECT COALESCE(SUM(amount_cents),0) AS s FROM ledger WHERE user_id=?;", (user_id,))
    return int((r or {}).get("s") or 0)


def beta_mode_enabled() -> bool:
    # Covixa is being launched as a controlled free beta by default.
    return _env_bool("COVIXA_BETA_MODE", True)


def billing_enabled() -> bool:
    v = (os.environ.get("BILLING_ENABLED") or "").strip().lower()
    if v:
        return v in {"1", "true", "yes", "y", "on"}
    return beta_mode_enabled()


def chat_require_auth() -> bool:
    v = (os.environ.get("CHAT_REQUIRE_AUTH") or "").strip().lower()
    return v in {"1", "true", "yes", "y", "on"}


def min_balance_cents() -> int:
    v = (os.environ.get("BILLING_MIN_BALANCE_CENTS") or "").strip()
    try:
        n = int(v)
        return max(0, n)
    except Exception:
        return 1 if beta_mode_enabled() else 0


def beta_initial_credit_cents() -> int:
    return _env_int("BETA_INITIAL_CREDIT_CENTS", 3000)


def beta_user_daily_budget_cents() -> int:
    return _env_int("BETA_USER_DAILY_BUDGET_CENTS", 500)


def beta_user_monthly_budget_cents() -> int:
    return _env_int("BETA_USER_MONTHLY_BUDGET_CENTS", 3000)


def beta_site_daily_budget_cents() -> int:
    return _env_int("BETA_SITE_DAILY_BUDGET_CENTS", 5000)


def beta_max_output_chars() -> int:
    return _env_int("BETA_MAX_OUTPUT_CHARS", 8000)


def beta_max_concurrent_per_user() -> int:
    return _env_int("BETA_MAX_CONCURRENT_PER_USER", 1, minimum=1)


def _period_bounds(now: int | None = None) -> tuple[int, int, int, int]:
    ts = int(now or time.time())
    lt = time.localtime(ts)
    day_start = int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, -1, -1, -1)))
    if lt.tm_mon == 12:
        next_month = (lt.tm_year + 1, 1)
    else:
        next_month = (lt.tm_year, lt.tm_mon + 1)
    month_start = int(time.mktime((lt.tm_year, lt.tm_mon, 1, 0, 0, 0, -1, -1, -1)))
    month_end = int(time.mktime((next_month[0], next_month[1], 1, 0, 0, 0, -1, -1, -1)))
    return day_start, day_start + 24 * 3600, month_start, month_end


def get_llm_spend_cents(conn, *, user_id: int | None = None, start: int, end: int) -> int:
    args: list[object] = [int(start), int(end)]
    user_clause = ""
    if user_id is not None:
        user_clause = " AND user_id=?"
        args.append(int(user_id))
    r = fetch_one(
        conn,
        "SELECT COALESCE(SUM(-amount_cents),0) AS s FROM ledger WHERE entry_type='llm_usage' AND amount_cents<0 AND created_at>=? AND created_at<?"
        + user_clause
        + ";",
        tuple(args),
    )
    return int((r or {}).get("s") or 0)


def beta_quota_status(conn, user_id: int, *, now: int | None = None) -> dict[str, Any]:
    day_start, day_end, month_start, month_end = _period_bounds(now)
    daily_budget = beta_user_daily_budget_cents()
    monthly_budget = beta_user_monthly_budget_cents()
    site_daily_budget = beta_site_daily_budget_cents()
    daily_spend = get_llm_spend_cents(conn, user_id=user_id, start=day_start, end=day_end)
    monthly_spend = get_llm_spend_cents(conn, user_id=user_id, start=month_start, end=month_end)
    site_daily_spend = get_llm_spend_cents(conn, start=day_start, end=day_end)
    daily_remaining = max(0, daily_budget - daily_spend) if daily_budget > 0 else 10**12
    monthly_remaining = max(0, monthly_budget - monthly_spend) if monthly_budget > 0 else 10**12
    site_daily_remaining = max(0, site_daily_budget - site_daily_spend) if site_daily_budget > 0 else 10**12
    allowed = (not beta_mode_enabled()) or (daily_remaining > 0 and monthly_remaining > 0 and site_daily_remaining > 0)
    return {
        "enabled": beta_mode_enabled(),
        "allowed": bool(allowed),
        "dailyBudgetCents": int(daily_budget),
        "dailySpendCents": int(daily_spend),
        "dailyRemainingCents": int(daily_remaining if daily_budget > 0 else 0),
        "monthlyBudgetCents": int(monthly_budget),
        "monthlySpendCents": int(monthly_spend),
        "monthlyRemainingCents": int(monthly_remaining if monthly_budget > 0 else 0),
        "siteDailyBudgetCents": int(site_daily_budget),
        "siteDailySpendCents": int(site_daily_spend),
        "siteDailyRemainingCents": int(site_daily_remaining if site_daily_budget > 0 else 0),
        "maxOutputChars": beta_max_output_chars(),
    }


def beta_remaining_charge_cents(conn, user_id: int) -> int:
    if not beta_mode_enabled():
        return 10**12
    q = beta_quota_status(conn, user_id)
    balance = get_user_balance_cents(conn, user_id)
    remaining = min(
        int(q.get("dailyRemainingCents") or 0),
        int(q.get("monthlyRemainingCents") or 0),
        int(q.get("siteDailyRemainingCents") or 0),
        int(balance),
    )
    return max(0, int(remaining))


def ensure_beta_credit(conn, *, user_id: int, created_at: int | None = None) -> bool:
    if not beta_mode_enabled():
        return False
    credit = beta_initial_credit_cents()
    if credit <= 0:
        return False
    ts = int(created_at or ms())
    ref_id = "beta_credit:v1"
    entry_id = new_id("beta")
    try:
        cur = conn.execute(
            """
INSERT OR IGNORE INTO ledger(id,user_id,entry_type,amount_cents,period,ref_id,created_at)
VALUES(?,?,?,?,?,?,?);
""",
            (entry_id, int(user_id), "beta_credit", int(credit), "beta", ref_id, ts),
        )
        conn.commit()
        return int(getattr(cur, "rowcount", 0) or 0) > 0
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        return False


def load_pricing() -> dict[str, Any]:
    """
    Billing pricing config.

    Env: BILLING_PRICING_JSON (optional)
      {
        "default": {"prompt_per_1k_chars_cents": 2, "completion_per_1k_chars_cents": 6, "min_charge_cents": 1},
        "qwen-plus": {"prompt_per_1k_chars_cents": 3, "completion_per_1k_chars_cents": 9}
      }
    """
    raw = (os.environ.get("BILLING_PRICING_JSON") or "").strip()
    if not raw:
        if beta_mode_enabled():
            return {
                "default": {
                    "prompt_per_1k_chars_cents": 2,
                    "completion_per_1k_chars_cents": 6,
                    "min_charge_cents": 1,
                }
            }
        return {
            "default": {
                "prompt_per_1k_chars_cents": 0,
                "completion_per_1k_chars_cents": 0,
                "min_charge_cents": 0,
            }
        }
    try:
        obj = json.loads(raw)
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def _pick_pricing(model: str) -> dict[str, int]:
    cfg = load_pricing()
    m = (model or "").strip()
    d = cfg.get("default") if isinstance(cfg, dict) else None
    chosen = cfg.get(m) if isinstance(cfg, dict) and m in cfg else None
    src = chosen if isinstance(chosen, dict) else (d if isinstance(d, dict) else {})

    def _i(name: str, default: int) -> int:
        v = src.get(name)
        if isinstance(v, int):
            return v
        try:
            return int(v)
        except Exception:
            return default

    return {
        "prompt_per_1k_chars_cents": max(0, _i("prompt_per_1k_chars_cents", 0)),
        "completion_per_1k_chars_cents": max(0, _i("completion_per_1k_chars_cents", 0)),
        "min_charge_cents": max(0, _i("min_charge_cents", 0)),
    }


def estimate_llm_cost_cents(*, model: str, prompt_chars: int, completion_chars: int) -> int:
    """
    P0 pricing: charge by character length (fallback when upstream token usage is not available).
    """
    p = _pick_pricing(model)
    pc = max(0, int(prompt_chars))
    cc = max(0, int(completion_chars))
    cost = 0
    # round up per 1k chars to avoid undercharge on short calls
    if p["prompt_per_1k_chars_cents"] > 0 and pc > 0:
        cost += ((pc + 999) // 1000) * p["prompt_per_1k_chars_cents"]
    if p["completion_per_1k_chars_cents"] > 0 and cc > 0:
        cost += ((cc + 999) // 1000) * p["completion_per_1k_chars_cents"]
    if cost > 0 and p["min_charge_cents"] > 0:
        cost = max(cost, p["min_charge_cents"])
    return int(cost)


def admin_stats(conn) -> dict[str, Any]:
    users = fetch_one(conn, "SELECT COUNT(1) AS n FROM users;", ())
    paid_orders = fetch_one(conn, "SELECT COUNT(1) AS n FROM recharge_orders WHERE status IN ('paid','credited');", ())
    sum_paid = fetch_one(conn, "SELECT COALESCE(SUM(amount_cents),0) AS s FROM recharge_orders WHERE status IN ('paid','credited');", ())
    sum_ledger = fetch_one(conn, "SELECT COALESCE(SUM(amount_cents),0) AS s FROM ledger;", ())
    return {
        "usersTotal": int((users or {}).get("n") or 0),
        "paidOrdersTotal": int((paid_orders or {}).get("n") or 0),
        "rechargeCentsTotal": int((sum_paid or {}).get("s") or 0),
        "ledgerCentsTotal": int((sum_ledger or {}).get("s") or 0),
    }