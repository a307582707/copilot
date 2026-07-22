#!/usr/bin/env bash
# Sync docs/wiki/*.md to the GitHub Wiki remote (copilot.wiki.git).
#
# One-time bootstrap (required by GitHub):
#   1. Open https://github.com/a307582707/copilot/wiki
#   2. Click "Create the first page", save any stub Home page
#   3. Re-run this script
#
# Usage (from repo root):
#   ./scripts/ops/sync_github_wiki.sh
#   GITHUB_TOKEN=... ./scripts/ops/sync_github_wiki.sh   # optional explicit token

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/docs/wiki"
OWNER_REPO="a307582707/copilot"
WIKI_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codesprite-wiki.XXXXXX")"
cleanup() { rm -rf "$WIKI_DIR"; }
trap cleanup EXIT

if [[ ! -d "$SRC" ]]; then
  echo "missing wiki source: $SRC" >&2
  exit 1
fi

TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [[ -z "$TOKEN" ]] && command -v gh >/dev/null 2>&1; then
  TOKEN="$(gh auth token 2>/dev/null || true)"
fi

if [[ -n "$TOKEN" ]]; then
  WIKI_URL="https://x-access-token:${TOKEN}@github.com/${OWNER_REPO}.wiki.git"
else
  WIKI_URL="https://github.com/${OWNER_REPO}.wiki.git"
fi

echo "[info] cloning wiki remote..."
if ! git clone --depth 1 "$WIKI_URL" "$WIKI_DIR" 2>/tmp/codesprite-wiki-clone.err; then
  echo "[error] cannot clone ${OWNER_REPO}.wiki.git" >&2
  echo "GitHub only creates the wiki git remote after the first page exists." >&2
  echo "Open https://github.com/${OWNER_REPO}/wiki , create Home once, then re-run." >&2
  cat /tmp/codesprite-wiki-clone.err >&2 || true
  exit 2
fi

cd "$WIKI_DIR"
# Prefer master (GitHub wiki default); fall back to main.
git checkout master 2>/dev/null || git checkout -B master

# Copy pages (exclude docs/wiki/README.md which is repo-only)
shopt -s nullglob
for f in "$SRC"/*.md "$SRC"/_Sidebar.md; do
  base="$(basename "$f")"
  [[ "$base" == "README.md" ]] && continue
  cp "$f" "$WIKI_DIR/$base"
done

git add -A
if git diff --cached --quiet; then
  echo "[ok] wiki already up to date"
  exit 0
fi

git -c user.email="cursoragent@cursor.com" -c user.name="Cursor Agent" \
  commit -m "docs: sync CodeSprite wiki from docs/wiki"

git push origin HEAD
echo "[ok] wiki synced: https://github.com/${OWNER_REPO}/wiki"
