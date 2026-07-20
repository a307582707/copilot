from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from typing import Any
from urllib.parse import quote

import httpx


def _utc_iso8601() -> str:
    # e.g. 2025-12-30T16:30:00Z
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _percent_encode(s: str) -> str:
    # Aliyun OpenAPI uses RFC3986 encoding with some tweaks.
    return quote(str(s), safe="~")


def _sign(access_key_secret: str, method: str, params: dict[str, str]) -> str:
    # https://help.aliyun.com/document_detail/315526.html (Signature algorithm)
    items = sorted(params.items(), key=lambda kv: kv[0])
    canonicalized = "&".join(f"{_percent_encode(k)}={_percent_encode(v)}" for k, v in items)
    string_to_sign = f"{method}&%2F&{_percent_encode(canonicalized)}"
    key = (access_key_secret + "&").encode("utf-8")
    sig = hmac.new(key, string_to_sign.encode("utf-8"), hashlib.sha1).digest()
    return base64.b64encode(sig).decode("ascii")


def _env_required(name: str) -> str:
    v = (os.environ.get(name) or "").strip()
    if not v:
        raise RuntimeError(f"{name} not configured")
    return v


def _env_default(name: str, default: str) -> str:
    v = (os.environ.get(name) or "").strip()
    return v or default


async def send_sms_verification(phone_11: str, template_code: str, template_param: dict[str, Any]) -> dict[str, Any]:
    """
    Send an SMS via Aliyun Dysmsapi RPC.
    Required env:
      - ALIYUN_SMS_ACCESS_KEY_ID
      - ALIYUN_SMS_ACCESS_KEY_SECRET
      - ALIYUN_SMS_SIGN_NAME
    Optional env:
      - ALIYUN_SMS_ENDPOINT (default dysmsapi.aliyuncs.com)
      - ALIYUN_SMS_REGION_ID (default cn-hangzhou)
    """
    ak = _env_required("ALIYUN_SMS_ACCESS_KEY_ID")
    sk = _env_required("ALIYUN_SMS_ACCESS_KEY_SECRET")
    sign_name = _env_required("ALIYUN_SMS_SIGN_NAME")
    endpoint = _env_default("ALIYUN_SMS_ENDPOINT", "dysmsapi.aliyuncs.com")
    region_id = _env_default("ALIYUN_SMS_REGION_ID", "cn-hangzhou")

    params: dict[str, str] = {
        "Action": "SendSms",
        "Version": "2017-05-25",
        "RegionId": region_id,
        "PhoneNumbers": phone_11,
        "SignName": sign_name,
        "TemplateCode": template_code,
        "TemplateParam": json.dumps(template_param, ensure_ascii=False, separators=(",", ":")),
        "Format": "JSON",
        "AccessKeyId": ak,
        "SignatureMethod": "HMAC-SHA1",
        "SignatureNonce": str(uuid.uuid4()),
        "SignatureVersion": "1.0",
        "Timestamp": _utc_iso8601(),
    }
    params["Signature"] = _sign(sk, "GET", params)

    url = f"https://{endpoint}/"
    async with httpx.AsyncClient(timeout=10.0, trust_env=False) as client:
        r = await client.get(url, params=params)
        # Aliyun returns 200 even for most errors, with Code/Message in JSON.
        data = r.json() if r.content else {}
        code = data.get("Code")
        if code and code != "OK":
            raise RuntimeError(f"AliyunSmsError: {code} {data.get('Message','')}".strip())
        return data






