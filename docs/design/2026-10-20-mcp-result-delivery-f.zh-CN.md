# Hosted MCP 故障门禁 FG12f：结果与 catalog 投递

[English](2026-10-20-mcp-result-delivery-f.md) | [简体中文](2026-10-20-mcp-result-delivery-f.zh-CN.md)

## 问题与范围

Issue #14447 的 FG12f 行要求四种投递行为：在 Broker 或 Runtime 不可用时重放已提交的原始结果；把超过 60 KiB 的原始应答按输出上限结算且不留 hold；在有调用在飞时送达 `notifications/tools/list_changed` 且不重发该调用；以及在 `outcome_unknown` 之后送达迟到结论时恰好结算一次。本切片覆盖前三格。第四格目前没有能结算迟到应答的生产路径，因此记录为未覆盖缺口，不用用例去声称。

## 现状

- `hosted-mcp-session.ts` 的 `localOperationView()` 在任何派发之前就用 `record.resultRef` 回答重复的 operation id，所以已结算结果可以不联系 Runtime 直接重放。
- `managed-mcp-runtime.ts` 的 `receive()` 拒绝大于 `MAX_RESULT_BYTES`（`60 * 1024`）的已解析结果，结算为 `managed_mcp_output_limit`；落库记录为 `run.state = failed`、`run.execution = settled`，而即时响应仍保留传输层视图。
- 通知处理只对活连接自增 `catalogRevision`、累加 `catalogChanges[kind]` 并把 `discovery[kind]` 标为 `'stale'`，不会回写 `mcp_configuration` 记录。
- `unknown()` 置 `outcome_unknown`，随后 `client.onclose` 连同 pending 一起关闭连接，因此此后到达的应答只能通过新连接下同 id 的重新派发来结算。

## 决定

1. **新增一个类、四格。** `HostedMcpResultDeliveryIT` 承载重放、输出上限、列表变更与迟到结论四格，复用应答丢失类已有的 Broker 代理装置与私有控制面。
2. **重放在两层取证。** 同一 operation id 提交两次；第二次应答必须等于已发布的 `resultRef` 内容，且不得新增 `mcp-invoke` 控制或 Broker 交换，落库记录数保持一条。
3. **输出上限通过落库记录取证。** 61 KiB 的资源读取结算为 `managed_mcp_output_limit`，落库记录为 `failed`/`settled`，夹具恰好记录一次副作用，随后的关闭到达 `released` 且不再补发 invoke，因此没有留下 hold。
4. **列表变更只钉当前实现确有的行为。** 夹具在回答读取之前发出 `notifications/tools/list_changed`；用例断言恰好一次 invoke、一次副作用，以及该调用保持启动时的 `catalogRevision`。issue 里「产生新配置代际」这一条不断言，因为本树的通知不会回写配置记录，断言它等于钉一个并不存在的行为。
5. **迟到应答不进入本切片。** `outcome_unknown` 之后的结算需要 Broker 或 Harness 的迟到结算路径，目前不存在；补它是生产改动，不是门禁，仍记为缺口。
6. **预算按实测重钉。** 三格在 JDK 21 + MySQL 8.0.46 上多轮实测 13.98-16.01 s，按 2 倍计给健康总和加 30 s。健康的绝对值、fork、Verify 与 job 上限均钉在 `scripts/tests/hosted-process-ci.test.js`，本文不再复述：main 每落一个 Hosted 类它们就会变，而正文里抄写的字面值在评审中已漂移两次。

## 验收

- 四格在 MySQL 8.x 车道通过，证据落在 `target/fg12-cases/fg12f/<tenant>/`。
- 元测试 roster 含 `HostedMcpResultDeliveryIT`，上述 fork 账目在 `hosted-process-ci.test.js` 中成立。
