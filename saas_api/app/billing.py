from __future__ import annotations

import os
from dataclasses import dataclass

from .accounting import beta_mode_enabled, beta_quota_status, beta_remaining_charge_cents, estimate_llm_cost_cents, get_user_balance_cents, min_balance_cents
from .db import exec_one, fetch_one


@dataclass(frozen=True)
class BillingDecision:
    ok: bool
    reason: str = ""
    balance_cents: int = 0


def can_start_llm_call(conn, *, user_id: int) -> BillingDecision:
    """
    Gate for starting an LLM request.
    P0: only checks a minimum balance threshold (env-driven).
    Later can be extended with subscription/trial rules.
    """
    bal = get_user_balance_cents(conn, user_id)
    min_bal = min_balance_cents()
    if min_bal > 0 and bal < min_bal:
        return BillingDecision(ok=False, reason="Insufficient balance", balance_cents=int(bal))
    if beta_mode_enabled():
        quota = beta_quota_status(conn, user_id)
        if not quota.get("allowed"):
            reason = "Beta quota exhausted"
            if int(quota.get("siteDailyRemainingCents") or 0) <= 0:
                reason = "Daily site beta budget exhausted"
            elif int(quota.get("dailyRemainingCents") or 0) <= 0:
                reason = "Daily beta quota exhausted"
            elif int(quota.get("monthlyRemainingCents") or 0) <= 0:
                reason = "Monthly beta quota exhausted"
            return BillingDecision(ok=False, reason=reason, balance_cents=int(bal))
    return BillingDecision(ok=True, reason="", balance_cents=int(bal))


def record_llm_usage(
    conn,
    *,
    request_id: str,
    user_id: int,
    model: str,
    upstream: str,
    status: str,
    prompt_chars: int,
    completion_chars: int,
    prompt_tokens: int | None,
    completion_tokens: int | None,
    cost_cents: int,
    started_at: int,
    finished_at: int,
    error: str = "",
) -> None:
    """
    Insert a row into llm_usage (idempotency via primary key).
    """
    # Best-effort truncate error to keep DB small
    err = (error or "")[:500]
    try:
        conn.execute(
            """
INSERT OR IGNORE INTO llm_usage(
  id,user_id,model,upstream,status,prompt_chars,completion_chars,prompt_tokens,completion_tokens,cost_cents,started_at,finished_at,error
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?);
""",
            (
                request_id,
                int(user_id),
                (model or "")[:200],
                (upstream or "")[:80],
                (status or "error")[:20],
                int(prompt_chars),
                int(completion_chars),
                int(prompt_tokens) if isinstance(prompt_tokens, int) else None,
                int(completion_tokens) if isinstance(completion_tokens, int) else None,
                int(cost_cents),
                int(started_at),
                int(finished_at),
                err,
            ),
        )
        conn.commit()
    except Exception:
        # Do not break chat if accounting write fails; ops can inspect logs/DB.
        try:
            conn.rollback()
        except Exception:
            pass


def charge_llm_usage(
    conn,
    *,
    user_id: int,
    request_id: str,
    model: str,
    prompt_chars: int,
    completion_chars: int,
    created_at: int,
) -> int:
    """
    Write a negative ledger entry for this LLM usage (idempotent).

    Returns charged cost cents (>=0).
    """
    cost = estimate_llm_cost_cents(model=model, prompt_chars=prompt_chars, completion_chars=completion_chars)
    cost = int(max(0, cost))
    if cost <= 0:
        return 0

    # Allow disabling actual charging while still recording usage.
    v = (os.environ.get("BILLING_ENABLED") or "").strip().lower()
    if v and v not in {"1", "true", "yes", "y", "on"}:
        return 0

    if beta_mode_enabled():
        remaining = beta_remaining_charge_cents(conn, user_id)
        if remaining <= 0:
            return 0
        cost = min(cost, remaining)

    # Idempotent insert: ledger unique index (user_id, entry_type, ref_id) prevents duplicates.
    try:
        conn.execute("BEGIN IMMEDIATE;")
        conn.execute(
            """
INSERT OR IGNORE INTO ledger(id,user_id,entry_type,amount_cents,period,ref_id,created_at)
VALUES(?,?,?,?,?,?,?);
""",
            (
                request_id,  # reuse request id as ledger id (stable)
                int(user_id),
                "llm_usage",
                -int(cost),
                "",  # period optional (can be filled later)
                request_id,
                int(created_at),
            ),
        )
        conn.commit()
        return cost
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        return 0


def get_llm_usage(conn, *, request_id: str) -> dict | None:
    return fetch_one(conn, "SELECT * FROM llm_usage WHERE id=?;", (request_id,))

