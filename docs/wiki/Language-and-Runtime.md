# 语言与运行环境

本文描述 CodeSprite 仓库实际使用的语言、运行时与镜像版本，便于搭建开发与部署环境。

## 总览

| 层级 | 技术 | 版本 / 约束 | 说明 |
|------|------|-------------|------|
| 前端语言 | TypeScript | ~5.9 | `frontend/` |
| UI 框架 | React | 19.2.x | 含 React DOM |
| 路由 | React Router | 7.x | `frontend/src/RouterApp.tsx` |
| 构建 | Vite | 7.x | 开发服务器默认 `127.0.0.1:5173` |
| Node.js | Node | **≥ 20**（镜像 `node:20-alpine`） | `frontend/package.json` `engines` |
| 桌面壳 | Tauri | 2.x | Rust edition 2021，包名 `codesprite` |
| 桌面标识 | Bundle ID | `com.codesprite.app` | 产品名「码灵」 |
| SaaS API | Python + FastAPI | Python **3.11**（镜像），FastAPI 0.116.x | 入口 `saas_api/app/server:app` |
| 轻量 API | Python + FastAPI | 同上 | 入口 `backend/app/main:app` |
| ASGI 服务器 | Uvicorn | 0.35.x | 默认开发端口 `8030` |
| 数据库 | MySQL | **8.0** | Compose 服务；本地也可 SQLite 回退 |
| ORM / 驱动 | SQLAlchemy / PyMySQL / asyncmy | 见各自 `requirements.txt` | SaaS 与 backend 略有差异 |
| 远程 SSH | Paramiko | 3.5.x | 终端与文件能力 |
| 容器 | Docker Engine / Compose | Engine **24+**，Compose **v2** | 见 `deploy/` |
| AI 上游（可选） | Ollama / OpenAI-compatible | 默认宿主机 `11434` | 环境变量配置 |

## 前端（TypeScript / Node）

```text
frontend/
  package.json          # name: codesprite-web, engines.node >= 20
  vite.config.ts
  src/                  # React 19 + TS
  src-tauri/            # Tauri 2 (Rust)
```

常用命令：

```bash
cd frontend
npm ci
npm run dev            # http://127.0.0.1:5173 ，/api 代理到 8030
npm run build
npm run desktop:dev    # 需要本机 Rust / WebView2 或 Xcode CLT
```

终端相关依赖：`xterm` 5.x、`xterm-addon-fit`。

## 后端（Python）

### 完整 SaaS（推荐）

- 目录：`saas_api/`
- 镜像基础：`python:3.11-slim`
- 依赖：`saas_api/requirements.txt`（FastAPI、Uvicorn、httpx、Paramiko、SQLAlchemy、PyMySQL、cryptography）
- 启动示例：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r saas_api/requirements.txt
uvicorn app.server:app --app-dir saas_api --host 127.0.0.1 --port 8030
```

### 轻量本地 API

- 目录：`backend/`
- 适合最小化聊天 / 管理联调
- 依赖：`backend/requirements.txt`（含 SQLAlchemy asyncio、asyncmy）

## 数据与密钥

| 变量 | 用途 |
|------|------|
| `AUTH_SECRET` | 会话签名，部署后保持稳定 |
| `CRED_ENC_KEY` | Fernet，加密 SSH / 云凭据 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | SaaS 管理员引导（Compose 也接受 `ADMIN_USER` / `ADMIN_PASS`） |
| `DB_DSN` / `DB_PATH` | MySQL DSN 或 SQLite 路径 |
| `COOKIE_SECURE` | 接受 `1/0` 或 `true/false`；生产应为 `1` |
| `OLLAMA_*` / `LLM_*` | 模型上游 |

示例文件：

- `deploy/local/.env.example`、`deploy/prod/.env.example`
- `saas_api/env.example`

## 容器矩阵

| 阶段 / 服务 | 镜像 |
|-------------|------|
| 前端构建 | `node:20-alpine` |
| API 运行时 | `python:3.11-slim` |
| 数据库 | `mysql:8.0` |

本地一体化：`deploy/local`（默认对外 `18031`）。  
生产示例：`deploy/prod`（默认本机 `18030`，前置 HTTPS 反代）。

生产默认 MySQL 时区为 UTC（`+00:00`）；需要 `+08:00` + binlog 时用可选 `docker-compose.mysql.yml`。

## 桌面端（Rust / Tauri）

| 项 | 值 |
|----|-----|
| 框架 | Tauri 2 |
| Rust package | `codesprite` |
| 版本 | `0.1.0`（与前端 package 对齐） |
| Windows 安装包 | 推荐 `scripts/build-desktop-installer-csharp-wizard.ps1` |
| 遗留安装脚本 | `scripts/legacy/`（勿用于发版） |

Windows 需要 WebView2、Rust MSVC、VS Build Tools；macOS 需要 Xcode CLT 与 Rust。详见 `frontend/DESKTOP.md`。

## 语言与编码约定

- 源码与文档默认 **UTF-8**，文本行尾 **LF**（Windows 脚本 `*.ps1` / `*.cmd` 为 CRLF，见 `.gitattributes`）
- 用户可见文案以 **中文** 为主，标识符与 API 字段以 **英文** 为主
- 对外品牌：**CodeSprite / 码灵**；历史 `cursor_like_*` 仅作 localStorage 一次性迁移兼容

## 建议本机工具链

```text
git
Node.js 20+
Python 3.11+
Docker Engine 24+ / Compose v2
（可选）Ollama
（可选桌面）Rust stable + 平台 WebView 依赖
（可选资产发现）阿里云 CLI
```
