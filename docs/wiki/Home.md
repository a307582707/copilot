# CodeSprite（码灵）Wiki

CodeSprite 是面向开发与运维场景的 AI 工作台开源快照：对话式 AI、SSH 终端与文件操作、云资产管理、AIOps、账号与订阅，以及可独立部署的 Web / FastAPI / Tauri 桌面端。

> 本 Wiki 与仓库内 `docs/wiki/` 同步维护。公开版本不包含任何公司的生产配置、账号凭据或运行数据。

## 快速导航

| 页面 | 说明 |
|------|------|
| [语言与运行环境](Language-and-Runtime) | Node / Python / React / Tauri / Docker / MySQL 等版本与要求 |
| [快速开始](Getting-Started) | 本地源码开发与 Docker 一键启动 |
| [仓库结构](Repository-Structure) | 目录职责与入口文件 |
| [开发指南](Development) | 前端、SaaS API、轻量 backend、桌面端日常开发 |
| [部署要点](Deployment) | 与 `DEPLOY.md` 对齐的部署摘要 |

## 产品能力（摘要）

- **Web 控制台**：公开站点、登录注册、用户中心、管理后台、产品工作台
- **AI 对话**：Ollama 或 OpenAI-compatible 上游，流式输出
- **远程运维**：SSH 主机、终端、文件浏览、凭据加密存储
- **云资产 / AIOps**：阿里云资产发现、巡检与运营入口（按配置启用）
- **账号与订阅**：会话、额度、计费与审计基础能力
- **桌面端**：Tauri 2（Windows / macOS），安装包脚本见 `scripts/`

## 官方文档入口

- 仓库 README：项目总览与快速启动
- [`DEPLOY.md`](https://github.com/a307582707/copilot/blob/main/DEPLOY.md)：完整部署、备份、升级与回滚
- [`SECURITY.md`](https://github.com/a307582707/copilot/blob/main/SECURITY.md)：漏洞报告与部署安全责任
- [`docs/`](https://github.com/a307582707/copilot/tree/main/docs)：产品 / UI / AIOps / 计费设计

## License

MIT
