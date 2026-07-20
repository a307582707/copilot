# CodeSprite Frontend

React 19 + TypeScript + Vite 前端，覆盖公开站点、账号体系、产品工作台与管理后台。桌面端通过 Tauri（`src-tauri/`）复用同一套 UI。

## 目录概览

- `src/site/public/`：官网首页、产品、定价、下载、文档
- `src/site/auth/`：登录 / 注册与产品门禁
- `src/site/user/`：用户中心（订阅、账单等）
- `src/site/admin/`：管理后台
- `src/App.tsx`：产品工作台（对话、终端等）
- `src/ui/`：共享 UI 组件
- `src-tauri/`：Tauri 桌面壳

## 开发

要求：Node.js 20+（建议与 CI / 本地一致）。

```bash
npm ci
npm run dev
```

默认地址：`http://127.0.0.1:5173`。`vite.config.ts` 将 `/api` 代理到 `http://127.0.0.1:8030`，请先启动后端（`saas_api` 或 `backend`）。

常用脚本：

| 命令 | 说明 |
|------|------|
| `npm run dev` | Vite 开发服务器 |
| `npm run build` | 类型检查并构建到 `dist/` |
| `npm run preview` | 预览生产构建 |
| `npm run lint` | ESLint |
| `npm run desktop:dev` | Tauri 开发模式 |
| `npm run desktop:build` | 打包桌面客户端 |

桌面端前置条件与打包说明见 [DESKTOP.md](DESKTOP.md)。

## 路由入口

| 路径 | 说明 |
|------|------|
| `/`、`/product`、`/pricing`、`/download`、`/docs` | 公开站点 |
| `/auth/login`、`/auth/register` | 登录注册 |
| `/app/*`、`/chat/*` | 产品工作台（需登录） |
| `/me/*` | 用户中心（需登录） |
| `/admin/*` | 管理后台 |

仓库根目录的 [README.md](../README.md) 与 [DEPLOY.md](../DEPLOY.md) 提供整体架构与部署说明。
