## AIOps Runbook（执行器）— MVP 规范

### 1) 目标

把 Agent 的“动作”从自由文本变成**可控、可审计、可回滚**的声明式 Runbook。\n
MVP 只支持 **只读 shell（shell_ro）**，用于证据采集与验证；高风险写入类动作后续再扩展。\n

### 2) Runbook JSON 结构（MVP）

```json
{
  "kind": "runbook",
  "steps": [
    { "type": "shell_ro", "cmd": "uptime", "timeoutSec": 10 },
    { "type": "shell_ro", "cmd": "df -h", "timeoutSec": 10 }
  ],
  "verify": [
    { "type": "shell_ro", "cmd": "uptime", "timeoutSec": 10 }
  ],
  "rollback": [
    { "type": "shell_ro", "cmd": "uptime", "timeoutSec": 10 }
  ]
}
```

### 3) 执行约束（MVP）

- `steps` 最多 20 条\n
- `verify` 最多 10 条\n
- `rollback` 最多 10 条\n
- 每步必须带硬超时（默认 10s，上限 30s）\n
- `shell_ro` 命令 **严格 allowlist**（避免任何写入/破坏性命令）\n

### 4) 返回结构（MVP）

- 成功：`{ ok: true, steps: [...], verify: [...], rolledBack: false }`\n
- 失败：`{ ok: false, steps: [...], rolledBack: true|false, rollback: [...] }`\n

### 5) 与审批/策略的关系

- `risk=high` 的 action 默认必须先 `approve` 才能 `execute`\n
- `risk=low` 且命中策略白名单的 action 可 `autopilot` 自动执行\n
- 全过程写入 `aiops_actions`（状态机）与 `aiops_evidence`（证据包）\n

