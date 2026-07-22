# 快速开始

## 方式 A：Docker（推荐先验证）

```bash
git clone https://github.com/a307582707/copilot.git
cd copilot/deploy/local
cp .env.example .env
# 编辑 .env，至少替换 AUTH_SECRET、CRED_ENC_KEY、ADMIN_PASS、MYSQL_* 密码
docker compose up -d --build
curl -fsS http://127.0.0.1:18031/api/health
```

浏览器打开 `http://127.0.0.1:18031/`。停止时不要加 `-v`，以免删除数据卷。

生成随机密钥示例：

```bash
openssl rand -hex 32
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

## 方式 B：源码开发

### 1) SaaS API

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r saas_api/requirements.txt
# 参考 saas_api/env.example 导出环境变量
uvicorn app.server:app --app-dir saas_api --host 127.0.0.1 --port 8030
```

### 2) 前端

```bash
cd frontend
npm ci
npm run dev
```

访问 `http://127.0.0.1:5173`。Vite 已将 `/api` 代理到 `8030`。

### 3) Windows 一键脚本（可选）

仓库 `scripts/` 提供 `start-frontend` / `start-backend` / `start-web` / `start-desktop` 的 `.cmd` / `.ps1`。

## 健康检查

- API：`GET /api/health`（经前端代理或 Compose 入口）
- 轻量 backend 直连：`GET http://127.0.0.1:8030/health`

## 下一步

- 部署与备份：见 [部署要点](Deployment) 与仓库 `DEPLOY.md`
- 桌面端：见 `frontend/DESKTOP.md`
- 使用者操作：见 `docs/user-guide.md`
