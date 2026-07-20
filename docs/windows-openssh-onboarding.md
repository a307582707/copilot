## Windows 主机接入（OpenSSH / 22）指引

目标：让 Windows 主机像 Linux 一样支持 **命令执行 / 文件浏览 / 终端**（统一走 SSH/SFTP）。

### 适用范围
- Windows 10 / Windows Server（建议 2019/2022）
- 你需要有 **管理员权限** 执行一次性初始化

---

## 1) 一键启用 OpenSSH Server（推荐）

在 Windows 上 **以管理员身份运行 PowerShell**，执行：

```powershell
$ErrorActionPreference = "Stop"

# 安装 OpenSSH Server（如已安装则跳过）
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

# 启动并设为开机自启
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic

# 放行 22 端口（Windows 防火墙）
if (-not (Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
}

# 查看状态
Get-Service sshd
Get-NetTCPConnection -LocalPort 22 -State Listen | Select-Object -First 5
```

预期：
- `Get-Service sshd` 显示 Running
- 22 端口处于 Listen 状态

---

## 2) 云主机还需要放行安全组（非常常见）

如果你的 Windows 是云厂商主机，还需要在 **安全组/防火墙** 放行 TCP 22：
- **公网连接**：放行 `0.0.0.0/0 -> 22`（不推荐长期全开；建议只放行办公出口 IP）
- **内网连接**：放行内网网段到 22

建议：
- 最小化放行源 IP
- 开启审计/登录日志（便于追踪）

---

## 3) 在 CodeSprite 里验证

在“资产管理 → 新增主机”里选择：
- OS：Windows
- Port：22

点击：
1. **测试 22 端口（OpenSSH）**：用于确认 22 可达并读到 SSH banner（不需要密码）
2. 填好用户名/密码后再 **保存并连接主机**

---

## 4) 常见故障排查（按现象）

### A. “timeout”
通常是：
- 安全组没放行 22
- 网络不通 / 路由不通（例如公网 IP 不可达、NAT 未配置）
- 目标主机 sshd 未启动

排查顺序：
1. Windows 上确认 `sshd` Running
2. Windows 上确认 22 Listen
3. 云安全组放行 22

### B. “Connection refused”
通常是：
- 22 未监听（sshd 没启动/装失败）
- 防火墙/安全软件直接拒绝

### C. “认证失败”
这是登录阶段的问题：
- 用户名不对（Windows 常见：`Administrator` 或创建的本地用户）
- 密码不对
- 账号被禁用/无权限

---

## 5) 安全建议（生产环境）
- 22 端口尽量限制来源（仅办公出口/NAT）
- 优先使用 **密钥登录**（替代密码）
- 定期轮转凭据，配合审计留存

