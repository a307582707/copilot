# Wiki 同步稿

本目录是 GitHub Wiki 的仓库内副本，便于 Code Review 与版本追踪。

对应线上 Wiki：https://github.com/a307582707/copilot/wiki

| 文件 | Wiki 页面 |
|------|-----------|
| `Home.md` | Home |
| `Language-and-Runtime.md` | Language-and-Runtime |
| `Getting-Started.md` | Getting-Started |
| `Repository-Structure.md` | Repository-Structure |
| `Development.md` | Development |
| `Deployment.md` | Deployment |
| `_Sidebar.md` | 侧栏导航 |

## 更新与发布到 GitHub Wiki

1. 在本目录编辑 Markdown（PR 正常 Code Review）
2. **首次**需要在网页创建 Wiki 首页（GitHub 才会生成 `*.wiki.git`）：
   - 打开 https://github.com/a307582707/copilot/wiki
   - 点击 *Create the first page*，保存任意 Home 草稿
3. 在仓库根目录执行：

```bash
./scripts/ops/sync_github_wiki.sh
```

脚本会把本目录页面（除本 README）推送到 Wiki，并保留 `_Sidebar.md` 侧栏。
