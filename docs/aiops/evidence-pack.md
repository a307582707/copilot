## AIOps Evidence Pack（证据包）— 结构与存储（MVP）

### 1) 定义

证据包是一次故障（incident）的**最小审计闭环产物**，包含：\n
- 输入：告警与事件（events）\n
- 决策：策略引擎判定、动作建议（actions.decision_json）\n
- 动作：runbook、审批记录、执行记录（actions.*）\n
- 输出：证据采集结果（evidence.content）\n
- 验证与回滚：runbook 的 verify/rollback 输出（作为 evidence 或 action_result）\n

### 2) API

- `GET /api/aiops/incidents/{id}/evidence_pack`（admin）\n
  返回：`{ ok: true, pack: { incident, events, evidence, actions } }`

### 3) 数据库表（SQLite）

#### 3.1 `aiops_incidents`
- 记录故障主对象：状态、严重级别、fingerprint、labels、meta（包含 silence 信息）。\n

#### 3.2 `aiops_events`
- 每条原始事件（告警）一行：labels/annotations/raw 以 JSON 文本存储。\n

#### 3.3 `aiops_evidence`
- 人工或 autopilot 采集的证据：\n
  - `kind`: `autopilot_evidence|action_result|audit|text|...`\n
  - `content`: 文本（MVP 限长）\n

#### 3.4 `aiops_actions`
- 动作建议/执行记录：\n
  - `risk`: `low|high`\n
  - `status`: `proposed|pending_approval|approved|running|succeeded|failed|cancelled`\n
  - `runbook_json`: runbook 定义（JSON 文本）\n
  - `decision_json`: policy/LLM 生成的决策摘要（JSON 文本）\n
  - `approved_by/approved_at`: 审批信息\n
  - `started_at/finished_at/exit_code/error`: 执行结果\n

### 4) 证据包大小与安全约束（MVP）
- 所有 JSON 文本字段都有**长度上限**（防止 payload 注入拖垮 DB）\n
- 默认不存储超大 stdout/stderr；如需保留可升级为对象存储并在 evidence 里引用 URL\n
- 任何执行凭据/密钥禁止落入 evidence/decision（只记录引用与脱敏信息）\n

