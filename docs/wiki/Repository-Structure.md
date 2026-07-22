# 仓库结构

```text
copilot/
├── frontend/           # React + Vite Web；src-tauri/ 为桌面壳
├── saas_api/           # 完整 SaaS / AIOps FastAPI（生产入口）
├── backend/            # 轻量本地聊天与管理 API
├── deploy/             # Dockerfile、Compose（local/prod）、Nginx 示例
├── cicd/scripts/       # 阿里云资产发现与资产域初始化
├── scripts/            # 本地开发与推荐桌面安装脚本
│   └── legacy/         # 遗留安装器与文档辅助工具
├── docs/               # 产品 / UI / AIOps / 计费设计
│   ├── wiki/           # 本 Wiki 的仓库内同步稿
│   └── ui/archive/     # 阶段性 UI / 计费原型归档
├── DEPLOY.md
├── SECURITY.md
└── README.md
```

## 关键入口

| 场景 | 入口 |
|------|------|
| 生产 / Docker API | `saas_api/app/server:app` |
| 轻量本地 API | `backend/app/main:app` |
| Web 路由 | `frontend/src/RouterApp.tsx` |
| 产品工作台 | `frontend/src/App.tsx` |
| 桌面配置 | `frontend/src-tauri/tauri.conf.json` |
| 本地 Compose | `deploy/local/docker-compose.yml` |
| 生产 Compose | `deploy/prod/docker-compose.yml` |

## 文档分层

| 路径 | 用途 |
|------|------|
| `docs/wiki/` | 面向贡献者 / 使用者的 Wiki |
| `docs/product/` | 产品需求与海外订阅等 |
| `docs/ui/` | 现行 UI 规格与线框 |
| `docs/ui/archive/` | 历史测试用例与 HTML 原型 |
| `docs/api-backend.md` | 轻量 backend 接口 |
| `docs/user-guide.md` | 使用者操作说明 |
