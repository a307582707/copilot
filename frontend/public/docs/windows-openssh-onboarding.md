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

---

## 2) 云主机还需要放行安全组（非常常见）

如果你的 Windows 是云厂商主机，还需要在 **安全组/防火墙** 放行 TCP 22：
- 公网连接：按需放行 22（建议只放行办公出口 IP）
- 内网连接：放行内网网段到 22

---

## 3) 在 CodeSprite 里验证

在“资产管理 → 新增主机”里选择：
- OS：Windows
- Port：22

点击：
1. **测试 22 端口（OpenSSH）**（不需要密码）
2. 填好用户名/密码后再 **保存并连接主机**

