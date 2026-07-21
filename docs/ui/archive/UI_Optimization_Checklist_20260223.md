# CodeSprite UI 完善与优化清单

## 🔴 P0 致命级：严重阻塞主流程或不可用

### 1. 工作区 AI 聊天弹窗遮罩层（Overlay）拦截所有点击，致使页面“卡死”
* **现象/问题**：在工作区模式下，点击左侧的“AI 聊天”会滑出抽屉弹窗，但此时界面上生成了一个全屏遮罩（大小甚至占满了 `left: 48px` 以右的所有空间），拦截了**所有**的用户点击事件。用户无法点击工作区的内容，且点击遮罩外部或按 ESC 均无法关闭该弹窗，导致流程完全卡死。
* **文件/组件**：
  * `frontend/src/App.tsx`：`<div className="wsNavFlyoutOverlay" />` 和相关弹窗渲染逻辑。
  * `frontend/src/App.css`：`.wsNavFlyoutOverlay` 样式（`z-index` 或 `pointer-events` 配置问题）。

### 2. 工作区内底部的“聊天输入框”完全不可见
* **现象/问题**：进入工作区模式（侧边栏收缩至 48px，主界面包含终端和聊天）后，用于向 AI 发送指令的底部输入框（带 `输入消息…` placeholder 的 textarea）实际上在 DOM 中存在，但是在屏幕上不可见（可能高度被压缩为 0，或者被父级容器裁切隐藏了）。
* **文件/组件**：`frontend/src/App.tsx` 中绑定了 `maxHeight: wsChatBottomH` 样式的 `<textarea className="textarea">`，高度状态 `wsChatBottomH` 计算或 flex 布局可能存在异常。

### 3. “资产管理”侧边栏顶部的 “+” 添加按钮被覆盖，无法点击
* **现象/问题**：在资产列表区域，设计用来添加主机的 `+` 按钮由于 z-index 错乱，被一个没有任何实际交互的空 `<div>` 覆盖，导致无论怎么点都无法触发“添加资产”的弹窗。
* **文件/组件**：`frontend/src/host-config/HostSidebar.tsx` 内渲染 `+` 按钮（`onClick` 触发添加逻辑）的头部区域。

---

## 🟡 P1 高优级：核心交互逻辑违背直觉

### 4. 侧边栏的 “>>>” (折叠) 按钮被遮挡无法点击
* **现象/问题**：在展开了资产或聊天的宽侧边栏后，右上角的“折叠/收起”按钮（`>>>`）同样被上方的拦截层覆盖。不仅用户点击无反应，在 Console 中也会提示 click 靶点拦截，导致用户无法正常缩起侧边栏。
* **文件/组件**：`frontend/src/App.tsx` 里的 `<button className="btn" aria-label="折叠">`，位于 `<div className="wsNavFlyoutHeader">` 内。

### 5. “AI 聊天” 及左侧滑出面板缺乏通用的直觉式关闭逻辑
* **现象/问题**：由于上面提到的遮罩层逻辑缺失/Bug，现在开启左侧飞出面板（Flyout）后，交互违背直觉：用户潜意识想点击侧边空白处或者按键盘 `ESC` 来关闭左侧面板，但这两者均无效。
* **文件/组件**：`frontend/src/App.tsx` 中的 `wsNavFlyoutOverlay` onClick 似乎被其他层拦截，以及缺乏全局对 `Escape` 键监听并调用 `setWsNavFlyout(null)` 的逻辑。

---

## 🟢 P2 中优级：键盘操作流与视觉体验瑕疵

### 6. 无法通过 ESC 键关闭右侧“文件/终端”抽屉
* **现象/问题**：点击右上角“文件/终端”能成功划出右侧抽屉面板。但是对于偏好键盘操作的用户，习惯性按下 `ESC` 键期望关闭该面板，却毫无反应，必须强迫用户把鼠标移上去再点一次按钮，阻断了操作流。
* **文件/组件**：`frontend/src/App.tsx` 的右侧面板区域，缺乏对 `Escape` 键的监听并执行 `setWsToolsOpen(false)` 的处理。

### 7. 发送按钮（禁用态）的视觉反馈不明显
* **现象/问题**：当聊天输入框内容为空时，发送按钮在逻辑上确实禁用了（不可点击），但在 UI 上并没有清晰的灰色、透明度或禁用样式变化，导致用户无法直观感受到“按钮当前不可用”。
* **文件/组件**：`frontend/src/App.tsx` 内聊天发送按钮 (`actionBtnSend`) 以及对应的 CSS 样式 (`frontend/src/App.css`)，需补充 `:disabled` 状态的透明度或颜色处理。

---

## 💡 网络与控制台健康状况总结
* **网络请求**：除了一个预期内的 telemetry 端口（`localhost:7242/ingest/`）报错外，所有的核心 API 接口（`/api/health`, `/api/me`, `/api/inventory/state`）**全部返回 200 正常，没有任何 4xx/5xx 错误**。
* **JS 报错**：浏览器的 Console 没有持续报出应用红字错误，代码本身运行十分稳定，**绝大多数问题全部集中在 CSS 的 z-index 冲突及遮罩层管理上**。
