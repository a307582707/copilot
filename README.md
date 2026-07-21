# CodeSprite

CodeSprite（码灵）是面向开发与运维场景的 AI 工作台。核心能力包括对话式 AI、SSH 远程终端与文件操作、云资产管理、AIOps、账号与订阅管理，以及可独立部署的 Web 前端与 FastAPI 服务。

本仓库来自实际产品代码的开源快照。公开版本不包含任何公司的生产配置、账号凭据、运行数据或内部运维资料。

## 主要能力

- React 19 + Vite Web 界面：公开站点、登录注册、用户中心、管理后台与产品工作台
- 支持 Ollama 或 OpenAI-compatible 上游的流式 AI 对话
- SSH 主机连接、终端、文件浏览及凭据加密存储
- 阿里云资产发现、StarRocks / Flink / DataWorks 资产视图与巡检入口
- 用户登录、会话、额度、计费、订阅与审计基础能力
- Tauri 桌面客户端（Windows / macOS）与 Windows 安装包构建脚本
- Web、Docker Compose 一体化部署

部分第三方能力（短信、微信登录、支付、云资产发现）只有在配置对应服务后才会启用。

## 仓库结构

| 路径 | 说明 |
|------|------|
| `frontend/` | React + TypeScript + Vite 前端；`src-tauri/` 为桌面壳 |
| `saas_api/` | 完整 SaaS / AIOps FastAPI 服务，生产入口 `app.server:app` |
| `backend/` | 轻量本地聊天与管理 API，适合最小化开发场景 |
| `cicd/scripts/` | 阿里云资产发现与资产域初始化脚本 |
| `deploy/` | Dockerfile、Compose（`local/` / `prod/`）与 Nginx 示例 |
| `scripts/` | 本地开发、Windows 桌面构建及运维辅助脚本 |
| `docs/` | 产品、UI、AIOps、计费与设计文档 |

## 快速启动（Docker）

要求：

- Docker Engine 24+
- Docker Compose v2
- 可选：Ollama，默认从宿主机 `11434` 端口访问

```bash
git clone https://github.com/a307582707/copilot.git
cd copilot/deploy/local
cp .env.example .env
```

编辑 `.env`，至少替换 `AUTH_SECRET`、`CRED_ENC_KEY`、`ADMIN_PASS`、`MYSQL_ROOT_PASSWORD` 和 `MYSQL_PASSWORD`。Compose 会把 `ADMIN_PASS` 注入为 API 可用的 `ADMIN_PASSWORD`，默认管理员邮箱为 `admin@localhost`（可用 `ADMIN_EMAIL` 覆盖）。

生成随机值：

```bash
openssl rand -hex 32
openssl rand -base64 32 | tr '+/' '-_'
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

然后启动：

```bash
docker compose up -d --build
# 或使用一键脚本：./deploy.sh
curl -fsS http://127.0.0.1:18031/api/health
```

浏览器访问 `http://127.0.0.1:18031/`。停止服务（勿加 `-v`，以免删除数据卷）：

```bash
docker compose down
```

完整的生产部署、备份、升级和回滚步骤见 [DEPLOY.md](DEPLOY.md)。

## 源码开发

### 前端

```bash
cd frontend
npm ci
npm run dev
```

默认开发地址：`http://127.0.0.1:5173`。Vite 将 `/api` 代理到 `http://127.0.0.1:8030`。

### 完整 API（推荐）

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r saas_api/requirements.txt
# 按 saas_api/env.example 配置环境变量
uvicorn app.server:app --app-dir saas_api --host 127.0.0.1 --port 8030
```

### 轻量本地 API

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8030
```

### Windows 脚本

仓库提供 PowerShell / CMD 辅助脚本（见 `scripts/`）：

- `start-frontend.cmd` / `start-backend.cmd`：分别启动前端与轻量后端
- `start-web.cmd`：单进程 Web 模式（API 同时托管前端构建产物）
- `start-desktop.cmd`：启动 Tauri 桌面端

桌面客户端说明见 [frontend/DESKTOP.md](frontend/DESKTOP.md)。

## AI 上游

本地 Ollama：

```bash
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_MODEL=qwen2.5-coder:7b
```

也可通过 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，或 `LLM_UPSTREAMS_JSON` 配置 OpenAI-compatible 服务。不要把真实 API Key 写入仓库。

## 云资产发现

资产发现脚本只读取环境变量和本机 `aliyun` CLI Profile：

- `AIOPS_DISCOVERY_ROOT`
- `AIOPS_SYNC_PROFILE_DEFAULT`
- `AIOPS_SYNC_PROFILE_DATAWORKS`
- `AIOPS_SYNC_ENV_JSON`
- `ASSET_DB_HOST`、`ASSET_DB_PORT`、`ASSET_DB_USER`、`ASSET_DB_PASS`、`ASSET_DB_NAME`

环境 JSON 可参考 `saas_api/app/aiops/templates/example.env.json`。建议使用只读 RAM 账号，并在执行前确认账号权限和目标 Region。

## 相关文档

| 文档 | 内容 |
|------|------|
| [DEPLOY.md](DEPLOY.md) | 本地 / 生产部署、备份、升级与回滚 |
| [SECURITY.md](SECURITY.md) | 安全策略与漏洞报告 |
| [api.md](api.md) | 轻量后端接口说明 |
| [cursor-users.md](cursor-users.md) | 面向使用者的操作说明 |
| [frontend/DESKTOP.md](frontend/DESKTOP.md) | Tauri 桌面客户端 |
| [docs/](docs/) | 产品需求、UI 规范、AIOps、计费设计 |

## 安全说明

- 所有示例密码和域名都必须在部署前替换。
- `.env`、数据库、日志、备份和密钥文件已被 `.gitignore` 排除。
- `AUTH_SECRET` 与 `CRED_ENC_KEY` 部署后应稳定保存；变更会使既有会话或加密凭据失效。
- 生产环境应通过 HTTPS 暴露服务，并保持 `COOKIE_SECURE=1`。
- SSH、云账号、支付和管理员接口属于高权限能力，请限制网络入口并启用最小权限。

发现安全问题时，请不要公开披露凭据或利用细节；参见 [SECURITY.md](SECURITY.md)。

## License

MIT，见 [LICENSE](LICENSE)。
