# 海外订阅服务数据模型草案

## 判断

这套模型的核心不是“节点怎么配”，而是把四类状态拆清楚：

- 用户和订阅状态
- 订单和账务状态
- 交付状态
- 风控与运营状态

只要这四层混在一起，后面就会出现退款了但还在用、封禁了但没回收、支付回调到了但账没入这类问题。

## 1. 复用现有主表

这几张表在仓库里已经存在，建议继续作为主干：

| 表 | 作用 |
| --- | --- |
| `users` | 用户主档 |
| `subscriptions` | 当前订阅状态 |
| `recharge_orders` | 支付订单 |
| `ledger` | 入账、退款、调账、订阅扣费 |

### 1.1 `subscriptions` 建议补的字段

现有表可继续用，但如果进入海外订阅语境，建议逐步补下面这些字段：

| 字段 | 说明 |
| --- | --- |
| `plan` | 当前套餐 |
| `provider` | 当前主要支付商 |
| `currency` | 币种 |
| `current_period_start` | 当前周期开始 |
| `cancel_at_period_end` | 是否到期取消 |
| `grace_period_ends_at` | 宽限期结束时间 |
| `suspended_at` | 运营或风控暂停时间 |
| `suspend_reason` | 暂停原因 |

## 2. 新增领域表

### 2.1 `payment_webhook_events`

记录支付商原始回调。

| 字段 | 说明 |
| --- | --- |
| `id` | 内部事件 ID |
| `provider` | 支付商 |
| `event_id` | 支付商事件 ID |
| `event_type` | 事件类型 |
| `order_id` | 对应订单 |
| `signature_valid` | 验签是否通过 |
| `handled` | 是否已完成业务处理 |
| `payload_json` | 原始报文 |
| `received_at` | 接收时间 |
| `handled_at` | 处理完成时间 |

作用：

- 防重放
- 查 webhook 丢单
- 对账和复盘

### 2.2 `payment_refunds`

记录退款、部分退款和争议处理。

| 字段 | 说明 |
| --- | --- |
| `id` | 退款记录 ID |
| `order_id` | 原订单 |
| `provider` | 支付商 |
| `amount_cents` | 退款金额 |
| `currency` | 币种 |
| `status` | pending / succeeded / failed / disputed |
| `reason_code` | 退款原因 |
| `provider_ref` | 支付商退款号 |
| `created_by` | 发起人 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

### 2.3 `delivery_records`

把“订阅生效”和“用户真正拿到交付”拆开。

| 字段 | 说明 |
| --- | --- |
| `id` | 交付记录 ID |
| `user_id` | 用户 |
| `subscription_period_key` | 对应订阅周期 |
| `delivery_type` | 交付类型 |
| `status` | pending / active / expired / revoked / failed |
| `region` | 分配区域 |
| `device_limit` | 设备上限 |
| `config_version` | 配置版本 |
| `issued_at` | 发放时间 |
| `expires_at` | 到期时间 |
| `revoked_at` | 回收时间 |
| `meta_json` | 非敏感扩展信息 |

### 2.4 `device_registrations`

用于设备数限制和异常切换告警。

| 字段 | 说明 |
| --- | --- |
| `id` | 设备记录 ID |
| `user_id` | 用户 |
| `device_fingerprint` | 设备指纹 |
| `first_seen_at` | 首次出现 |
| `last_seen_at` | 最近出现 |
| `status` | active / blocked / revoked |
| `notes` | 备注 |

### 2.5 `abuse_events`

记录滥用、封禁和申诉。

| 字段 | 说明 |
| --- | --- |
| `id` | 事件 ID |
| `user_id` | 用户 |
| `category` | 注册滥用、带宽异常、投诉、退款欺诈等 |
| `severity` | low / medium / high |
| `status` | open / reviewing / resolved / rejected |
| `action_taken` | warn / suspend / ban / revoke_delivery |
| `evidence_json` | 证据索引 |
| `created_by` | 系统或管理员 |
| `created_at` | 创建时间 |
| `resolved_at` | 关闭时间 |

### 2.6 `node_inventory`

只放库存和运营健康，不放用户敏感配置。

| 字段 | 说明 |
| --- | --- |
| `id` | 节点 ID |
| `region` | 区域 |
| `provider` | 供应商 |
| `status` | healthy / degraded / down / draining |
| `capacity_limit` | 容量上限 |
| `active_users` | 当前承载 |
| `cost_monthly_cents` | 月成本 |
| `latency_p50_ms` | 延迟指标 |
| `online_rate` | 在线率 |
| `updated_at` | 最近刷新时间 |

### 2.7 `status_incidents`

对外事故和公告。

| 字段 | 说明 |
| --- | --- |
| `id` | 事故 ID |
| `status` | investigating / identified / monitoring / resolved |
| `title` | 标题 |
| `severity` | minor / major / critical |
| `scope_json` | 影响范围 |
| `message_md` | 对外文案 |
| `created_by` | 创建人 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |
| `resolved_at` | 解决时间 |

### 2.8 `admin_audit_events`

记录后台关键操作。

| 字段 | 说明 |
| --- | --- |
| `id` | 审计事件 ID |
| `actor_user_id` | 操作人 |
| `target_type` | user / subscription / refund / delivery / node |
| `target_id` | 目标记录 ID |
| `action` | suspend_subscription / refund / ban_user 等 |
| `before_json` | 变更前摘要 |
| `after_json` | 变更后摘要 |
| `reason` | 操作原因 |
| `created_at` | 创建时间 |

## 3. 状态机建议

### 3.1 订单状态

```text
created -> pending_payment -> paid -> credited -> closed
created -> pending_payment -> failed
paid -> refunded
paid -> disputed
```

说明：

- `paid` 表示支付商已确认成功
- `credited` 表示内部账务和订阅权益已经落地
- 如果 `paid` 和 `credited` 不拆开，补单和回放会很难做

### 3.2 订阅状态

```text
trialing -> active -> past_due -> expired
active -> canceled
active -> suspended
suspended -> active
```

说明：

- `suspended` 用于运营或风控介入
- `past_due` 用于自动续费失败后的宽限期

### 3.3 交付状态

```text
pending -> active -> expired
active -> revoked
pending -> failed
```

说明：

- 交付失败不等于订阅失败
- 退款、封禁和到期时都可能触发 `revoked`

## 4. 一致性规则

建议强制遵守下面几条：

### 4.1 订单和账本分离

- 订单表表达“支付过程”
- 账本表表达“金额事实”

不要把支付成功直接等价成“已入账已开通”。

### 4.2 订阅和交付分离

- 订阅生效只代表权益存在
- 交付记录才代表用户拿到了什么

### 4.3 风控和订阅状态分离

- 封禁原因和证据进 `abuse_events`
- 最终是否暂停订阅，再反映到 `subscriptions`

### 4.4 审计和业务主表分离

- 审计日志不混在用户或订阅表里
- 支持回溯“谁在什么时候改了什么”

## 5. 索引和幂等建议

| 对象 | 建议 |
| --- | --- |
| `ledger` | 保留 `(user_id, entry_type, ref_id)` 唯一约束 |
| `payment_webhook_events` | `provider + event_id` 唯一 |
| `payment_refunds` | `provider + provider_ref` 唯一 |
| `delivery_records` | `user_id + subscription_period_key + config_version` 索引 |
| `device_registrations` | `user_id + device_fingerprint` 唯一 |
| `admin_audit_events` | `actor_user_id + created_at` 索引 |

## 6. 不该进状态表的内容

这些东西不要塞进用户中心、订阅状态或普通交付记录里：

- 第三方支付密钥
- 供应商长期凭据
- 未脱敏原始投诉材料
- 不受控的大体积原始日志
- 明文敏感配置

## 7. 和现有仓库的迁移建议

建议顺序：

1. 保持 `users` / `subscriptions` / `recharge_orders` / `ledger` 不动主干
2. 先加 `payment_webhook_events` 和 `admin_audit_events`
3. 再加 `delivery_records`、`payment_refunds`、`abuse_events`
4. 最后再补 `node_inventory` 和 `status_incidents`

这样做的原因是账务和审计最怕补历史账，应该先稳定住。
