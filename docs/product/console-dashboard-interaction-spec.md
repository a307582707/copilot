# 控制台 & 资产管理 全量交互规格（最新需求版）

> 适用范围：`/app`（Web App）内的 **控制台（dashboard）**、**资产管理（ssh mode）**、**聊天（chat mode）**、**插件（plugins mode）**。  
> 目标：在现有代码基础上，补齐并规范交互，使产品具备：  
> - 控制台：引导用户下一步（新增主机/创建工作区/发起对话）  
> - 资产管理：工作区 + 资产库（Inventory）闭环（导入/导出/分组/标签/凭据）  
> - 主机能力：真实连接（终端）、文件浏览/编辑、与 AI 协作（上下文篮）  
>
> 重要提示（代码现状对齐）：当前仓库里“连接/文件”仍有占位与伪连接逻辑，整改路线见：`docs/product/assets-management-remediation.md`。

---

## 0. 术语与页面映射（对齐现有代码）

### 0.1 模式（mode）与页面
- `dashboard`：控制台（概览）
- `ssh`：资产管理（工作区 + 资产库 Inventory）
- `chat`：聊天（模型选择器在输入框右侧）
- `plugins`：插件（目前为占位/列表）

### 0.2 数据模型（对齐 `frontend/src/host-config/types.ts`）
- **资产（Asset）**：主机配置（name/address/port/username/tags/credentialId/project/env…）
- **工作区（Workspace）**：绑定 assetId + rootPath 的工作入口（pinned/lastOpenedAt…）
- **标签（Tag）** / **分组（Group）** / **凭据（Credential）**
- 本地存储：`localStorage(host_config_v2)`（`frontend/src/host-config/storage.ts`）

---

## 1. 控制台（dashboard）交互规格（现状可落地）

### 1.1 顶部（面包屑 + 全屏）

```text
控制台 > 概览                             [全屏模式/退出全屏]
```

- 点击“控制台”：复位最近访问 Tab、关闭抽屉、清空搜索、滚动到顶部（现有已实现）
- 全屏：只做 UI 专注态（现有 `dashFullscreen`）

### 1.2 智能概览（新手引导 / KPI）

#### 1.2.1 新手引导（host=0）
- Step1：新增主机（按钮“去添加”→ HostEditor Modal）
- Step2/Step3：锁定展示（待解锁）

#### 1.2.2 KPI（host>0）
- 资产主机 / 活跃工作区 / 已装插件 / 本月对话  
- 点击 KPI：切换到对应模块（ssh/plugins/chat）

### 1.3 快捷操作（Quick Actions）
- 新建主机（Primary）→ HostEditor Modal
- 导入资产 → Import Modal
- 安装插件 → 切 `plugins`
- 发起对话 → 切 `chat`

### 1.4 最近访问 & 资源清单（Tabs）

Tabs：最近访问 / 我的主机 / 活跃工作区

#### 1.4.1 我的主机（现状）
每行操作（现状）：
- ⚡ 连接：当前行为是“创建默认工作区并进入资产管理”（伪连接）
- 📂 文件：占位 alert
- ⚙️：编辑主机（HostEditor）
- 删除：本地软删除

目标态要求：
- ⚡ 连接 → “连接终端”，成功后写 lastConnectedAt
- 📂 文件 → 文件浏览器

---

## 2. 聊天（chat）交互规格

### 2.1 模型选择器（仅聊天页显示）
位置：输入框右侧 select（现状）
- Loading：`模型列表加载中…`
- 无模型：`无法获取模型列表`（disabled）

---

## 3. 资产管理（ssh mode）交互规格（现状可落地）

> 现状主骨架：左侧 `HostSidebar`（工作区 + 资产库 Inventory），右侧 Workspace Detail。

### 3.1 左侧：工作区列表（Workspace List）

#### 3.1.1 搜索
- 占位：`搜索工作区/资产...`
- 输入即过滤（HostSidebar 内有 debounce）
- 无匹配显示 CTA：`新建主机 / 导入资产`

#### 3.1.2 工作区行交互
- 点击：activeWorkspaceId = 该工作区 → 右侧显示详情
- 置顶/取消置顶
- 删除（二次确认：不会删除主机）

### 3.2 左侧底部：资产库 Inventory（现状）

#### 3.2.1 折叠/展开
- 点击标题行：展开/折叠
- 右侧 `+`：新增主机（stopPropagation）

#### 3.2.2 资产行交互
- 点击行：activeHostId = assetId，activeWorkspaceId = null
- 行内按钮：
  - `+WS`：创建工作区
  - `编辑`：HostEditor

### 3.3 创建工作区 Drawer（现状已实现）
字段：工作区名称 / rootPath / 创建后置顶 + 校验 + Toast + 设为 active。

---

## 4. 主机编辑（HostEditor）与“凭据安全”规范（必须）

> 目标：用户不产生“输入密码不安全”的顾虑；默认推荐私钥/Agent；密码仅本次使用不保存。

### 4.1 认证方式顺序
```text
[ SSH 私钥（推荐） ]  [ 密码（不推荐） ]  [ 跳板机/Agent ]
```

### 4.2 测试连接（现状可用）
- 调用 `/api/ssh/test`（TCP + banner）
- UI：测试中/成功/失败原因（用户语言）

### 4.3 保存 / 保存并连接（目标态约束）
- 保存：仅保存配置
- 保存并连接：必须依赖“真实连接成功”后才能写 lastConnectedAt 并进入终端/工作区

---

## 5. 文件能力（目标态交互规格）

### 5.1 文件入口
- 主机行：📂 文件
- 工作区视图：文件树

### 5.2 文件浏览器（Drawer 或 Workspace View）
```text
路径面包屑：/srv/www  [复制路径] [刷新]
工具条：[新建文件] [新建文件夹] [上传] [下载] [搜索]
列表：名称 | 大小 | 修改时间 | 操作(…)
右侧：预览/编辑器（文本）
```

关键交互：
- 删除/覆盖：二次确认
- 编辑：未保存提示，离开前确认
- 大文件：限制与提示（仅下载或分块）

---

## 6. 终端能力（目标态交互规格）

### 6.1 P0：非交互 exec
- `POST /api/ssh/exec`：单条命令，返回 stdout/stderr/exit_code
- 用途：探测/脚本/文件列表临时过渡

### 6.2 P1：交互式 PTY（WebSocket）
- `WS /api/terminal/ws`
- 断线重连、心跳、会话上限

---

## 7. 主机 × AI 协作（目标态：Context Basket）

### 7.1 上下文篮（Context Basket）
可见可控：
- 主机 / 工作区(rootPath) / 文件片段 / 终端输出(N 行)
动作：
- 移除单项 / 清空 / 裁剪

### 7.2 从文件/终端加入上下文
- 文件：`发送给 AI` → 确认敏感信息 → 加入篮
- 终端：`问 AI` → 选择范围（50/200/自定义）→ 加入篮

---

## 8. “+” 统一语义规范（避免“到处都是 +”）

只允许 3 类：
1) 全局 +（新建中心）：弹“新建菜单”
2) 模块级 +：上下文新增（必须有文字/Tooltip）
3) 空状态 CTA：用明确按钮文案，不用裸 +

---

## 9. 分阶段验收清单（建议）

### P0
- 去除伪连接：lastConnectedAt 只在真实连接成功后写
- exec 可用：超时/错误分类/输出可控
- 文件 list/read/write 可用：路径安全/大小限制/写入确认
- AI 上下文篮可见可删：支持引用文件/终端输出

### P1
- PTY 稳定：断线重连/心跳/会话上限
- 文件全能力：上传/下载/重命名/删除

# 控制台 & 资产管理 全量交互规格（最新需求版）

> 适用范围：`/app`（Web App）内的 **控制台（dashboard）**、**资产管理（ssh mode）**、**聊天（chat mode）**、**插件（plugins mode）**。  
> 目标：在现有代码基础上，补齐并规范交互，使产品具备：  
> - 控制台：引导用户下一步（新增主机/创建工作区/发起对话）  
> - 资产管理：工作区 + 资产库（Inventory）闭环（导入/导出/分组/标签/凭据）  
> - 主机能力：真实连接（终端）、文件浏览/编辑、与 AI 协作（上下文篮）  
>
> 重要提示（代码现状对齐）：当前仓库里“连接/文件”仍有占位与伪连接逻辑，整改路线见：`docs/product/assets-management-remediation.md`。

---

## 0. 术语与页面映射（对齐现有代码）

### 0.1 模式（mode）与页面
- `dashboard`：控制台（概览）
- `ssh`：资产管理（工作区 + 资产库 Inventory）
- `chat`：聊天（模型选择器在输入框右侧）
- `plugins`：插件（目前为占位/列表）

### 0.2 数据模型（对齐 `frontend/src/host-config/types.ts`）
- **资产（Asset）**：主机配置（name/address/port/username/tags/credentialId/project/env…）
- **工作区（Workspace）**：绑定 assetId + rootPath 的工作入口（pinned/lastOpenedAt…）
- **标签（Tag）** / **分组（Group）** / **凭据（Credential）**
- 本地存储：`localStorage(host_config_v2)`（`frontend/src/host-config/storage.ts`）

---

## 1. 控制台（dashboard）交互规格（现状可落地）

### 1.1 顶部（面包屑 + 全屏）

```text
控制台 > 概览                             [全屏模式/退出全屏]
```

- 点击“控制台”：复位最近访问 Tab、关闭抽屉、清空搜索、滚动到顶部（现有已实现）
- 全屏：只做 UI 专注态（现有 `dashFullscreen`）

### 1.2 智能概览（新手引导 / KPI）

#### 1.2.1 新手引导（host=0）
- Step1：新增主机（按钮“去添加”→ HostEditor Modal）
- Step2/Step3：锁定展示（待解锁）

#### 1.2.2 KPI（host>0）
- 资产主机 / 活跃工作区 / 已装插件 / 本月对话  
- 点击 KPI：切换到对应模块（ssh/plugins/chat）

### 1.3 快捷操作（Quick Actions）
- 新建主机（Primary）→ HostEditor Modal
- 导入资产 → Import Modal
- 安装插件 → 切 `plugins`
- 发起对话 → 切 `chat`

### 1.4 最近访问 & 资源清单（Tabs）

Tabs：最近访问 / 我的主机 / 活跃工作区

#### 1.4.1 我的主机（现状）
每行操作（现状）：
- ⚡ 连接：当前行为是“创建默认工作区并进入资产管理”（伪连接）
- 📂 文件：占位 alert
- ⚙️：编辑主机（HostEditor）
- 删除：本地软删除

目标态要求：
- ⚡ 连接 → “连接终端”，成功后写 lastConnectedAt
- 📂 文件 → 文件浏览器

---

## 2. 聊天（chat）交互规格

### 2.1 模型选择器（仅聊天页显示）
位置：输入框右侧 select（现状）
- Loading：`模型列表加载中…`
- 无模型：`无法获取模型列表`（disabled）

---

## 3. 资产管理（ssh mode）交互规格（现状可落地）

> 现状主骨架：左侧 `HostSidebar`（工作区 + Inventory），右侧 Workspace Detail。

### 3.1 左侧：工作区列表（Workspace List）

#### 3.1.1 搜索
- 占位：`搜索工作区/资产...`
- 输入即过滤（HostSidebar 内有 debounce）
- 无匹配显示 CTA：`新建主机 / 导入资产`

#### 3.1.2 工作区行交互
- 点击：activeWorkspaceId = 该工作区 → 右侧显示详情
- 置顶/取消置顶
- 删除（二次确认：不会删除主机）

### 3.2 左侧底部：资产库 Inventory（现状）

#### 3.2.1 折叠/展开
- 点击标题行：展开/折叠
- 右侧 `+`：新增主机（stopPropagation）

#### 3.2.2 资产行交互
- 点击行：activeHostId = assetId，activeWorkspaceId = null
- 行内按钮：
  - `+WS`：创建工作区
  - `编辑`：HostEditor

### 3.3 创建工作区 Drawer（现状已实现）
字段：工作区名称 / rootPath / 创建后置顶 + 校验 + Toast + 设为 active。

---

## 4. 主机编辑（HostEditor）与“凭据安全”规范（必须）

> 目标：用户不产生“输入密码不安全”的顾虑；默认推荐私钥/Agent；密码仅本次使用不保存。

### 4.1 认证方式顺序
```text
[ SSH 私钥（推荐） ]  [ 密码（不推荐） ]  [ 跳板机/Agent ]
```

### 4.2 测试连接（现状可用）
- 调用 `/api/ssh/test`（TCP + banner）
- UI：测试中/成功/失败原因（用户语言）

### 4.3 保存 / 保存并连接（目标态约束）
- 保存：仅保存配置
- 保存并连接：必须依赖“真实连接成功”后才能写 lastConnectedAt 并进入终端/工作区

---

## 5. 文件能力（目标态交互规格）

### 5.1 文件入口
- 主机行：📂 文件
- 工作区视图：文件树

### 5.2 文件浏览器（Drawer 或 Workspace View）
```text
路径面包屑：/srv/www  [复制路径] [刷新]
工具条：[新建文件] [新建文件夹] [上传] [下载] [搜索]
列表：名称 | 大小 | 修改时间 | 操作(…)
右侧：预览/编辑器（文本）
```

关键交互：
- 删除/覆盖：二次确认
- 编辑：未保存提示，离开前确认
- 大文件：限制与提示（仅下载或分块）

---

## 6. 终端能力（目标态交互规格）

### 6.1 P0：非交互 exec
- `POST /api/ssh/exec`：单条命令，返回 stdout/stderr/exit_code
- 用于：探测/脚本/文件列表临时过渡

### 6.2 P1：交互式 PTY（WebSocket）
- `WS /api/terminal/ws`
- 断线重连、心跳、会话上限

---

## 7. 主机 × AI 协作（目标态：Context Basket）

### 7.1 上下文篮（Context Basket）
可见可控：
- 主机 / 工作区(rootPath) / 文件片段 / 终端输出(N 行)
动作：
- 移除单项 / 清空 / 裁剪

### 7.2 从文件/终端加入上下文
- 文件：`发送给 AI` → 确认敏感信息 → 加入篮
- 终端：`问 AI` → 选择范围（50/200/自定义）→ 加入篮

---

## 8. “+” 统一语义规范（避免“到处都是 +”）

只允许 3 类：
1) 全局 +（新建中心）：弹“新建菜单”
2) 模块级 +：上下文新增（必须有文字/Tooltip）
3) 空状态 CTA：用明确按钮文案，不用裸 +

---

## 9. 分阶段验收清单（建议）

### P0
- 去除伪连接：lastConnectedAt 只在真实连接成功后写
- exec 可用：超时/错误分类/输出可控
- 文件 list/read/write 可用：路径安全/大小限制/写入确认
- AI 上下文篮可见可删：支持引用文件/终端输出

### P1
- PTY 稳定：断线重连/心跳/会话上限
- 文件全能力：上传/下载/重命名/删除


