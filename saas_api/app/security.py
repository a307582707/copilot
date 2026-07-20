from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any


def now_ts() -> int:
    return int(time.time())


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * ((4 - (len(s) % 4)) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("ascii"))


_s = (os.environ.get("AUTH_SECRET") or "").strip()
if not _s:
    _env = (os.environ.get("APP_ENV") or os.environ.get("ENV") or os.environ.get("NODE_ENV") or "").strip().lower()
    if _env in {"prod", "production"}:
        raise RuntimeError("AUTH_SECRET must be configured in production")
    # dev fallback; for production, set AUTH_SECRET
    _s = "dev-" + secrets.token_urlsafe(32)
_AUTH_SECRET = _s.encode("utf-8")


def auth_secret() -> bytes:
    # IMPORTANT: must be stable across requests; do NOT generate per call.
    return _AUTH_SECRET


def hash_password(password: str, salt_b64: str | None = None) -> tuple[str, str]:
    if salt_b64:
        salt = base64.b64decode(salt_b64.encode("ascii"))
    else:
        salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120_000)
    return base64.b64encode(dk).decode("ascii"), base64.b64encode(salt).decode("ascii")


def verify_password(password: str, password_hash: str, salt_b64: str) -> bool:
    dk, _ = hash_password(password, salt_b64=salt_b64)
    return hmac.compare_digest(dk, password_hash)


def hash_otp(code: str, salt_b64: str | None = None) -> tuple[str, str]:
    """
    Hash short-lived one-time codes (SMS/email).
    Uses a per-code random salt plus AUTH_SECRET as a pepper.
    """
    c = (code or "").strip()
    if not c:
        raise ValueError("empty code")
    if salt_b64:
        salt = base64.b64decode(salt_b64.encode("ascii"))
    else:
        salt = secrets.token_bytes(16)
    # Fast enough but not trivial to brute-force at scale; OTP is also rate-limited in DB.
    dk = hashlib.pbkdf2_hmac("sha256", c.encode("utf-8"), salt + auth_secret(), 50_000)
    return base64.b64encode(dk).decode("ascii"), base64.b64encode(salt).decode("ascii")


def verify_otp(code: str, code_hash: str, salt_b64: str) -> bool:
    dk, _ = hash_otp(code, salt_b64=salt_b64)
    return hmac.compare_digest(dk, code_hash)


def sign_token(payload: dict[str, Any], expires_in_sec: int) -> str:
    header = {"alg": "HS256", "typ": "CS1"}
    p = dict(payload)
    p["exp"] = now_ts() + int(expires_in_sec)
    h = _b64url(json.dumps(header, separators=(",", ":"), ensure_ascii=True).encode("utf-8"))
    b = _b64url(json.dumps(p, separators=(",", ":"), ensure_ascii=True).encode("utf-8"))
    msg = f"{h}.{b}".encode("ascii")
    sig = _b64url(hmac.new(auth_secret(), msg, hashlib.sha256).digest())
    return f"{h}.{b}.{sig}"


def verify_token(token: str) -> dict[str, Any] | None:
    parts = token.split(".")
    if len(parts) != 3:
        return None
    h, b, sig = parts
    msg = f"{h}.{b}".encode("ascii")
    expect = _b64url(hmac.new(auth_secret(), msg, hashlib.sha256).digest())
    if not hmac.compare_digest(expect, sig):
        return None
    try:
        payload = json.loads(_b64url_decode(b).decode("utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    exp = payload.get("exp")
    if isinstance(exp, int) and exp > 0 and now_ts() >= exp:
        return None
    return payload