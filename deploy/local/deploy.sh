#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR/deploy/local"

echo "[purpose] 使用 Docker Compose 构建并启动本机 dev 实例（不影响现网 nginx/codesprite-api）"
docker compose up -d --build

echo "[purpose] 自检：/api/health 与首页可达（60s 超时，非交互）"
timeout 60s bash -lc '
  set -euo pipefail
  # NOTE:
  # - 在部分老内核/iptables 环境里，curl 访问 127.0.0.1:18031 可能出现 "Connection reset by peer"
  #   但通过 ::1 或宿主机网卡 IP 访问正常（docker-proxy hairpin 差异）。
  # - 因此这里做一个“多候选 base”探测，保证自检可靠且依然非交互/有超时。
  pick_base() {
    for b in \
      "http://localhost:18031" \
      "http://127.0.0.1:18031" \
      "http://[::1]:18031" \
      "http://$(set -- $(hostname -I 2>/dev/null || true); echo ${1:-127.0.0.1}):18031"
    do
      if curl -fsS --max-time 3 "${b}/api/health" >/dev/null 2>&1; then
        echo "${b}"
        return 0
      fi
    done
    return 1
  }
  base="$(pick_base)"
  echo "[ok] picked base=${base}"
  echo "== GET ${base}/api/health =="
  curl -fsS --max-time 5 "${base}/api/health" | sed -n "1,5p"
  echo
  echo "== GET ${base}/api/public/releases =="
  curl -fsS --max-time 5 "${base}/api/public/releases" | sed -n "1,20p"
  echo
  echo "== GET ${base}/ (html head) =="
  curl -fsS --max-time 5 "${base}/" | sed -n "1,20p"
'

echo
echo "[ok] 已启动：Web+API => http://<本机IP>:18031/"
echo "      健康检查 => http://<本机IP>:18031/api/health"
echo
echo "回滚/停止：cd \"$ROOT_DIR/deploy/local\" && docker compose down"







