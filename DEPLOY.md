# 部署指南

本文提供可重复、可验证、可回滚的 CodeSprite 部署方式。所有示例使用占位域名和本地目录，不对应任何真实生产环境。

## 1. 部署前检查

建议环境：

- Linux x86_64
- Docker Engine 24+
- Docker Compose v2
- 至少 4 GB 可用内存和 10 GB 可用磁盘
- 可选：Ollama 或其他 OpenAI-compatible 模型服务

检查版本：

```bash
docker --version
docker compose version
git --version
```

生产环境需要提前准备：

- DNS 与 HTTPS 证书
- 独立的数据库和应用数据目录
- 随机生成并安全保存的 `AUTH_SECRET`、`CRED_ENC_KEY` 和数据库密码
- 数据库、应用数据及 `.env` 的备份位置

## 2. 本地一体化部署

```bash
cd /path/to/codesprite/deploy/local
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，替换所有 `replace-with-*`。随机值可使用：

```bash
openssl rand -hex 32
openssl rand -base64 32 | tr '+/' '-_'
```

启动并验证：

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:18031/api/health
```

访问 `http://127.0.0.1:18031/`。停止时不要添加 `-v`，否则会删除命名数据卷：

```bash
docker compose down
```

## 3. 生产 Docker Compose 部署

### 3.1 准备配置

```bash
cd /path/to/codesprite/deploy/prod
cp .env.example .env
chmod 600 .env
```

编辑 `.env`：

- `AUTH_SECRET`：至少 32 字节的随机值，部署后保持稳定
- `CRED_ENC_KEY`：Fernet key，部署后保持稳定
- `ADMIN_PASS`：初始管理员密码（Compose 会同时注入 `ADMIN_PASSWORD`；也可用 `ADMIN_EMAIL` 覆盖默认 `admin@localhost`）
- `MYSQL_ROOT_PASSWORD`、`MYSQL_PASSWORD`：独立强密码
- `APP_DATA_DIR`、`MYSQL_DATA_DIR`：宿主机持久化目录
- `OLLAMA_BASE_URL`：模型服务地址

创建并保护持久化目录：

```bash
install -d -m 750 ./data/app ./data/mysql ./backups
```

### 3.2 启动

默认使用 `docker-compose.yml`（已内置 MySQL）。若只要独立 MySQL（含 binlog、`+08:00` 时区），可用可选文件 `docker-compose.mysql.yml`。

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:18030/api/health
```

应用端口默认只绑定 `127.0.0.1:18030`，应由同机 Nginx、Caddy 或负载均衡器提供 HTTPS。

### 3.3 Nginx

复制并修改示例：

```bash
sudo cp ../nginx/codesprite.example.conf /etc/nginx/conf.d/codesprite.conf
sudo nginx -t
sudo systemctl reload nginx
```

将 `codesprite.example.com`、证书方式和静态目录改成实际值。若由应用容器直接托管前端，可删除示例中的静态 `root`，把 `/` 与 `/api/` 一并反向代理到 `127.0.0.1:18030`。

公网验证：

```bash
curl -fsS https://codesprite.example.com/api/health
curl -fsS https://codesprite.example.com/ >/dev/null
```

## 4. 配置 AI 服务

默认 Compose 访问宿主机 Ollama：

```env
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

也可以在 `.env` 中配置 OpenAI-compatible 上游：

```env
LLM_BASE_URL=https://api.example.com/v1
LLM_API_KEY=replace-with-provider-key
LLM_MODEL=replace-with-model-name
```

更新后重建应用容器：

```bash
docker compose up -d --build app
curl -fsS http://127.0.0.1:18030/api/model/health
```

## 5. 备份

每次升级前同时备份 MySQL、应用数据和 `.env`。

```bash
cd /path/to/codesprite/deploy/prod
ts="$(date +%Y%m%d%H%M%S)"
set -a
source ./.env
set +a

docker compose exec -T mysql \
  mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" \
  --single-transaction --routines --events "$MYSQL_DATABASE" \
  > "./backups/mysql-${ts}.sql"

tar -C "$APP_DATA_DIR" -czf "./backups/app-data-${ts}.tar.gz" .
cp -a .env "./backups/env-${ts}.bak"
chmod 600 "./backups/env-${ts}.bak"
```

验证备份非空：

```bash
test -s "./backups/mysql-${ts}.sql"
test -s "./backups/app-data-${ts}.tar.gz"
```

备份目录可能包含敏感数据，不应提交 Git，也不应放到公开对象存储。

## 6. 升级

升级前记录当前版本并完成第 5 节备份：

```bash
cd /path/to/codesprite
git rev-parse HEAD
docker inspect codesprite-app --format '{{.Image}}'
```

拉取目标版本后：

```bash
git pull --ff-only
cd deploy/prod
docker compose build --pull app
docker compose up -d app
docker compose ps
curl -fsS http://127.0.0.1:18030/api/health
```

至少观察登录、AI 对话、用户中心和管理后台。涉及数据库变更时，应先在测试环境验证迁移脚本。

## 7. 回滚

代码或镜像回滚：

```bash
cd /path/to/codesprite
git checkout <previous-tested-tag-or-commit>
cd deploy/prod
docker compose up -d --build app
curl -fsS http://127.0.0.1:18030/api/health
```

只有确认数据库或应用数据已被破坏时才恢复数据。恢复前先停止应用写入并再次备份当前状态：

```bash
docker compose stop app
set -a
source ./.env
set +a
docker compose exec -T mysql \
  mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" \
  < ./backups/mysql-<timestamp>.sql
docker compose start app
```

恢复应用数据时，将备份解压到 `APP_DATA_DIR`。不要执行 `docker compose down -v`，也不要直接删除 `MYSQL_DATA_DIR`。

## 8. 健康检查与日志

```bash
docker compose ps
docker compose logs --since=10m app
docker compose logs --since=10m mysql
curl -fsS http://127.0.0.1:18030/api/health
curl -fsS http://127.0.0.1:18030/api/model/health
```

排障时避免在工单、Issue 或公开日志中粘贴 `.env`、Cookie、SSH 私钥、云 AccessKey 或完整数据库连接串。

## 9. 可选的云资产发现

资产发现需要安装阿里云 CLI，并配置只读 Profile。资产数据库初始化：

```bash
docker compose exec -T mysql mysql -uroot -p < ../../cicd/scripts/init_asset_db.sql
docker compose exec -T mysql mysql -uroot -p < ../../cicd/scripts/init_asset_domain_v2.sql
```

运行发现任务前设置 `ASSET_DB_*`、`AIOPS_SYNC_PROFILE_*` 与 `AIOPS_SYNC_ENV_JSON`。不要在仓库中保存真实云凭据或环境配置。
