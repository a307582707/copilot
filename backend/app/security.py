from __future__ import annotations

import base64
import hashlib
import hmac
import os


def _pbkdf2_sha256(password: str, salt: bytes, iters: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iters)


def hash_password(password: str) -> str:
    """
    PBKDF2-SHA256 password hash stored as:
      pbkdf2_sha256$<iters>$<salt_b64url>$<hash_b64url>
    """
    iters = 200_000
    salt = os.urandom(16)
    digest = _pbkdf2_sha256(password, salt, iters)
    salt_b64 = base64.urlsafe_b64encode(salt).decode("ascii").rstrip("=")
    hash_b64 = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return f"pbkdf2_sha256${iters}${salt_b64}${hash_b64}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters_s, salt_b64, hash_b64 = stored.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        iters = int(iters_s)
        salt = base64.urlsafe_b64decode(salt_b64 + "=" * (-len(salt_b64) % 4))
        expected = base64.urlsafe_b64decode(hash_b64 + "=" * (-len(hash_b64) % 4))
        got = _pbkdf2_sha256(password, salt, iters)
        return hmac.compare_digest(got, expected)
    except Exception:
        return False







