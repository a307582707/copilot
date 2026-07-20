## AIOps Incident 状态机与事件归并（MVP）

### 1) 状态机（强约束）

状态集合：`triage -> investigating -> mitigating -> verifying -> resolved`

允许的转移（MVP）：

- `triage` → `investigating` / `resolved`
- `investigating` → `mitigating` / `verifying` / `resolved`
- `mitigating` → `verifying` / `resolved`
- `verifying` → `resolved` / `investigating`（验证失败可回退）
- `resolved` → `triage`（仅手工“重新打开”；正常应由新事件触发新 incident）

> 约束目的：保证每个故障都有可审计的阶段推进，避免“直接在 chat 里随意改状态”导致事后不可追溯。

### 2) 事件归并（Dedup / Correlate）

#### 2.1 去重键（fingerprint）

- 优先使用上游提供的 `fingerprint`（如 Alertmanager）
- 否则计算：`sha256({title}+sorted(labels))[:24]`

#### 2.2 归并规则（MVP）

- 对同一 `fingerprint`：\n
  - 若存在未 `resolved` 的 incident：新告警作为 `aiops_events` 追加到该 incident\n
  - 若最新 incident 已 `resolved`：创建新的 incident（避免把新故障写进旧故障证据包）

#### 2.3 严重级别提升（Escalation）

- incident 的 `severity` 使用“最大严重级别”策略：`critical > warn > info`\n
  - 新事件为 `critical` 时会提升 incident `severity`，但不会自动降级

### 3) 抑制（Suppression / Silence）

MVP 支持对 incident 做“静默窗口”：\n
- `POST /api/aiops/incidents/{id}/silence`，默认 3600s\n
- 在静默期间：不会触发 autopilot（仍会入库 events）

### 4) 关联（Future）

后续可以在不破坏 MVP 模型的前提下增强：\n
- 基于 `labels.service/cluster/namespace/instance` 的相似度聚合\n
- Topology 关联（CMDB/ServiceMap）\n
- 多源信号融合（metrics + logs + traces + deploy events）

