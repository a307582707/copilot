# 资产管理模块整改文档（代码现状核对 + 差距清单 + 迭代路线图）

> 目的：你后续按此文档逐项整改，实现“资产管理（主机）能真实连接主机、能浏览/编辑主机文件、能与 AI 上下文协作”的完整闭环。  
> 约束：本文以当前仓库现有代码为事实来源，避免凭空假设。  
> 范围：Web `/app` 内的 **控制台（dashboard）** + **资产管理（ssh mode）** + 后端 `/api/*`。

---

## 1. 现状快照（事实来源）

### 1.1 入口与路由
- Web App 入口：`/app` → `frontend/src/RouterApp.tsx` 渲染 `frontend/src/App.tsx`
- App 内部用 `mode` 切换页面：
  - `mode === 'dashboard'`：控制台（概览）
  - `mode === 'ssh'`：资产管理（工作区 + 资产库 Inventory）
  - `mode === 'chat'`：聊天（模型选择器在输入区右侧）
  - `mode === 'plugins'`：插件占位/列表

### 1.2 资产管理（前端）核心代码点
- 左侧栏（工作区 + Inventory）：`frontend/src/host-config/HostSidebar.tsx`
- 主状态（host_config_v2）：`frontend/src/host-config/storage.ts`（localStorage）
- 数据模型：`frontend/src/host-config/types.ts`
- 资产编辑弹窗（新增/编辑主机）：`frontend/src/App.tsx` 内 `HostEditor`
- 分组/标签管理：`frontend/src/App.tsx` 内 `GroupManager`/`TagManager`
- 导入/导出：`frontend/src/App.tsx` 内 import/export（JSON）

### 1.3 后端（现状 API 能力）
后端文件：`backend/app/main.py`

已存在且与“资产管理”相关的 API：
- `POST /api/ssh/test`：TCP 连通性探测 + 读 SSH banner（**不做认证，不建立会话**）

不存在（现状缺失）的关键 API：
- SSH 认证登录 / 终端会话（PTY/exec）
- 文件浏览/读写（SFTP/类 SFTP）
- AI 上下文注入（host/file/terminal 输出引用）

---

## 2. 需求对照（逐项核验）

> 目标：  
> 1) 主机模块能真的连到主机（终端可用）  
> 2) 能打开主机文件（浏览/编辑/上传/下载）  
> 3) 能与 AI 交互（把主机/文件/终端输出作为上下文）  
> 4) 资产管理模块形成闭环（工作区 + 资产库 + 导入导出 + 分组标签 + 凭据安全）

### 2.1 核验表（符合 / 不符合）

| 能力项 | 结论 | 代码证据（文件/行为） | 备注 |
|---|---|---|---|
| 新增/编辑主机（配置层） | ✅ | `App.tsx` `HostEditor` 保存到 `host_config_v2` | 仅本地配置 |
| 分组/标签管理 | ✅ | `App.tsx` `GroupManager`/`TagManager` | 本地状态 |
| 导入/导出 | ✅ | `App.tsx` import/export JSON + `storage.ts` | 导入 remap id 并 merge |
| 工作区列表/置顶/删除/搜索 | ✅ | `HostSidebar.tsx` + `App.tsx` | 搜索同时过滤 workspace+assets |
| +WS 从资产创建工作区（体验） | ✅ | `openWsCreateFromAsset` Drawer | 有校验与 Toast |
| 真实连接主机（SSH 认证+会话） | ❌ | 后端仅 `/api/ssh/test` | 当前前端“连接”是伪连接 |
| Web Terminal（可执行命令） | ❌ | 无 PTY/xterm/WS 相关实现 | 仅占位 |
| 文件浏览/编辑（SFTP/文件树） | ❌ | 前端存在占位 alert | 无后端文件 API |
| AI 上下文协作 | ❌ | `/api/chat` 仅 `{session_id,message,model}` | 无 Context Basket |

---

## 3. 关键问题：当前“连接”是伪连接（必须先纠偏）

### 3.1 当前“连接”做了什么（事实）
前端函数：`createWorkspaceAndEnter(h)`（`frontend/src/App.tsx`）
- 直接创建默认工作区（rootPath 固定 `/srv/www`）
- 直接把主机 `lastConnectedAt` 标记为当前时间
- 切到 `mode='ssh'`

风险：
- 用户误以为“已连通”，但实际未发生 SSH 认证/会话建立
- “在线/最近访问”数据不可信

整改原则（必须）：
- 把“连通性测试”与“真实连接”拆开：
  - **连通性测试**：继续使用 `/api/ssh/test`
  - **真实连接**：必须等后端会话能力落地后才提供；并在成功后写 lastConnectedAt

---

## 4. 目标能力拆分（最小闭环：SSH 会话 + 文件 + AI 上下文）

### 4.1 后端能力拆分
1) **SSH 会话服务（Terminal/Exec）**
- P0：HTTP `exec`（短命令，非交互）
- P1：WebSocket PTY（交互式终端）

2) **文件服务（SFTP/类 SFTP）**
- list/read/write/upload/download/rename/delete
- 路径防穿越、权限控制、大小限制

3) **AI 上下文服务（Context）**
- 支持携带 host/workspace/path/snippet/terminal tail
- 统一裁剪与可移除（前端 Context Basket）

### 4.2 建议 API（MVP→目标）

#### P0（最小可用，快速落地）
- `POST /api/ssh/test`（已存在）
- `POST /api/ssh/exec`：执行单条命令（非交互）
- `GET /api/files/list?hostId=&path=`：列目录
- `GET /api/files/read?hostId=&path=`：读文本小文件
- `POST /api/files/write`：写文件（可带 etag/版本号）

#### P1（体验提升）
- `WS /api/terminal/ws?sessionId=`：PTY
- `POST /api/files/upload` / `GET /api/files/download`

#### P2（企业能力）
- 凭据托管（Vault/KMS）、审计日志、RBAC、SSO

---

## 5. 迭代整改路线图（按 P0/P1/P2）

### P0：纠偏 + 真实能力最小闭环

#### P0-1 去除伪连接
- 把 UI “⚡连接”改为：
  - `连通性测试`（调用 `/api/ssh/test`）
  - `连接终端`（真实会话前置灰/隐藏或提示“即将支持”）
- 禁止在未真实连接时写 `lastConnectedAt`

验收：
- 测试仅产生“可达/不可达”结果
- 不再出现“假在线”

#### P0-2 实现 `/api/ssh/exec`（短命令）
用途：
- 工作区打开前探测：`pwd/ls/uname -a`
- 文件浏览的临时过渡（不推荐长期用 ls 代替 SFTP）

验收：
- stdout/stderr/exit_code 正确
- 有硬超时

#### P0-3 文件最小能力（list/read/write）
验收：
- 可列目录、读小文本、保存（带二次确认）
- 路径防穿越、大小限制

#### P0-4 AI 上下文篮（Context Basket）最小实现
- 前端：文件/终端输出“发送给 AI”
- 后端：`/api/chat` 支持 `context_items` 或新增 `/api/chat_with_context`

验收：
- AI 能引用文件片段/命令输出
- 上下文可移除/清空

---

### P1：交互式终端 + 完整文件
- WebSocket PTY：断线重连、心跳、会话上限
- 文件：上传/下载/重命名/删除

---

### P2：安全、审计、团队化
- 凭据加密存储、命令/文件审计、RBAC/SSO

---

## 6. 验证点（可重复）
- 连通性测试：延迟稳定、错误分类合理
- exec：超时可控、stderr/exit_code 正确
- 文件：路径安全、写入确认、失败可重试
- AI：上下文可见可删、默认不带敏感

---

## 7. 风险与安全基线（必须）
- 密码不默认、不持久化（默认推荐私钥/Agent；密码仅本次）
- 破坏性操作二次确认（删除/覆盖/递归）
- 最小权限：MVP 阶段限制命令与路径范围（至少给“高级模式”开关）

# 资产管理模块整改文档（代码现状核对 + 差距清单 + 迭代路线图）

> 目的：你后续按此文档逐项整改，实现“资产管理（主机）能真实连接主机、能浏览/编辑主机文件、能与 AI 上下文协作”的完整闭环。  
> 约束：本文以当前仓库现有代码为事实来源，避免凭空假设。  
> 范围：Web `/app` 内的 **控制台（dashboard）** + **资产管理（ssh mode）** + 后端 `/api/*`。

---

## 1. 现状快照（事实来源）

### 1.1 入口与路由
- Web App 入口：`/app` → `frontend/src/RouterApp.tsx` 渲染 `frontend/src/App.tsx`
- App 内部用 `mode` 切换页面：
  - `mode === 'dashboard'`：控制台（概览）
  - `mode === 'ssh'`：资产管理（工作区 + 资产库 Inventory）
  - `mode === 'chat'`：聊天（模型选择器在输入区右侧）
  - `mode === 'plugins'`：插件占位/列表

### 1.2 资产管理（前端）核心代码点
- 左侧栏（工作区 + Inventory）：`frontend/src/host-config/HostSidebar.tsx`
- 主状态（host_config_v2）：`frontend/src/host-config/storage.ts`（localStorage）
- 数据模型：`frontend/src/host-config/types.ts`
- 资产编辑弹窗（新增/编辑主机）：`frontend/src/App.tsx` 内 `HostEditor`
- 分组/标签管理：`frontend/src/App.tsx` 内 `GroupManager`/`TagManager`
- 导入/导出：`frontend/src/App.tsx` 内 import/export（JSON）

### 1.3 后端（现状 API 能力）
后端文件：`backend/app/main.py`

已存在且与“资产管理”相关的 API：
- `POST /api/ssh/test`：TCP 连通性探测 + 读 SSH banner（**不做认证，不建立会话**）

不存在（现状缺失）的关键 API：
- SSH 认证登录 / 终端会话（PTY/exec）
- 文件浏览/读写（SFTP/类 SFTP）
- AI 上下文注入（host/file/terminal 输出引用）

---

## 2. 需求对照（逐项核验）

> 目标：  
> 1) 主机模块能真的连到主机（终端可用）  
> 2) 能打开主机文件（浏览/编辑/上传/下载）  
> 3) 能与 AI 交互（把主机/文件/终端输出作为上下文）  
> 4) 资产管理模块形成闭环（工作区 + 资产库 + 导入导出 + 分组标签 + 凭据安全）

### 2.1 核验表（符合 / 部分符合 / 不符合）

| 能力项 | 结论 | 代码证据（文件/行为） | 备注 |
|---|---|---|---|
| 新增/编辑主机（配置层） | ✅ | `App.tsx` `HostEditor` 保存到 `host_config_v2` | 仅本地配置 |
| 分组/标签管理 | ✅ | `App.tsx` `GroupManager`/`TagManager` | 本地状态 |
| 导入/导出 | ✅ | `App.tsx` import/export JSON + `storage.ts` | 导入 remap id 并 merge |
| 工作区列表/置顶/删除/搜索 | ✅ | `HostSidebar.tsx` + `App.tsx` | 搜索同时过滤 workspace+assets |
| +WS 从资产创建工作区（体验） | ✅ | `openWsCreateFromAsset` Drawer | 有校验与 Toast |
| 真实连接主机（SSH 认证+会话） | ❌ | 后端仅 `/api/ssh/test` | 当前前端“连接”是伪连接 |
| Web Terminal（可执行命令） | ❌ | 无 PTY/xterm/WS 相关实现 | 仅占位 |
| 文件浏览/编辑（SFTP/文件树） | ❌ | 前端存在占位 alert | 无后端文件 API |
| AI 上下文协作 | ❌ | `/api/chat` 仅 `{session_id,message,model}` | 无 Context Basket |

---

## 3. 关键问题：当前“连接”是伪连接

### 3.1 当前“连接”做了什么（事实）
前端函数：`createWorkspaceAndEnter(h)`（`frontend/src/App.tsx`）
- 直接创建默认工作区（rootPath 固定 `/srv/www`）
- 直接把主机 `lastConnectedAt` 标记为当前时间
- 切到 `mode='ssh'`

风险：
- 用户误以为“已连通”，但实际未发生 SSH 认证/会话建立
- “在线/最近访问”数据不可信

整改原则（必须）：
- 把“连通性测试”与“真实连接”拆开：
  - **连通性测试**：继续使用 `/api/ssh/test`
  - **真实连接**：必须等后端会话能力落地后才提供；并在成功后写 lastConnectedAt

---

## 4. 目标能力拆分（最小闭环：SSH 会话 + 文件 + AI 上下文）

### 4.1 后端能力拆分
1) **SSH 会话服务（Terminal/Exec）**
- P0：HTTP `exec`（短命令，非交互）
- P1：WebSocket PTY（交互式终端）

2) **文件服务（SFTP/类 SFTP）**
- list/read/write/upload/download/rename/delete
- 路径防穿越、权限控制、大小限制

3) **AI 上下文服务（Context）**
- 支持携带 host/workspace/path/snippet/terminal tail
- 统一裁剪与可移除（前端 Context Basket）

### 4.2 建议 API（MVP→目标）

#### P0（最小可用，快速落地）
- `POST /api/ssh/test`（已存在）
- `POST /api/ssh/exec`：执行单条命令（非交互）
- `GET /api/files/list?hostId=&path=`：列目录
- `GET /api/files/read?hostId=&path=`：读文本小文件
- `POST /api/files/write`：写文件（可带 etag/版本号）

#### P1（体验提升）
- `WS /api/terminal/ws?sessionId=`：PTY
- `POST /api/files/upload` / `GET /api/files/download`

#### P2（企业能力）
- 凭据托管（Vault/KMS）、审计日志、RBAC、SSO

---

## 5. 迭代整改路线图（按 P0/P1/P2）

### P0：纠偏 + 真实能力最小闭环

#### P0-1 去除伪连接
- 把 UI “⚡连接”改为：
  - `连通性测试`（调用 `/api/ssh/test`）
  - `连接终端`（真实会话前置灰/隐藏或提示“即将支持”）
- 禁止在未真实连接时写 `lastConnectedAt`

验收：
- 测试仅产生“可达/不可达”结果
- 不再出现“假在线”

#### P0-2 实现 `/api/ssh/exec`（短命令）
用途：
- 工作区打开前探测：`pwd/ls/uname -a`
- 文件浏览的临时过渡（不推荐长期用 ls 代替 SFTP）

验收：
- stdout/stderr/exit_code 正确
- 有硬超时

#### P0-3 文件最小能力（list/read/write）
验收：
- 可列目录、读小文本、保存（带二次确认）
- 路径防穿越、大小限制

#### P0-4 AI 上下文篮（Context Basket）最小实现
- 前端：文件/终端输出“发送给 AI”
- 后端：`/api/chat` 支持 `context_items` 或新增 `/api/chat_with_context`

验收：
- AI 能引用文件片段/命令输出
- 上下文可移除/清空

---

### P1：交互式终端 + 完整文件
- WebSocket PTY：断线重连、心跳、会话上限
- 文件：上传/下载/重命名/删除

---

### P2：安全、审计、团队化
- 凭据加密存储、命令/文件审计、RBAC/SSO

---

## 6. 验证点（可重复）
- 连通性测试：延迟稳定、错误分类合理
- exec：超时可控、stderr/exit_code 正确
- 文件：路径安全、写入确认、失败可重试
- AI：上下文可见可删、默认不带敏感

---

## 7. 风险与安全基线（必须）
- 密码不默认、不持久化（默认推荐私钥/Agent；密码仅本次）
- 破坏性操作二次确认（删除/覆盖/递归）
- 最小权限：MVP 阶段限制命令与路径范围（至少给“高级模式”开关）


