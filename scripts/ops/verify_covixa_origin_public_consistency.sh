#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${script_dir}/verify_codesprite_origin_public_consistency.sh" "${1:-covixa.example.com}"
