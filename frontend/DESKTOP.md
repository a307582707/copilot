## Desktop Client (Windows + macOS) — Tauri

本项目可以把现有 Web UI 直接做成跨平台桌面客户端（Windows/macOS），推荐使用 **Tauri**（体积小、启动快、UI 100% 复用）。

### 目录结构

- `frontend/`：Web UI（Vite + React + TS）
- `frontend/src-tauri/`：Tauri 桌面壳（Rust）

---

## 前置条件

### Windows 10/11

- **WebView2 Runtime**（多数系统已自带；若无请安装）
- **Rust**（MSVC toolchain）
- **Visual Studio Build Tools**（C++ Desktop workload）

建议命令（PowerShell）：

- 安装 Rust：`winget install Rustlang.Rustup`
- 安装 VS Build Tools：`winget install Microsoft.VisualStudio.2022.BuildTools`

> 如果你的机器没有 `winget`，也可用官网安装包。

### macOS

- **Xcode Command Line Tools**：`xcode-select --install`
- **Rust**：`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`

---

## 运行（开发模式）

在 `frontend/` 目录执行：

1) 安装依赖：

- `npm install`

2) 启动桌面端（会自动启动 Vite dev server 并打开桌面窗口）：

- `npm run desktop:dev`

如果你只想跑 Web：

- `npm run dev`（然后打开 `http://127.0.0.1:5173`）

---

## 打包（发布）

在 `frontend/` 目录执行：

- `npm run desktop:build`

产物位置（Tauri 默认）：

- Windows：`frontend/src-tauri/target/release/bundle/`
- macOS：`frontend/src-tauri/target/release/bundle/`

---

## 验证点（最小可用）

- 桌面窗口能打开并加载 UI（与 Web 版一致）
- 左侧“主机配置/聊天/插件”切换正常
- 5173 dev server 可正常被桌面端访问（dev 模式）

---

## 回滚

如果要移除桌面端相关改动：

- 删除 `frontend/src-tauri/`
- 删除 `frontend/package.json` 中 `desktop:*` scripts 与 `@tauri-apps/cli` 依赖


