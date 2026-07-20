# CodeSprite（码灵）商业版：资产/工作区（打开文件 + AI）MVP 详细设计（v1）

> 目标：做成“像 Cursor 一样”的工作区体验：**打开目录/文件 → 搜索 → AI 生成 diff → 用户确认 → 写回 → 可回滚**。  
> 定位：**工作区优先**，资产（主机）是工作区的“运行载体”，不是产品首页。

---

## 0. 适用范围（MVP）

- **必做（MVP）**
  - 工作区首页（最近/置顶/按项目）
  - 工作区内：文件树、打开文件、内容搜索、编辑器 Tabs
  - AI 面板：上下文清单 → 生成 diff → 确认写回（门禁） → 变更记录
  - 试用/付费的**配额与能力开关**
  - 最小审计：文件读写、AI 写回、关键命令
- **暂不做（后续）**
  - Web 纯浏览器直接持有 SSH 私钥（安全风险大）
  - 多人实时协作编辑
  - 企业级密钥托管（KMS/Vault/轮换）完整闭环（可先占位）

---

## 1. 产品信息架构（树状图，工作区优先）

- **首页：工作区**
  - **最近打开**
  - **置顶**
  - **按项目**
    - 项目 A
      - dev
        - 工作区：web-root（`/srv/www/...`）
        - 工作区：nginx-conf（`/etc/nginx/...`）
      - prod
        - 工作区：web-root
  - **共享给我**（团队版后置，可先占位）
  - **新建工作区（主 CTA）**
- **工作区详情页**
  - **文件**
    - 文件树（rootPath 下）
    - 最近文件
    - 收藏目录（可选）
    - 搜索：文件名 / 内容（rg）
  - **编辑器**
    - Tabs
    - 只读/可写（由策略决定）
    - diff 预览（写回前必须可见）
  - **终端（受控）**
    - 只读命令（自动/无需确认）
    - 写入命令（强门禁）
  - **AI 面板**
    - 上下文清单（当前文件/选中文件/允许搜索范围）
    - 生成 diff（补丁）
    - 应用补丁（确认令牌）
    - 自动提交/回滚（付费解锁或试用限额）
- **资产中心（从属入口）**
  - 主机资产列表（搜索/标签/项目/环境）
  - 从资产创建工作区（选模板/路径）
  - 凭据绑定（MVP 占位 + 引用结构）

---

## 2. 核心对象（MVP 数据模型）

> 建议：MVP 先用 SQLite（便于部署），后续无痛迁 PostgreSQL。

### 2.1 用户与订阅

- `User`
  - `id`
  - `email/phone`（二选一做主登录标识；国内建议手机号优先）
  - `password_hash`
  - `role`（user/admin）
  - `trial_start_at` / `trial_end_at`
  - `created_at` / `updated_at`

- `Subscription`
  - `user_id`
  - `plan`（monthly_pro）
  - `status`（trialing/active/expired/canceled）
  - `current_period_end`
  - `created_at` / `updated_at`

- `Quota`（可做成按 plan 固定配置 + 覆盖）
  - `max_assets`
  - `max_workspaces`
  - `max_concurrent_sessions`
  - `max_search_files`
  - `max_read_bytes_per_request`
  - `max_write_ops_per_day`（试用可用）

### 2.2 资产（主机）

- `Asset`
  - `id`
  - `owner_user_id`
  - `name`
  - `address`（ip/域名）
  - `port`
  - `username`
  - `project`（字符串即可）
  - `env`（dev/stage/prod）
  - `tags`（MVP 可 JSON 数组；后续再规范化）
  - `credential_id`（可为空）
  - `status`（enabled/disabled/deleted_at）
  - `created_at` / `updated_at`

### 2.3 工作区

- `Workspace`
  - `id`
  - `owner_user_id`
  - `asset_id`
  - `name`
  - `root_path`
  - `pinned`（bool）
  - `last_opened_at`
  - `created_at` / `updated_at`

### 2.4 审计（MVP 必须）

- `AuditEvent`
  - `id`
  - `user_id`
  - `asset_id` / `workspace_id`
  - `type`
    - `file_open`
    - `file_search`
    - `file_write`
    - `cmd_exec`
    - `ai_generate_patch`
    - `ai_apply_patch`
    - `git_commit`
    - `rollback`
  - `summary`（脱敏后文本）
  - `meta_json`（结构化扩展）
  - `created_at`

---

## 3. 能力门禁（试用/付费：简单但可转化）

### 3.1 试用（Trial）

- ✅ 允许：创建少量资产/工作区、打开文件、搜索、AI 生成 diff
- ⚠️ 写入（你已确认策略）：
  - **每日允许 50 次写回**（计数维度：`ai_apply_patch` 或 `file_write`，建议两者统一以“写回动作”计）
  - 超出：仍可生成 diff，但“应用补丁/保存”按钮置灰并提示升级
- ✅ 终端：只允许只读白名单命令

### 3.2 月付（Pro）

- ✅ 写回：应用补丁/保存文件
- ✅ Git：可选自动提交 + 一键回滚
- ✅ 更高配额：资产/工作区/搜索范围

### 3.3 到期（Expired）

- ✅ 只读保留：工作区/资产可见、文件可打开
- ❌ 禁止：写文件、写命令、AI 应用补丁

---

## 4. 工作区内的“打开文件 + AI 写回”闭环（关键交互细则）

### 4.1 文件读取（安全与性能底线）

- rootPath 以内访问（默认禁止越界）
- 大文件分段读取（offset/limit）
- 强制上限：
  - 单文件最大读取（例如 512KB/次）
  - 单次 AI 上下文最大总字节（例如 300KB）

### 4.2 AI 写回门禁（必须）

- 生成阶段：AI 只返回 **diff/补丁** + 影响文件清单
- 应用阶段：必须携带 **确认令牌**（confirm token），后端校验后才允许写入
- 写入后必须：
  - 记录审计事件
  - 返回写入后的 `git diff` 或文件摘要（用于确认）

### 4.3 回滚策略（MVP）

- 优先 Git：
  - 每次 AI 写回可选自动 commit（付费/或试用限额）
  - 回滚用 `git revert`（保留审计）
- 兜底备份：
  - 写入前生成 `*.bak_YYYYMMDD_HHMMSS`（或只对关键路径启用）

---

## 5. 最小接口（后端/Agent 分层建议）

> “像 Cursor 一样”的关键在于：**执行能力在 Agent 侧**，前端只做 UI 与门禁确认。  
> 浏览器环境不适合持有 SSH 私钥与长连接，因此建议 MVP 就按“Agent 化接口”设计：
> - **Web/API 服务**：账号/订阅/配额（含试用每日 50 次写回）、审计、AI 生成与写回门禁
> - **Agent（本地或同机）**：SSH/SFTP、文件树/读取/搜索、受控命令执行、（可选）git 操作
>
> 部署形态建议：
> - Web 版内测：Agent 先“同机内嵌”（跑在服务器后端同一台机器上，便于落地）
> - 客户端版：Agent 跑在用户本机（更接近 Cursor）

### 5.1 业务 API（Web 服务）

- 订阅与配额
  - `GET /api/me` → 返回 plan/status/quota
- 资产
  - `GET/POST/PUT/DELETE /api/assets`
- 工作区
  - `GET/POST/PUT/DELETE /api/workspaces`
- 审计
  - `GET /api/audit?workspaceId=&type=&from=&to=`

### 5.2 工作区文件能力（由 Agent 承载更稳）

- `GET /api/workspaces/{id}/fs/tree?path=`
- `GET /api/workspaces/{id}/fs/read?path=&offset=&limit=`
- `GET /api/workspaces/{id}/fs/search?q=&path=`
- `POST /api/workspaces/{id}/fs/write`（需要 confirm token）

### 5.3 AI（两段式）

- `POST /api/ai/patch`（输入：问题+上下文选择 → 输出：diff）
- `POST /api/ai/apply`（输入：diff+confirm token → 执行写回/审计/可选 commit）

---

## 6. 验收清单（MVP）

- 工作区首页：最近/置顶/按项目展示正确
- 新建工作区：可选择资产与 rootPath；配额超限提示升级
- 文件树：展开/搜索；打开文件可预览
- AI：能基于选中文件生成 diff；写回必须确认；写回后可回滚
- 试用/到期：能力开关准确（只读/可写）
- 审计：至少记录 `file_open` / `ai_apply_patch` / `file_write`


