## AIOps Policy（策略引擎）— MVP

策略引擎用于决定：某个 action 是否允许 autopilot、是否必须审批、是否被 kill-switch/freeze 强制阻断。\n

### 1) 核心原则

- **默认保守**：只对少量低风险 action 开启 autopilot\n
- **可停机**：全局 kill-switch 一键阻断执行\n
- **有冻结窗**：在变更窗口/敏感时段自动禁止 autopilot\n
- **范围收敛**：按 env/service/scope 白名单收敛执行面\n
- **频控**：避免 autopilot 失控风暴（rate limit）\n

### 2) 环境变量（MVP）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `AIOPS_KILL_SWITCH` | (空) | `1/true` 时阻断执行（即使已审批） |
| `AIOPS_FREEZE_UTC` | (空) | 冻结窗（UTC），如 `23:00-01:00`，冻结期间禁用 autopilot |
| `AIOPS_AUTOPILOT_ENVS` | `dev,staging` | 允许 autopilot 的环境白名单（labels.env） |
| `AIOPS_AUTOPILOT_SERVICES` | (空) | 允许 autopilot 的服务白名单（labels.service），不配置则不限制 |
| `AIOPS_AUTOPILOT_SCOPES` | (空) | 允许 autopilot 的 scope 白名单（labels.scope），不配置则不限制 |
| `AIOPS_AUTOPILOT_RATE_PER_H` | `3` | autopilot 每小时速率上限（进程内） |

### 3) 低风险 action allowlist（MVP）

仅以下 action 可能被 autopilot：\n
- `collect_evidence_basic`\n
- `silence_duplicates`\n

其余 action 只能“建议/审批/手工执行”，不会自动执行。\n

