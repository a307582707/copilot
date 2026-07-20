#!/usr/bin/env python3
"""
Generate an Alibaba Cloud CDN Type A signed URL.

Usage:
  python3 scripts/ops/generate_cdn_signed_url.py \
    --url "http://video.carpigiani.com/path/to/video.mp4" \
    --key "YOUR_AUTH_KEY" \
    --ttl 31536000
"""

from __future__ import annotations

import argparse
import hashlib
import random
import time
from urllib.parse import quote, urlparse, urlunparse


def build_signed_url(raw_url: str, key: str, ttl: int, uid: str = "0") -> str:
    parsed = urlparse(raw_url)
    if not parsed.scheme or not parsed.netloc or not parsed.path:
        raise ValueError("url must include scheme, host, and path")

    timestamp = str(int(time.time()))
    rand = str(random.randint(100000, 999999))
    # CDN auth should sign the exact request path. Percent-encode spaces and
    # other non-safe characters so the generated URL matches what browsers send.
    path = quote(parsed.path, safe="/-_.~")
    sign_src = f"{path}-{timestamp}-{rand}-{uid}-{key}"
    md5hash = hashlib.md5(sign_src.encode("utf-8")).hexdigest()
    auth_key = f"{timestamp}-{rand}-{uid}-{md5hash}"

    query = f"auth_key={auth_key}"
    return urlunparse((parsed.scheme, parsed.netloc, path, "", query, ""))


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Alibaba CDN Type A signed URL")
    parser.add_argument("--url", required=True, help="Original CDN URL")
    parser.add_argument("--key", required=True, help="CDN auth_key1 value")
    parser.add_argument("--ttl", type=int, default=31536000, help="CDN auth TTL in seconds")
    parser.add_argument("--uid", default="0", help="Optional uid field in auth_key")
    args = parser.parse_args()

    signed_url = build_signed_url(args.url, args.key, args.ttl, args.uid)
    print(signed_url)
    print(f"# TTL reminder: this URL expires in {args.ttl} seconds")


if __name__ == "__main__":
    main()
