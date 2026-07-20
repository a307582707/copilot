# CodeSprite（码灵）后台管理（Admin Console）MVP 设计（v1）

> 目标：支撑“试用 → 月付订阅”的运营闭环，提供最小可用的用户/订阅/配额/审计管理。  
> 原则：**简单可运维**、最小权限、重要操作有审计、可回滚。

---

## 1) 域名与路由（国内产品建议）

### 方案 A（推荐）：同域名路径，Cookie 最稳

- 官网/产品：`codesprite.example.com`
- 后台：`codesprite.example.com/admin`
- API：`codesprite.example.com/api/*`

优点：
- 同域名 Cookie/Session 最简单
- 证书/跨域/CSRF 成本最低

### 方案 B：独立子域名（你坚持“单独域名”时用）

- 后台：`admin.codesprite.example.com`
- API：仍走 `codesprite.example.com/api/*`（或同域 `admin.../api/*`）

建议：
- **DNS**：将 `admin.codesprite.example.com` 指向你的负载均衡或服务器
- **Nginx vhost**：独立 server_name，静态 root 指向同一份 admin build 目录

---

## 2) 登录与权限（MVP）

### 2.1 账号体系（MVP）

- 登录方式：**账号/密码**（国内可优先手机号+密码；邮箱也可）
- 会话方式：**HttpOnly Cookie Session**（推荐）或 JWT（需要额外处理刷新/吊销）
- 安全底线：
  - 密码 hash：bcrypt/argon2
  - 登录限速：按 IP/账号限流（防爆破）
  - CSRF 防护：同域 Cookie + CSRF token（或 SameSite=strict + 双提交）

### 2.1.1 /admin 登录页（需要重新设计的部分，MVP 可直接开发）

- 路径：`/admin/login`
- 目标：让“管理员登录”与“用户登录”解耦（避免普通用户误入后台）
- UI 结构（Cursor 风格深色磨砂，简洁高密度）：
  - 顶部：品牌（码灵 CodeSprite）+ “后台管理”
  - 表单：
    - 管理员账号（手机号/邮箱/用户名）
    - 密码
    - 登录按钮（loading/禁用态）
    - 错误提示（账号/密码错误、被禁用、限流）
  - 辅助：
    - “返回官网”链接
    - “忘记密码/联系管理员”（MVP 可先文案+跳 docs）
- 行为：
  - 未登录访问 `/admin/*` → 302 到 `/admin/login?next=/admin/...`
  - 登录成功 → 跳转回 `next`，默认 `/admin`
  - 登录态保持：Cookie（HttpOnly，SameSite=Lax，Secure）

### 2.2 权限（MVP）

- 角色：
  - `admin`：后台全部能力
  - `ops`（可选）：只读统计 + 查看日志 + 禁止改账
- 强制审计：
  - 改用户状态
  - 调整试用期/订阅期
  - 手工入账/退款（若 MVP 做人工对账）

---

## 3) 后台信息架构（树状图）

- **后台首页（Dashboard）**
  - 今日新增 / 活跃 / 试用到期
  - 订阅：活跃/到期/取消
  - 收入（MVP 可先占位）
  - 系统健康：API、DB、队列（如有）
- **用户管理**
  - 用户列表（搜索：手机号/邮箱/ID）
  - 用户详情
    - 基本信息/注册来源
    - 试用状态（开始/到期）
    - 订阅状态（月付：active/expired）
    - 配额与用量（资产数/工作区数/写回次数）
    - 审计事件（最近 50 条）
    - 操作（带二次确认）
      - 禁用/解禁
      - 延长试用
      - 手工开通/暂停订阅
- **订阅与计费（MVP：先“人工对账/手工开通”也能上线）**
  - 套餐配置（monthly_pro）
  - 订阅列表
  - 充值订单（MVP 可先“固定收款码 + 人工入账”）
  - 消费流水（按月扣费记录）
- **资产与工作区（运营视角）**
  - 资产统计：总数/新增/Top 用户
  - 工作区统计：总数/最近打开/Top rootPath
  - 风险操作：写回次数异常（试用每日 50 次）、危险命令
- **审计中心**
  - 查询：按用户/时间/事件类型/workspace
  - 导出：CSV（团队版后置也行）
- **系统设置**
  - 试用期长度
  - 配额默认值（按 plan）
  - AI 写回门禁策略（试用每日 50 次）
  - 风险命令黑名单/白名单

---

## 4) 最小后端接口（与现有 /api 统一）

> 这里是“后台需要的最小接口集合”，不绑定具体实现语言。

- Auth
  - `POST /api/auth/login`
  - `POST /api/auth/logout`
  - `GET /api/me`（返回 user + role + plan/quota）
- Admin（需要 admin 角色）
  - `GET /api/admin/stats`
  - `GET /api/admin/users?query=&page=`
  - `GET /api/admin/users/{id}`
  - `POST /api/admin/users/{id}/disable`
  - `POST /api/admin/users/{id}/grant-trial`（延长试用）
  - `POST /api/admin/users/{id}/grant-subscription`（手工开通月付）
  - `GET /api/admin/audit?userId=&type=&from=&to=`

---

## 5) 数据表（MVP，SQLite 友好）

- `users`
- `subscriptions`
- `quota_overrides`（可选）
- `usage_counters`（按日/按月统计写回次数）
- `audit_events`
- `recharge_orders`（可选：人工对账）
- `ledger_entries`（可选：每月扣费/退款/人工调整）

---

## 6) 运营闭环（按月收费 + 先试用）

- 新用户注册 → 自动进入 `trialing`（例如 7 天）
- 试用期接近到期（T-1）：
  - 前端提示续费
  - 后台可看到“将到期名单”
- 到期：
  - 自动切 `expired`
  - 产品进入只读模式（可打开文件/查看历史，禁止写回）
- 续费：
  - `active`，恢复写回能力与更高配额

---

## 7) 部署与运维要点（MVP）

- 后台与前台共用一套 API，减少部署面
- `AUTH_SECRET` 必须稳定（否则 cookie 失效）
- 审计数据建议独立表并限制增长（按月归档/删除策略）


