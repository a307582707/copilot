# 部署要点

完整步骤、备份、升级与回滚请以仓库根目录 [`DEPLOY.md`](https://github.com/a307582707/copilot/blob/main/DEPLOY.md) 为准。此处仅作速查。

## 环境要求

- Linux x86_64（生产建议）
- Docker Engine 24+、Compose v2
- ≥ 4 GB 内存、≥ 10 GB 磁盘（视模型与数据量增加）
- 可选：Ollama 或其他 OpenAI-compatible 服务

## 本地 Compose

```bash
cd deploy/local
cp .env.example .env
docker compose up -d --build
curl -fsS http://127.0.0.1:18031/api/health
```

## 生产 Compose

```bash
cd deploy/prod
cp .env.example .env
docker compose up -d --build
curl -fsS http://127.0.0.1:18030/api/health
```

应用端口默认只绑本机，应由 Nginx / Caddy 等提供 HTTPS。示例配置：`deploy/nginx/codesprite.example.conf`。

## 必须替换的密钥

- `AUTH_SECRET`
- `CRED_ENC_KEY`
- `ADMIN_PASS`（及可选 `ADMIN_EMAIL`）
- `MYSQL_ROOT_PASSWORD` / `MYSQL_PASSWORD`

生产保持 `COOKIE_SECURE=1`，并通过 HTTPS 暴露。

## MySQL 时区

- 默认生产栈：UTC（`+00:00`）
- 需要上海时区 + binlog：可选 `deploy/prod/docker-compose.mysql.yml`

## 安全

见 [`SECURITY.md`](https://github.com/a307582707/copilot/blob/main/SECURITY.md)。请使用 GitHub 私密漏洞报告，勿在公开 Issue 中粘贴凭据或利用细节。
