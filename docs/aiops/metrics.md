## AIOps 指标与可观测（MVP）

### 1) 指标目标

用数据证明“智能化运维 Agent”带来的收益，并为误触发/误执行提供安全护栏。\n

### 2) API

- `GET /api/aiops/metrics`（admin）\n
  返回：\n
  - `mttd_avg_sec`\n
  - `mttr_avg_sec`\n
  - `evidence_completeness`（0~1）\n
  - `autopilot_success`（0~1）\n
  - `counts`（明细计数）\n

### 3) 口径（MVP）

- **MTTR(avg)**：`resolved_at - started_at` 的平均值（秒）\n
- **MTTD(avg)**：`first_event_received_at - started_at` 的平均值（秒）\n
- **证据完整率**：同时满足：\n
  - 至少 1 条 event\n
  - 至少 1 条非 audit evidence\n
- **Autopilot 成功率**：`collect_evidence_basic` action 的 `succeeded/(succeeded+failed)`\n

> 注意：MVP 口径偏工程侧，用于快速验证闭环；后续可升级为 SLO（如 P0 告警的 MTTR 分位数）。\n

