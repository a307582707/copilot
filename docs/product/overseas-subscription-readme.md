# 海外订阅服务文档总览

## 结论

这组文档的目标不是教人把节点服务直接搭出来，而是把一个面向海外用户的订阅型网络接入服务，先收敛成可判断、可上线、可回滚的最小业务闭环。

仓库里已经有一部分可复用的账号、订阅、账本和后台基础：

- `docs/billing-design.md`
- `docs/product/codesprite-saas-design.md`
- `docs/product/admin-console-mvp-spec.md`
- `docs/sre/codesprite-user-storage.md`
- `saas_api/app/db.py`
- `saas_api/app/saas.py`

但这些内容当前更偏现有 `CodeSprite` 的国内计费与后台语境，缺少一套专门针对海外订阅业务的边界、范围、平台拆分和试运营手册。这组文档补的是这一层。

## 文档清单

- `docs/product/overseas-subscription-business-checklist.md`
  - 业务边界、合规前提、支付和托管商检查项
- `docs/product/overseas-subscription-mvp.md`
  - 第一阶段只做什么、不做什么，以及可卖闭环
- `docs/product/overseas-subscription-architecture.md`
  - 平台模块、数据边界、接口分层和后台能力
- `docs/product/overseas-subscription-pilot-sop.md`
  - 试运营指标、日常值守、退款、封禁、故障和回滚
- `docs/product/overseas-subscription-api-contract.md`
  - 用户侧、支付侧、运营后台、平台运维接口契约
- `docs/product/overseas-subscription-data-model.md`
  - 账务、交付、风控、节点和审计的数据模型

## 使用方式

建议按下面顺序推进，而不是先从节点数量或协议细节入手：

1. 先看 `overseas-subscription-business-checklist.md`
2. 确认主体、支付、托管商和 AUP 没有硬性阻塞
3. 再按 `overseas-subscription-mvp.md` 收敛首发范围
4. 用 `overseas-subscription-architecture.md` 对齐产品、后端、后台和运营职责
5. 再看 `overseas-subscription-api-contract.md` 和 `overseas-subscription-data-model.md`
6. 最后按 `overseas-subscription-pilot-sop.md` 准备试运营

## 默认假设

这组文档默认基于下面几个假设，如果现场不一致，应先修正文档再推进实施：

- 主体和主要客户区域均在海外
- 服务对象是公众订阅用户，不是企业内网 VPN
- 业务需要账号、订阅、支付、交付、客服和风控闭环
- 不把现有 `ops` 工作区或大数据运维页面直接当成订阅运营后台

## 明确不包含的内容

这些文档刻意不展开下面几类实现细节：

- 公开代理节点的具体搭建步骤
- 绕过网络限制的技术细节
- 规避托管商、支付商或地区监管的对抗方案

原因很直接：这些内容不是这个项目最缺的，真正决定项目能不能跑起来的是合规、支付、风控、运维和支持能力。
