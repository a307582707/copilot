## AIOps Alert Ingest（告警接入）— MVP 事件字段规范

本规范用于 `AIOps-Agent` 的第一阶段数据源：**Webhook（兼容 Alertmanager）**。

### 1) 接口

- **Ingest Endpoint**：`POST /api/aiops/alerts`
- **鉴权（默认强约束）**
  - **推荐**：配置环境变量 `AIOPS_INGEST_TOKEN`，并在请求头带 `X-AIOPS-Token: <token>`
  - 若未配置 token：仅允许 **管理员 Cookie 会话** 调用（防止公网误灌）

### 2) 支持的 Payload 形态

#### 2.1 Alertmanager Webhook（推荐）

兼容 Alertmanager `webhook_config` 的基本结构：

```json
{
  "receiver": "aiops",
  "status": "firing",
  "alerts": [
    {
      "status": "firing",
      "labels": {
        "alertname": "HostDown",
        "severity": "critical",
        "env": "prod",
        "service": "nginx",
        "instance": "10.0.0.1:9100"
      },
      "annotations": {
        "summary": "HostDown",
        "description": "node exporter down"
      },
      "startsAt": "2026-01-29T08:00:00Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "fingerprint": "optional-from-alertmanager"
    }
  ],
  "groupLabels": {},
  "commonLabels": {},
  "commonAnnotations": {}
}
```

**归一化规则（MVP）**：

- `source`：`payload.source` 或默认 `alertmanager`
- `severity`：
  - `labels.severity` / `labels.level` / `payload.status` 归一化为 `info|warn|critical`
- `title`：
  - 优先 `annotations.summary`，其次 `labels.alertname`，否则 `"Alert"`
- `fingerprint`：
  - 优先使用 `alert.fingerprint`
  - 为空则计算：`sha256({title}+sorted(labels))[:24]`
- `labels/annotations`：合并 `commonLabels/commonAnnotations` 与 alert 内部字段（alert 内优先）
- 时间：
  - `startsAt/endsAt` 支持 RFC3339

#### 2.2 通用 Webhook（简单接入）

```json
{
  "source": "cms|prometheus|custom",
  "title": "NATGatewayDown",
  "description": "ngw-xxx unreachable",
  "severity": "critical",
  "fingerprint": "optional",
  "labels": {
    "env": "prod",
    "region": "us-west-1",
    "service": "network"
  },
  "annotations": {
    "runbook": "https://internal/runbook/xxx"
  },
  "startsAt": 1769670000
}
```

### 3) MVP 事件字段（NormalizedAlert）

系统内部统一字段（用于去重/归并/审计）：

| 字段 | 类型 | 说明 |
|---|---|---|
| source | string | 来源标识（alertmanager/cms/custom） |
| fingerprint | string | 去重键（同类告警归并） |
| severity | enum | info / warn / critical |
| title | string | 一句话摘要 |
| description | string | 详细描述（可为空） |
| labels | object | 结构化维度（env/service/instance/region/...） |
| annotations | object | 人类可读补充信息（runbook/link/owner/...） |
| starts_at | int? | epoch seconds |
| ends_at | int? | epoch seconds |
| raw | any | 原始 payload（用于证据与追溯，MVP 以 JSON 文本落库） |

### 4) 建议的 labels 约定（为了后续 Autopilot 风险边界）

- `env`：`dev|staging|prod`
- `service`：服务名（如 `nginx`/`mysql`）
- `cluster` / `namespace`（K8s）
- `region`（云）
- `owner` / `oncall`（值班人/团队）

> Autopilot 默认仅允许 `AIOPS_AUTOPILOT_ENVS=dev,staging` 中的环境自动执行低风险动作（可通过环境变量调整）。

### 5) 示例：curl（带 token）

```bash
curl -fsS -X POST "https://codesprite.example.com/api/aiops/alerts" \
  -H "Content-Type: application/json" \
  -H "X-AIOPS-Token: <AIOPS_INGEST_TOKEN>" \
  -d '{"source":"custom","title":"HostDown","severity":"critical","labels":{"env":"staging","service":"nginx"}}'
```

