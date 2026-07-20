# 海外订阅服务 API 契约草案

## 结论

这份接口草案不是另起一套新平台，而是基于现有仓库里的账号、订阅、账本和 admin 思路，补一条边界更清楚的海外订阅链路。

重点有三条：

- 用户侧、支付侧、运营后台、平台运维四条接口线要分开
- 支付回调、退款、封禁和管理员改配都必须可审计
- 不把节点细节直接暴露给用户侧接口

## 1. 接口分区

### 1.1 用户侧

用户能看到自己的账号、订阅、交付和支持信息。

### 1.2 支付侧

支付商 webhook、退款回调、争议状态同步只走机器接口，不给前端直接调用。

### 1.3 运营后台

给客服、运营和管理员查订单、调订阅、封禁和处理工单。

### 1.4 平台运维

给平台组看节点库存、容量、在线率和事故公告，不和用户中心混在一起。

## 2. 用户侧接口

### `GET /api/me/subscription`

返回当前用户订阅和基础权益。

响应示例：

```json
{
  "ok": true,
  "subscription": {
    "status": "active",
    "plan": "monthly",
    "currentPeriodStart": 1775328000,
    "currentPeriodEnd": 1777920000,
    "cancelAtPeriodEnd": false,
    "trialEndsAt": null,
    "gracePeriodEndsAt": null
  },
  "entitlements": {
    "deviceLimit": 3,
    "regionLimit": 2,
    "supportTier": "ticket"
  }
}
```

### `POST /api/billing/orders`

创建支付订单。

请求示例：

```json
{
  "plan": "monthly",
  "months": 1,
  "provider": "stripe",
  "currency": "USD"
}
```

响应示例：

```json
{
  "ok": true,
  "order": {
    "id": "ord_01",
    "status": "created",
    "provider": "stripe",
    "amountCents": 9900,
    "currency": "USD",
    "clientSecret": "masked_or_provider_specific",
    "expiresAt": 1775331600
  }
}
```

### `GET /api/me/billing`

延续现有 `账单 + 订单 + 账本` 聚合能力，但建议补上币种和退款字段。

响应字段建议：

| 字段 | 说明 |
| --- | --- |
| `orders` | 用户订单列表 |
| `ledger` | 入账、退款、人工调整、订阅扣费 |
| `refunds` | 退款与争议处理记录 |
| `balanceCents` | 余额模式下的可用余额 |
| `subscription` | 当前订阅摘要 |

### `GET /api/me/deliveries`

查看当前交付和最近变更记录。

响应示例：

```json
{
  "ok": true,
  "items": [
    {
      "id": "del_01",
      "status": "active",
      "deliveryType": "subscription_bundle",
      "region": "us-west",
      "updatedAt": 1775330000,
      "expiresAt": 1777920000
    }
  ]
}
```

### `POST /api/me/support/tickets`

创建支持请求。

请求示例：

```json
{
  "category": "billing",
  "subject": "Payment succeeded but subscription not active",
  "content": "Order ord_01 was charged but still shows pending."
}
```

## 3. 支付侧接口

### `POST /api/billing/webhooks/{provider}`

支付商回调入口。

要求：

- 必须验签
- 必须幂等
- 原始报文入库
- 返回 2xx 前必须明确是否已落账或明确拒绝

处理步骤建议：

1. 记录原始事件到 `payment_webhook_events`
2. 验签
3. 找订单
4. 做状态映射
5. 写账本或退款记录
6. 写管理员/系统审计

### `POST /api/admin/billing/refunds`

运营后台发起退款。

请求示例：

```json
{
  "orderId": "ord_01",
  "amountCents": 9900,
  "reason": "service_unavailable"
}
```

### `POST /api/billing/disputes/{provider}`

支付争议同步入口。

这个接口不一定第一阶段就对外开放，但表结构和事件处理最好一开始就留出来。

## 4. 运营后台接口

### `GET /api/admin/overseas/overview`

返回海外订阅运营总览。

响应示例：

```json
{
  "ok": true,
  "summary": {
    "usersTotal": 120,
    "subscriptionsActive": 38,
    "trialingUsers": 22,
    "pendingOrders": 4,
    "refundsPending": 1,
    "abuseOpen": 3
  }
}
```

### `GET /api/admin/subscriptions`

查询订阅列表，支持按状态、套餐、到期时间筛选。

查询参数建议：

- `status`
- `plan`
- `page`
- `pageSize`
- `keyword`

### `POST /api/admin/subscriptions/{userId}/suspend`

暂停用户订阅。

请求示例：

```json
{
  "reason": "abuse_detected",
  "effectiveImmediately": true
}
```

### `POST /api/admin/subscriptions/{userId}/resume`

恢复订阅。

### `GET /api/admin/abuse-events`

查询滥用、封禁和申诉记录。

### `POST /api/admin/users/{userId}/ban`

冻结账号、停用交付，并写审计。

### `POST /api/admin/users/{userId}/unban`

解除冻结，并写审计。

## 5. 平台运维接口

### `GET /api/admin/nodes`

返回节点库存。

字段建议：

| 字段 | 说明 |
| --- | --- |
| `region` | 区域 |
| `provider` | 供应商 |
| `status` | healthy / degraded / down |
| `capacityLimit` | 容量上限 |
| `activeUsers` | 当前承载用户数 |
| `costMonthlyCents` | 月成本 |
| `updatedAt` | 最近更新时间 |

### `GET /api/admin/nodes/health`

返回聚合健康指标，不直接暴露底层检测细节。

### `GET /api/admin/status/incidents`

运营和平台查看对外事故公告。

### `POST /api/admin/status/incidents`

创建事故公告或状态更新。

## 6. 通用错误码建议

| code | 场景 |
| --- | --- |
| `NotLoggedIn` | 未登录 |
| `AdminOnly` | 需要管理员权限 |
| `InvalidProvider` | 不支持的支付商 |
| `OrderNotFound` | 订单不存在 |
| `WebhookSignatureInvalid` | webhook 验签失败 |
| `DuplicateWebhookEvent` | webhook 重放或重复处理 |
| `SubscriptionNotActive` | 订阅未生效 |
| `RefundNotAllowed` | 不满足退款策略 |
| `AbuseActionBlocked` | 命中风控限制 |
| `NodeUnavailable` | 当前无可用区域可分配 |

## 7. 审计要求

这些动作应当强制写 `admin_audit_events`：

- 人工改订阅状态
- 人工退款
- 封禁/解封
- 手工回收交付
- 节点库存状态人工变更
- 事故公告创建和关闭

## 8. 与现有仓库的映射建议

| 当前能力 | 建议动作 |
| --- | --- |
| `GET /api/me/billing` | 扩字段，不要重写整个账单模型 |
| `POST /api/me/subscription/activate` | 保留余额订阅逻辑，未来可并行支持第三方支付 |
| `/api/admin/recharge_orders` | 继续保留，后面扩到 provider 订单视图 |
| `AdminHome.tsx` | 在现有后台里新增“海外订阅运营”分区，不混入 `ops` 工作区 |
