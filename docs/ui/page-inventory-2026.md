# CodeSprite（码灵）页面与状态全量清单（2026 v1）

> 目标：把仓库里**真实存在**的页面/路由/门禁/错误态/关键弹窗抽屉做成一份“可审计清单”，用于补齐 UI 规格与后续排期。
>
> 事实来源：`frontend/src/RouterApp.tsx`、`frontend/src/App.tsx`、`frontend/src/site/**`、`frontend/src-tauri/**`、`scripts/build-desktop-installer-csharp-wizard.ps1`。

## 1. 顶层路由地图（Web）

| 分组 | 路由 | 入口/跳转 | 门禁 | 主要页面组件 |
|---|---|---|---|---|
| Public | `/` | 官网首页 | 无 | `HomePage` |
| Public | `/product` | 顶部导航 | 无 | `ProductPage` |
| Public | `/pricing` | 顶部导航 | 无 | `PricingPage` |
| Public | `/download` | 顶部导航/CTA | 无 | `DownloadPage` |
| Public | `/docs/*` | 顶部导航（登录后）/下载页错误提示 | **部分内容要求登录（建议）** | `DocsHome`（内部子路由） |
| Auth | `/auth/login` | 顶部“登录”/门禁弹窗 | 无 | `LoginPage` |
| Auth | `/auth/register` | 顶部“注册”/CTA | 无 | `RegisterPage` |
| BackCompat | `/login` | 旧入口 | 无 | 重定向 `/auth/login` |
| BackCompat | `/register` | 旧入口 | 无 | 重定向 `/auth/register` |
| App | `/app` | 登录后入口（Header UserMenu / Home CTA） | **必须登录**（`ProductGate`） | `App.tsx`（控制台/聊天/资产管理/插件） |
| Me | `/me/*` | Header UserMenu: 账号设置 | **当前未强制门禁（建议补齐）** | `MeHome`（内部子路由） |
| Admin | `/admin/login` | 直接访问/重定向 | 无 | `AdminLoginPage` |
| Admin | `/admin/*` | admin login 成功后 | **必须登录且 role=admin**（`AdminGate`） | `AdminHome`（内部子路由） |
| 兜底 | `*` | 任意未知路由 | 无 | 重定向 `/` |

## 2. Public Site（官网）页面清单

### 2.1 `PublicLayout`（全站壳）

- **文件**：`frontend/src/site/public/layout.tsx`
- **职责**
  - sticky header（滚动后增加边框/磨砂）
  - 移动端 hamburger 菜单（overlay + sheet）
  - 登录后 user menu（Plan badge、进入 `/app`、`/me`、订阅入口、退出登录）
  - footer（手册/安全/联系我们占位链接）

**关键状态**

- `loadingMe=true`：Header 不展示登录态（避免闪烁）
- `me=null`：显示登录/注册
- `me!=null`：显示用户菜单 + Pro/Free badge（并尝试加载 billing plan）

### 2.2 `/` HomePage（两态）

- **文件**：`frontend/src/site/public/HomePage.tsx`
- **状态**
  - 未登录：Hero（注册/下载 CTA）
  - 已登录：Portal（进入 `/app`、升级会员）
- **关键组件**
  - `LoginRequiredModal`：点击进入 `/app` 时若未登录弹出

### 2.3 `/product` ProductPage

- **文件**：`frontend/src/site/public/ProductPage.tsx`
- **模块**：Hero、特性卡、痛点模块、信任背书、底部 CTA
- **状态**：纯静态（无门禁）

### 2.4 `/pricing` PricingPage

- **文件**：`frontend/src/site/public/PricingPage.tsx`
- **模块**：周期切换（月/年）、三档 PlanCard、对比表、FAQ
- **状态**：纯静态（后续可接后端定价配置）

### 2.5 `/download` DownloadPage

- **文件**：`frontend/src/site/public/DownloadPage.tsx`
- **依赖接口**：`GET /api/public/releases`
- **状态**
  - loading：版本列表加载中
  - error：显示错误 + 引导 `/docs/publish`
  - empty：无 Windows 版本提示“先发布构建产物”
  - ok：推荐安装版 + 绿色版 + SHA256 复制

### 2.6 `/docs/*` DocsHome（子路由）

- **文件**：`frontend/src/site/public/DocsHome.tsx`
- **子路由（真实存在）**
  - `/docs`：入口卡片页
  - `/docs/getting-started`
  - `/docs/billing`
  - `/docs/publish`
  - `/docs/security`
  - `/docs/contact`

> 注：当前 `layout.tsx` 只在登录后展示“文档”入口，但路由本身不强制登录。是否要“公开文档/内部文档分层”需在后续规范里落定。

## 3. Auth（登录注册）页面清单

### 3.1 `/auth/login` LoginPage

- **文件**：`frontend/src/site/auth/LoginPage.tsx`
- **入口**：public header、`ProductGate` 触发、`?next=...` 跳转
- **状态**
  - 已登录：自动跳转到 `next`（默认 `/`）
  - 登录失败：解析后端错误文本，展示友好文案

### 3.2 `/auth/register` RegisterPage（短信注册）

- **文件**：`frontend/src/site/auth/RegisterPage.tsx`
- **关键交互**
  - 发送短信：`POST /api/auth/register_sms/request`
  - 注册：`POST /api/auth/register`
  - 拼图验证弹窗（PuzzleVerify）：每次获取短信都必须重新验证
  - cooldown 60 秒（支持后端返回 retryAfter）
- **关键失败态**
  - RAM 权限不足 / 短信模板非法：明确提示“联系管理员”
  - `Phone already registered`：提示“直接登录”
  - 验证码错误/过期：提示输入/重试

### 3.3 `LoginRequiredModal`（门禁弹窗）

- **文件**：`frontend/src/site/auth/LoginRequiredModal.tsx`
- **触发**：HomePage、ProductGate
- **动作**：立即登录（携带 next）/取消

### 3.4 `ProductGate`（/app 登录门禁）

- **文件**：`frontend/src/site/auth/ProductGate.tsx`
- **状态**
  - loading：显示“正在验证登录态…”
  - unauth：展示 LoginRequiredModal + fallback 文本
  - ok：渲染 `/app`

## 4. /app（产品端）页面清单（单页内多模式）

> `/app` 实际由 `frontend/src/App.tsx` 单文件承载；这里按“mode + 关键弹层/抽屉”拆出页面清单。

### 4.1 mode=dashboard（控制台）

- **入口**：Sidebar Tab（`dashboard`）
- **主要区域**
  - Topbar：面包屑 + 全屏切换
  - KPI：资产/工作区/插件/对话（点击跳转到对应 mode）
  - Quick Actions：新建主机、导入资产、安装插件、发起对话
  - Tabs：最近访问/我的主机/活跃工作区
- **关键弹层**
  - Dashboard Drawer：右侧抽屉（用于“创建工作区”等流程）

### 4.2 mode=chat（聊天）

- **入口**：Sidebar Tab（`chat`）
- **主要区域**
  - 会话列表（新建/选择/清空/删除）
  - 聊天流（用户/助手/工具消息）
  - 输入区（支持 stop、模型选择等）
- **关键弹层**
  - 清空聊天确认（Compact Modal）
  - 会话行“⋯”菜单（关闭/删除等）

### 4.3 mode=ssh（资产管理）

- **入口**：Sidebar Tab（`ssh`）
- **主要区域**
  - 左侧：`HostSidebar`（工作区列表 + Inventory 资产库）
  - 右侧：详情区（工作区详情 / 资产详情 / 空状态）
- **关键弹层**
  - HostEditor Modal（新增/编辑主机）
  - Import Modal（导入预览 + 确认导入）
  - API Base 配置 Modal（桌面端/非同源场景下配置后端地址）
  - Workspace Edit Modal（编辑工作区 name/rootPath）

### 4.4 mode=workspace（工作区内）

- **入口**：从资产创建工作区、或选择工作区后进入
- **主要区域**
  - 文件区/目录打开（open dir）
  - 文件打开/编辑（含“已保存（并生成备份）”提示）
  - 终端区（含 vmstat/iostat 等只读探测按钮）
  - 连接状态：连接/断开/重连（断连提示 toast）
- **关键门禁弹层**
  - 命令确认（cmdConfirm）：多条命令的确认与“记住策略”开关
  - 工具调用确认（toolConfirm）：Agent tool calls 的确认
  - Shell（人工）入口与状态提示（避免 AI exec 与人工模式冲突）

#### 页面优化建议（工作区 + AI 聊天）（补充）

> 场景：你截图里的页面属于 `mode=workspace` 的“文件区 + AI 聊天区”组合视图。当前主要问题是**信息密度不足、入口分散、断连不可操作、空态引导弱**。

##### 1) 问题点（当前痛点）

- **Topbar 空白过大**：红框区域高度占用明显，但只展示了两个下拉（AI 模式/模型），缺少“我在哪/我能做什么/下一步是什么”的信息。
- **用户规则入口不就地**：用户不容易想到去“偏好设置”找规则；规则应该与“模式/模型”同级呈现。
- **断连提示不可操作**：只有提示文案“点击右上角重新连接”，但缺少页面内的主 CTA（用户视角会迷失）。
- **文件区空态弱**：`/root` 列表空白时没有可执行的下一步（刷新/常用目录/创建工作区），用户会停住。
- **Ask（只读）语义不清**：新用户不理解“只读”到底禁止了什么，会导致误用与挫败感。

##### 2) 目标态结构（不大改布局，提升密度与可发现性）

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ WorkspaceTopbar (56~64px)                                                 │
│  Left:  AI聊天  ·  {workspaceName} / {host}  ·  {rootPath}                │
│  Right: [模式Segment] [模型Select] [用户规则] [⋯更多] [重连/状态Pill]       │
├──────────────────────────────────────────────────────────────────────────┤
│ LeftPane: 文件/目录（EmptyState/列表）   |   RightPane: 聊天消息区          │
├──────────────────────────────────────────────────────────────────────────┤
│ Bottom: 输入区（保留） + 终端/探测（保留）                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

关键原则：

- **把“模式/模型/规则/状态”集中到同一 Topbar**，减少用户到处找入口。
- **压缩 Topbar 高度**，把空间还给内容区（文件与聊天）。

##### 3) 交互细则（可落地）

**3.1 用户规则（就地入口）**

- 在 Topbar 的“模式/模型”旁新增按钮：`用户规则`。
- 显示状态：`未设置` / `已启用（N 条）`（N 可按换行数/规则块数粗略统计）。
- 点击后打开 Drawer/Modal（复用现有 `prefDrawer` 样式体系即可）：
  - 文案：`对你所有项目生效（像 Cursor User Rules）。`
  - 字段：多行文本（支持粘贴 Markdown）
  - 动作：保存/取消/清空（清空需二次确认）
  - 本地存储：使用独立 key（例如 `codesprite_user_rules_v1`），便于迁移与回滚

**3.2 断连提示（改为可操作状态卡）**

- 当连接断开时，在聊天区顶部插入一个 `ReconnectCard`（不遮挡输入）：
  - 红点 `已断开` + 原因（超时/服务重启/手动断开）+ 主按钮 `重新连接` + 次按钮 `查看详情`
- 输入区置灰但可复制文本（避免用户输入丢失）

**3.3 文件区空态（Empty State + CTA）**

- 当目录为空或未加载时，显示三按钮：
  - `刷新列表`（等价于“刷新”）
  - `打开常用目录`（/root、/srv/www、/etc、Windows: C:/Users）
  - `新建工作区`（打开创建工作区 Drawer）

**3.4 Ask（只读）解释与反馈**

- 模式下拉/Segment 添加 tooltip：
  - Ask（只读）：不执行命令、不改文件，仅提问/解释
  - Agent：允许只读探测；写入类动作必须二次确认
- 切换模式后 toast：`已切换到 Ask（只读）` / `已切换到 Agent`

##### 4) 验收点（验收即发现大多数 UX 问题）

- Topbar：在 56~64px 高度内仍能显示 workspace 上下文与关键入口，且移动端可收敛为“⋯更多”菜单
- 用户规则：用户能在 2 次点击内找到并修改规则（Topbar → 用户规则）
- 断连：断连后用户不需要找“右上角”，页面内有明确 `重新连接` 主按钮
- 空态：文件区为空时不会让用户停住，至少提供 2 个可执行 CTA
- 模式：Ask/Agent 的差异对用户可理解，且切换有反馈

##### 5) 可落地改造任务清单（到组件/样式粒度，不改结构为先）

- **Topbar**
  - 将现有红框区域收敛为 `WorkspaceTopbar`（高度 56~64px）
  - 左侧新增 `WorkspaceContextLabel`（workspace/host/rootPath）
  - 右侧将“模式/模型”改成紧凑组合（Segment + Select）
- **用户规则入口**
  - 增加 Topbar 按钮 `用户规则`
  - 新增 `UserRulesModal` 或 `UserRulesDrawer`（复用现有 modal/drawer 样式）
  - 本地存储 key：`codesprite_user_rules_v1`（独立于偏好设置，便于回滚）
- **断连体验**
  - 增加 `ReconnectCard`（connected=false 时展示）
  - 输入区禁用但保留草稿（不丢内容）
- **文件区空态**
  - 增加 `FilePaneEmptyState`（包含刷新/常用目录/新建工作区 CTA）
- **模式解释**
  - 为模式控件添加 tooltip（或 info icon）
  - 模式切换 toast（复用现有 toast）

### 4.5 mode=plugins（插件中心）

- **入口**：Sidebar Tab（`plugins`）
- **主要区域**
  - 已装/可更新/未安装列表
  - 插件详情（当前以占位/列表为主）

### 4.6 /app 全局弹层/抽屉/系统组件（跨 mode）

- **偏好设置 Drawer**：`.prefDrawer`（Esc/点遮罩关闭）
- **Toast**：右下角短提示（自动消失）
- **侧栏移动端 Drawer**：mobile sidebar overlay + open/close buttons
- **上下文/工作区聊天菜单**：toolbar “⋯”菜单（清空上下文/清空聊天等）

## 5. /me（个人中心）页面清单

- **入口**：public header user menu → “账号设置”
- **文件**：`frontend/src/site/user/MeHome.tsx`
- **子路由（真实存在）**
  - `/me`：概览（余额/订阅/每月赠送额度）
  - `/me/billing`：充值中心（完整向导）
  - `/me/subscription`：占位
  - `/me/devices`：占位
  - `/me/profile`：占位

### `/me/billing` 的关键子页面态（同页内多状态）

- **文件**：`frontend/src/site/user/MeBillingPage.tsx`
- **充值收银台 Modal（4 步）**：`scan` → `submit` → `verifying` → `done`
- **订阅续费确认 Modal**：扣余额确认（含余额不足错误文案）
- **记录 Tab**：充值订单 / 资金流水
- **管理员区块（仅 admin 可见）**：待入账订单列表 + 一键入账 + 查看截图

## 6. /admin（后台）页面清单

### 6.1 `/admin/login`

- **文件**：`frontend/src/site/admin/AdminLoginPage.tsx`
- **特点**：使用同一 `/api/auth/login`，但 UI 强调“管理员邮箱/密码”
- **next 安全**：只允许同源 path

### 6.2 `/admin/*` AdminHome（内部子路由）

- **文件**：`frontend/src/site/admin/AdminHome.tsx`
- **门禁**：`AdminGate`（必须登录 + role=admin）
- **子路由（真实存在）**
  - `/admin`：总览（统计：用户总数/活跃订阅/试用到期）
  - `/admin/users`：用户列表（搜索 + 分页）
  - `/admin/orders`：充值订单（占位）
  - `/admin/ledger`：消费流水（占位）
- **关键错误态**
  - gate=forbidden：显示“无权限访问后台”

## 7. Desktop（桌面端）页面清单

### 7.1 Tauri 壳（窗口与启动）

- **目录**：`frontend/src-tauri/*`
- **配置**：`frontend/src-tauri/tauri.conf.json`
  - 窗口默认最大化、最小尺寸、devUrl 指向 `http://127.0.0.1:5173`
- **代码**：`frontend/src-tauri/src/main.rs`（当前仅启动壳）

> 结论：桌面端 UI 实际复用 Web UI（`/app`）。桌面端“设置/后端地址 API Base”属于 Web UI 内的一个配置弹窗（`API_BASE_KEY=codesprite_api_base_v1`）。

### 7.2 Windows 安装器向导（C# Wizard）

- **脚本**：`scripts/build-desktop-installer-csharp-wizard.ps1`
- **向导页（真实存在）**
  - Welcome
  - License（勾选同意才能继续）
  - Install Dir（选择安装目录）
  - Options（桌面快捷方式/开始菜单/开机自启）
  - Confirm（确认安装清单）
  - Progress（下载/解压/安装进度 + 日志）
  - Done（完成 + 安装后启动）
- **关键弹窗/失败态**
  - Upgrade Prompt：检测到已安装，提示“是否覆盖安装”
  - 程序占用：无法覆盖文件时提示“请先退出客户端后重试”

## 8. 交付引用（更细线框在这些文档）

- /app：`docs/ui/app-console-wireframes.md`
- public site：`docs/ui/public-site-wireframes.md`
- /me：`docs/ui/account-center-wireframes.md`（待补齐）
- /admin：`docs/ui/admin-console-wireframes.md`（待补齐）
- desktop：`docs/ui/desktop-client-wireframes.md`（待补齐）

