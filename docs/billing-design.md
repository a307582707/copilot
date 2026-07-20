# CodeSprite 计费方案（SaaS / 预付费 + 订阅，可落地）

本文面向当前仓库的 `saas_api/`（FastAPI + SQLite）实现，目标是在不引入复杂依赖的前提下，做出可上线、可审计、可回滚的计费系统。

## 1. 目标与约束

### 1.1 目标

- **可上线**：先做“预付费余额 + 按量扣费”（P0），再逐步引入订阅与更精确的 token 计费（P1/P2）。
- **可审计**：每一次扣费都有可追溯的 `request_id`/`ref_id`，避免重复扣费。
- **可并发**：同一用户多并发请求时，余额扣减要正确，且不出现双扣/穿透。
- **可容错**：上游模型失败/中断时，计费要么不扣、要么按规则扣“最低服务费”（可配置）。
- **可运营**：支持后台加款/退款/人工补偿，能看核心指标（收入、成本、毛利、活跃）。

### 1.2 约束与现状

- 现有 DB：`users / subscriptions / recharge_orders / ledger / sms_codes`（见 `saas_api/app/db.py`）。
- 现有余额：通过 `ledger.amount_cents` 求和得到（见 `saas_api/app/accounting.py`）。
- 现有 LLM：`saas_api/app/llm_gateway.py` 流式转发（Ollama + OpenAI-compat），**没有回传 usage/成本**。
- 现有 `POST /api/chat`：在 `saas_api/app/main.py` 中实现，**当前不做登录校验**。

## 2. 核心数据模型（账本为主）

### 2.1 不变原则：所有余额变动都进入 `ledger`

`ledger` 作为总账（不可变更/只追加），余额为：

\[
balance(user) = \sum ledger.amount\_cents \;\;(\text{user\_id = uid})
\]

建议将 `ledger.entry_type` 规范化为枚举：

- `recharge`：充值入账（+）
- `refund`：退款出账（-）或冲正（+）
- `adjust`：人工调账（+/-）
- `llm_usage`：LLM 用量扣费（-）
- `llm_refund`：LLM 退款/冲正（+）
- `subscription_grant`：订阅赠送/周期额度入账（+）（可选）

### 2.2 新增：`llm_usage` 明细表（成本与用量审计）

新增表（P0 即可上）：

- `llm_usage`
  - `id`（request_id，主键）
  - `user_id`
  - `model`（用户选择后的模型名，可能含 `{upstream}/{model}`）
  - `upstream`（命中上游名称）
  - `status`：`ok|error|canceled|blocked`
  - `prompt_chars / completion_chars`（P0 用于估算）
  - `prompt_tokens / completion_tokens`（P1 起优先使用真实 token）
  - `cost_cents`（最终扣费金额，冪等写入）
  - `started_at / finished_at`
  - `error`（脱敏）

### 2.3 幂等：为 `ledger` 增加唯一索引（强烈建议）

为避免重复扣费/重复入账：

- `UNIQUE(user_id, entry_type, ref_id)`

约定：

- `llm_usage` 的 `ref_id` = `llm_usage.id`
- `recharge` 的 `ref_id` = `recharge_orders.id`

这样同一 request/order 即使重试也不会双扣。

## 3. 定价模型（从 P0 到 P2）

### 3.1 P0（可快速上线）：按字符计费（可配置）

对每次 LLM 调用计算：

- `prompt_chars = len(final_msg)`（包含 context 拼接后的文本）
- `completion_chars = len(streamed_text)`（输出累计）

定价配置（环境变量 JSON）：

- `BILLING_PRICING_JSON`（示例）
  - `default`: `{ "prompt_per_1k_chars_cents": 2, "completion_per_1k_chars_cents": 6, "min_charge_cents": 1 }`
  - 可按 `model` 覆盖

优点：实现简单、稳定、无需依赖上游返回 usage。

### 3.2 P1：优先使用上游真实 token（更公平）

- Ollama：在 stream 完成时通常能拿到 `prompt_eval_count/eval_count`（可用作 prompt/completion tokens）
- OpenAI-compat：部分供应商支持 `stream_options.include_usage=true` 或最终 SSE 帧带 `usage`

如果拿到 token，则按 token 计费；拿不到则回落到字符估算。

### 3.3 P2：订阅 + 周期额度（更好的商业化）

订阅只解决“门槛/权益”，账本依然用 `ledger` 表达额度发放与扣减：

- 每周期（比如每月）自动写一条 `subscription_grant`（+）
- 仍然对每次调用写 `llm_usage`（-），并把成本记录在 `llm_usage`

这样订阅/按量统一到同一个账本模型里。

## 4. 扣费时机与并发策略

### 4.1 P0 推荐：**后扣费 + 事前门槛校验 + 输出上限**

流式场景想做到“绝对不欠费”，必须有“预算上限”：

- 开始前校验：余额 >= `min_required_cents`（例如 10 分），否则直接 `blocked`
- 流式中：根据余额估算最大可输出字符数，超过则主动截断并结束（返回“余额不足，请充值”提示）
- 结束后：按实际用量写 `llm_usage`，再写 `ledger(llm_usage)` 扣费

优点：实现简单，可避免无限输出导致欠费。

### 4.2 事务与锁

SQLite 并发写入必须用事务串行：

- 关键扣费/入账操作使用 `BEGIN IMMEDIATE`（或 Python 中 `conn.execute("BEGIN IMMEDIATE")`）
- 扣费写入 `ledger` 时依赖唯一索引保证幂等

### 4.3 失败/取消策略（建议可配置）

- 上游失败（502/timeout）：默认 `cost_cents = 0`，只记录 `llm_usage.status=error`
- 用户取消：默认 `cost_cents = 0` 或 `min_charge_cents`（可配置）
- 余额不足中断：记录 `blocked`，可按已输出部分计费（更公平）

## 5. 充值与入账（先做可运营 MVP）

### 5.1 充值订单状态机（建议）

`recharge_orders.status`：

- `created`：创建订单
- `paid`：支付成功（来自支付回调）
- `credited`：已入账（写入 `ledger(recharge)` 完成）
- `canceled`：取消
- `failed`：失败

入账动作必须幂等：用 `ref_id = order_id` 写 `ledger(recharge)`，唯一索引防双入账。

### 5.2 P0 支付方案（可快速上线）

- **后台人工加款**（最简单）：管理员接口创建 `adjust` 或 `recharge` 入账
- **后续对接支付**：支付宝/微信/Stripe 均可；只要回调触发“订单状态->paid”，再执行“入账->credited”

## 6. API 建议（最小集）

面向用户：

- `GET /api/me`（已有）：返回 `balanceCents`、订阅信息
- `GET /api/me/billing`（已有）：返回订单与台账
- `POST /api/billing/recharge/create`（P1）：创建充值订单
- `POST /api/billing/webhook/<channel>`（P1）：支付回调（签名校验+幂等）

面向内部（admin）：

- `POST /api/admin/billing/adjust`：人工加款/退款
- `GET /api/admin/billing/stats`：收入/成本/毛利/活跃
- `GET /api/admin/billing/usage`：用量明细（分页）

## 7. 最小落地路线（建议 3 天）

- **Day 1（P0）**：建 `llm_usage` 表 + `ledger` 唯一索引；实现“按字符计费”；`/api/chat` 强制登录（生产可开关）
- **Day 2**：输出上限 + 余额不足中断；补 admin 调账接口；补基础报表
- **Day 3（P1）**：提取上游 token usage（Ollama/OpenAI-compat），按 token 优先计费

## 8. 需要你拍板的 4 个配置项（决定我们默认行为）

- `CHAT_REQUIRE_AUTH`：生产是否强制登录才能调用 `/api/chat`
- `BILLING_ENABLED`：是否开启扣费（关闭时只记录 `llm_usage`，不写 `ledger`）
- `BILLING_PRICING_JSON`：定价（默认价、按模型覆盖）
- `BILLING_MIN_BALANCE_CENTS`：开聊的最低余额门槛

## 9. 远程 SSH 试用（你已选择：7 天 + 每天 3 session + 每天 30 次操作）

默认策略（可通过 env 调整）：

- `SSH_TRIAL_DAYS=7`
- `SSH_TRIAL_SESSIONS_PER_DAY=3`：每天允许创建 3 个 SSH session（`/api/ssh/connect`）
- `SSH_TRIAL_OPS_PER_DAY=30`：每天允许 30 次“操作”（`/api/ssh/exec`、`/api/files/*`、`/api/ssh/pty/ws`）

试用结束后：

- **必须订阅**：订阅状态为 `active/paid` 才允许访问 SSH（试用结束即 402）
- **可用余额订阅**：通过后端接口用余额扣款开通订阅（无需先接第三方支付）

订阅（余额开通）接口（MVP）：

- `POST /api/me/subscription/activate`
  - body: `{ "plan": "pro|team", "months": 1, "requestId": "sub_xxx" }`
  - 行为：写入 `ledger(subscription_fee)` 扣款，并把 `subscriptions.status` 置为 `active`，延长 `current_period_end`

