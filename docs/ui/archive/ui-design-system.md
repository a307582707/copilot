# UI 设计系统（Design System v1）

本项目目前的 UI 目标是：做出 **类似 Cursor 的暗色磨砂风格“左侧导航 + 右侧工作区”管理型工具**，并保证 **Web 与客户端（Tauri/Electron）复用同一套 UI/组件**。

---

## 1. 已落地（当前代码）

### 1.1 Token（全局变量）

位置：`frontend/src/ui/tokens.css`  
接入：`frontend/src/main.tsx` 已引入 `frontend/src/ui/styles.css`

- **颜色**：`--ds-bg / --ds-surface-1 / --ds-border / --ds-text / --ds-accent / --ds-danger ...`
- **圆角**：`--ds-radius-sm/md/lg`
- **间距**：`--ds-space-1..5`
- **字体**：`--ds-font-11/12/14`
- **焦点态**：`--ds-focus-ring / --ds-focus-border`
- **阴影**：`--ds-shadow-1`

同时为了不破坏旧样式，保留并映射了已有变量（`--bg / --panel / --border / --text ...`）。

### 1.2 基础组件

位置：`frontend/src/ui/*`

- **Button**：`Button`（default/primary/danger/ghost，md/sm）
- **IconButton**：`IconButton`
- **Input**：`Input`
- **Select**：`Select`
- **Menu**：`Menu` + `MenuItem`
- **Badge**：`Badge`
- **Card**：`Card`

样式：`frontend/src/ui/components.css`（统一 hover/active/focus 规则）

---

## 2. 迁移策略（把“邹形”逐步精细化）

原则：**只新增 `ui-` 前缀的组件/样式，不破坏旧 class**，按“可见收益最大”的页面逐步替换。

推荐迁移顺序：

1. **弹窗/表单**（信息密度高、控件多，最能提现统一性）
2. **左侧列表项/菜单/更多（⋯）**（hover/active/focus 细节多）
3. **右侧详情卡片**（排版与间距统一）
4. **全局快捷键/可访问性**（focus 可见、Esc 关闭、Enter 提交、ARIA）

---

## 3. 客户端版本建议（先规划，后落地）

### 3.1 推荐：Tauri

优点：
- **体积小、启动快**
- Web 与客户端 UI **几乎 100% 复用**
- 适合后续接入“本地 Agent”（SSH/SFTP/文件系统/Git）

建议目录结构（V2）：

- `frontend/`：Web UI（也作为桌面 UI）
- `desktop/`：Tauri 壳（Rust + system APIs + 调用本地 Agent）
- `backend/`：当前 FastAPI（也可在桌面版内置或独立运行）

### 3.2 桌面端能力边界（建议默认开启“可控写回”）

- **读**：列目录、读文件、搜索、git status/diff
- **写**：AI 生成 diff -> 用户确认 -> 写回 -> 自动 commit
- **回滚**：AI 生成 revert/rebase 策略 -> 用户确认执行

---

## 4. 下一步（建议）

- 把 `Modal` 抽成 `ui/Modal`（统一 Esc/点击遮罩关闭、滚动锁定、ARIA）
- 把“侧栏 Tab / 列表项 / 搜索框 / 右侧详情”逐步迁移到 `ui` 组件
- 决定桌面端技术：**Tauri（推荐）** 或 Electron


