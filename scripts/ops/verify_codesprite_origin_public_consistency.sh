#!/usr/bin/env bash
set -euo pipefail

host="${1:-codesprite.example.com}"
local_base="https://127.0.0.1"
public_base="https://${host}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

fetch_local() {
  local path="$1"
  local out="$2"
  curl -kfsSL -H "Host: ${host}" "${local_base}${path}" -o "${out}"
}

fetch_public() {
  local path="$1"
  local out="$2"
  curl -fsSL "${public_base}${path}" -o "${out}"
}

extract_asset_path() {
  local html_file="$1"
  python3 - "${html_file}" <<'PY'
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8", errors="ignore")
m = re.search(r'<script[^>]+src="((?:[^"]*/)?assets/[^"]+\.js)"', text)
print(m.group(1) if m else "")
PY
}

sha_file() {
  local file="$1"
  python3 - "${file}" <<'PY'
import hashlib
import sys
from pathlib import Path

raw = Path(sys.argv[1]).read_bytes()
print(hashlib.sha256(raw).hexdigest())
PY
}

compare_pair() {
  local label="$1"
  local local_file="$2"
  local public_file="$3"
  local local_sha public_sha
  local_sha="$(sha_file "${local_file}")"
  public_sha="$(sha_file "${public_file}")"
  echo "[check] ${label}"
  echo "  local : ${local_sha}"
  echo "  public: ${public_sha}"
  if [[ "${local_sha}" != "${public_sha}" ]]; then
    echo "[mismatch] ${label} differs between origin and public path" >&2
    return 1
  fi
}

echo "[info] host=${host}"

fetch_local "/auth/login" "${tmp_dir}/local-login.html"
fetch_public "/auth/login" "${tmp_dir}/public-login.html"
compare_pair "/auth/login html" "${tmp_dir}/local-login.html" "${tmp_dir}/public-login.html"

local_asset="$(extract_asset_path "${tmp_dir}/local-login.html")"
public_asset="$(extract_asset_path "${tmp_dir}/public-login.html")"

if [[ -z "${local_asset}" || -z "${public_asset}" ]]; then
  echo "[error] failed to extract built asset path from login page" >&2
  exit 1
fi

echo "[info] local asset path : ${local_asset}"
echo "[info] public asset path: ${public_asset}"

fetch_local "${local_asset}" "${tmp_dir}/local-asset.js"
fetch_public "${public_asset}" "${tmp_dir}/public-asset.js"
compare_pair "login js asset" "${tmp_dir}/local-asset.js" "${tmp_dir}/public-asset.js"

fetch_local "/api/health" "${tmp_dir}/local-health.json"
fetch_public "/api/health" "${tmp_dir}/public-health.json"
compare_pair "/api/health body" "${tmp_dir}/local-health.json" "${tmp_dir}/public-health.json"

echo "[ok] origin and public responses are consistent"
