# 开发指南

## 日常联调顺序

1. 启动 `saas_api`（或轻量 `backend`）在 `8030`
2. 启动前端 `npm run dev`（`5173`）
3. 需要模型时再启动 Ollama 或配置 `LLM_*`

## 前端约定

- 路由与门禁集中在 `frontend/src/RouterApp.tsx`
- 共享组件在 `frontend/src/ui/`（新增样式优先 `ui-` 前缀）
- 站点分区：`site/public`、`site/auth`、`site/user`、`site/admin`、`site/ops`
- localStorage 键统一 `codesprite_*`；旧 `cursor_like_*` 仅一次性迁移

## 后端约定

- 生产路径走 `saas_api`；Compose 已注入管理员与 DB 环境变量
- SSH / 云凭据必须经 `CRED_ENC_KEY` 加密存储
- 回归测试：`python3 -m unittest saas_api.tests.test_codesprite_regression -v`

## 桌面端

```bash
cd frontend
npm run desktop:dev
```

发版安装包（Windows，唯一推荐）：

```powershell
pwsh ./scripts/build-desktop-installer-csharp-wizard.ps1
```

产物默认：`scripts/deploy-artifacts/CodeSpriteSetup.exe`。

## 质量门槛（建议）

- 前端：`npm run build`（含 `tsc -b`）
- 后端：上述 unittest
- 不把真实密钥、内网域名、生产数据提交进仓库

## 遗留与归档

- `scripts/legacy/`：旧安装器与文档转换脚本，勿用于发版
- `docs/ui/archive/`：历史 UI 材料，现行规范以 `docs/ui/` 为准
