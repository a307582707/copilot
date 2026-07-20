from __future__ import annotations

import json
import os
import secrets
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from .db import connect, fetch_one, init_db
from .saas import current_user

try:
    from cryptography.fernet import Fernet, InvalidToken  # type: ignore
except Exception:  # pragma: no cover
    Fernet = None  # type: ignore
    InvalidToken = Exception  # type: ignore


router = APIRouter()

_DB = connect()
init_db(_DB)

_MAX_STATE_BYTES = 1_000_000  # 1MB JSON blob per space (post-sanitization)
_MAX_NOTE_LEN = 200


def _ms() -> int:
    return int(time.time() * 1000)


def _bad(detail: str):
    raise HTTPException(status_code=400, detail=detail)


def _contains_secret_keys(v: Any) -> bool:
    """
    Inventory state MUST NOT contain any secrets (even encryptedPayload).
    We conservatively reject known secret-like keys.
    """
    secret_keys = {
        "password",
        "privatekey",
        "private_key",
        "passphrase",
        "encryptedpayload",
        "sshkey",
        "ssh_key",
    }
    try:
        if isinstance(v, dict):
            for k, vv in v.items():
                if str(k or "").strip().lower() in secret_keys:
                    return True
                if _contains_secret_keys(vv):
                    return True
            return False
        if isinstance(v, list):
            for it in v:
                if _contains_secret_keys(it):
                    return True
            return False
        return False
    except Exception:
        return True


def _json_bytes(obj: Any) -> bytes:
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return s.encode("utf-8", errors="strict")


def _parse_space_id(space_id: str) -> str:
    sid = str(space_id or "").strip()
    if not sid:
        _bad("Missing spaceId")
    if len(sid) > 80:
        _bad("Invalid spaceId")
    return sid


@router.get("/api/inventory/state")
def api_inventory_get_state(spaceId: str, u: dict = Depends(current_user)):
    uid = int(u["id"])
    sid = _parse_space_id(spaceId)
    # Compatibility: some callers use 'default' as the workspace/space id.
    if sid == "default":
        sid = "host_config_v1"
    row = fetch_one(_DB, "SELECT json,updated_at FROM inventory_state WHERE user_id=? AND space_id=?;", (uid, sid))
    if not row:
        # For the default space, return an explicit empty v2 blob to avoid "spaceId unclear" confusion.
        if sid == "host_config_v1":
            empty_v2 = {
                "version": 2,
                "activeWorkspaceId": None,
                "assets": [],
                "workspaces": [],
                "tags": [],
                "credentials": [],
                "groups": [],
                "hosts": [],
                "activeHostId": None,
            }
            return {"ok": True, "spaceId": sid, "json": empty_v2, "updatedAt": 0}
        raise HTTPException(status_code=404, detail="Not found")
    try:
        blob = json.loads(str(row.get("json") or "{}"))
    except Exception:
        blob = {}
    return {"ok": True, "spaceId": sid, "json": blob, "updatedAt": int(row.get("updated_at") or 0)}


@router.put("/api/inventory/state")
def api_inventory_put_state(payload: dict, u: dict = Depends(current_user)):
    uid = int(u["id"])
    sid = _parse_space_id(str(payload.get("spaceId") or ""))
    blob = payload.get("json")
    if not isinstance(blob, dict):
        _bad("Invalid json")
    if _contains_secret_keys(blob):
        _bad("Secrets are not allowed in inventory state")
    # Basic sanity: v2 only (frontend can evolve, but this blocks accidental garbage)
    if int(blob.get("version") or 0) != 2:
        _bad("Invalid inventory version")

    raw = _json_bytes(blob)
    if len(raw) > _MAX_STATE_BYTES:
        raise HTTPException(status_code=413, detail="Inventory state too large")

    now = _ms()
    ver = int(blob.get("version") or 2)
    # Compatibility with old SQLite (CentOS7): use INSERT OR REPLACE (no UPSERT).
    _DB.execute(
        "INSERT OR REPLACE INTO inventory_state(user_id,space_id,json,version,updated_at) VALUES(?,?,?,?,?);",
        (uid, sid, raw.decode("utf-8", "strict"), ver, now),
    )
    _DB.commit()
    return {"ok": True, "spaceId": sid, "updatedAt": now}


def _load_fernet() -> tuple[Any, list[Any]]:
    if Fernet is None:
        raise HTTPException(status_code=500, detail="cryptography is not installed")
    raw = (os.environ.get("CRED_ENC_KEYS") or os.environ.get("CRED_ENC_KEY") or "").strip()
    if not raw:
        raise HTTPException(status_code=500, detail="CRED_ENC_KEY is not configured")
    keys = [x.strip() for x in raw.split(",") if x.strip()]
    if not keys:
        raise HTTPException(status_code=500, detail="CRED_ENC_KEY is not configured")
    ferns = []
    for k in keys[:5]:
        try:
            ferns.append(Fernet(k.encode("utf-8")))
        except Exception:
            raise HTTPException(status_code=500, detail="Invalid CRED_ENC_KEY format (expect Fernet urlsafe base64)")
    return ferns[0], ferns


def encrypt_secret(payload: dict) -> str:
    active, _ = _load_fernet()
    raw = _json_bytes(payload)
    token = active.encrypt(raw)
    return token.decode("utf-8", errors="strict")


def decrypt_secret(token: str) -> dict:
    _, keys = _load_fernet()
    t = str(token or "").strip()
    if not t:
        _bad("Empty token")
    last_err: Exception | None = None
    for f in keys:
        try:
            raw = f.decrypt(t.encode("utf-8"), ttl=None)
            obj = json.loads(raw.decode("utf-8", errors="strict"))
            return obj if isinstance(obj, dict) else {}
        except InvalidToken as e:  # type: ignore
            last_err = e
            continue
        except Exception as e:
            last_err = e
            continue
    raise HTTPException(status_code=400, detail=f"Invalid credential token: {last_err.__class__.__name__ if last_err else 'InvalidToken'}")


def get_decrypted_credential(*, user_id: int, credential_id: str) -> dict:
    cid = str(credential_id or "").strip()
    if not cid:
        _bad("Missing credentialId")
    if len(cid) > 120:
        _bad("Invalid credentialId")
    row = fetch_one(
        _DB,
        "SELECT id,kind,enc_payload FROM inventory_credentials WHERE user_id=? AND id=?;",
        (int(user_id), cid),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Credential not found")
    kind = str(row.get("kind") or "").strip()
    enc = str(row.get("enc_payload") or "")
    obj = decrypt_secret(enc)
    obj["kind"] = kind
    return obj


@router.post("/api/inventory/credentials/save")
def api_inventory_credentials_save(payload: dict, u: dict = Depends(current_user)):
    uid = int(u["id"])
    # Compatibility: accept kind/type aliases and some legacy payload shapes.
    raw_kind = payload.get("kind")
    if not raw_kind:
        raw_kind = payload.get("type")
    kind = str(raw_kind or "").strip().lower()
    if kind == "sshkey":
        kind = "ssh_key"
    if kind not in {"password", "ssh_key"}:
        # best-effort inference
        if payload.get("password") or (isinstance(payload.get("secret"), dict) and (payload.get("secret") or {}).get("password")):
            kind = "password"
        elif payload.get("privateKey") or payload.get("private_key") or payload.get("sshKey") or payload.get("ssh_key"):
            kind = "ssh_key"
        else:
            _bad("Invalid kind")

    secret = payload.get("secret") or {}
    if not isinstance(secret, dict):
        secret = {}

    # Legacy: allow passing secret fields at the top-level.
    if not secret:
        if kind == "password":
            secret = {"password": payload.get("password")}
        else:
            secret = {
                "privateKey": payload.get("privateKey") or payload.get("private_key") or payload.get("sshKey") or payload.get("ssh_key"),
                "passphrase": payload.get("passphrase"),
            }

    if not isinstance(secret, dict):
        _bad("Invalid secret")
    note = str(payload.get("note") or "").strip()
    if len(note) > _MAX_NOTE_LEN:
        _bad("Note too long")

    if kind == "password":
        pwd = str(secret.get("password") or "")
        if not pwd.strip():
            _bad("Missing password")
        if len(pwd) > 4096:
            _bad("Password too long")
        plain = {"kind": "password", "password": pwd}
    else:
        pk = str(secret.get("privateKey") or secret.get("private_key") or "")
        if not pk.strip():
            _bad("Missing privateKey")
        if len(pk) > 200_000:
            _bad("PrivateKey too long")
        pp = str(secret.get("passphrase") or "")
        if pp and len(pp) > 4096:
            _bad("Passphrase too long")
        plain = {"kind": "ssh_key", "privateKey": pk, "passphrase": pp or None}

    enc = encrypt_secret(plain)
    now = _ms()
    cid = "cred_" + secrets.token_urlsafe(18)
    meta = {"v": 1, "note": note[:_MAX_NOTE_LEN] if note else None}
    _DB.execute(
        "INSERT INTO inventory_credentials(id,user_id,kind,enc_payload,meta_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?);",
        (cid, uid, kind, enc, json.dumps(meta, ensure_ascii=False) if meta else None, now, now),
    )
    _DB.commit()
    return {"ok": True, "credentialId": cid, "kind": kind, "createdAt": now, "updatedAt": now}


@router.delete("/api/inventory/credentials/{credential_id}")
def api_inventory_credentials_delete(credential_id: str, u: dict = Depends(current_user)):
    uid = int(u["id"])
    cid = str(credential_id or "").strip()
    if not cid:
        raise HTTPException(status_code=404, detail="Not found")
    cur = _DB.execute("DELETE FROM inventory_credentials WHERE user_id=? AND id=?;", (uid, cid))
    _DB.commit()
    return {"ok": True, "deleted": int(cur.rowcount or 0)}

