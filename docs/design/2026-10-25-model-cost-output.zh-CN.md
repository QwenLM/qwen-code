# 用逐响应输出 token 计算模型成本

[English](2026-10-25-model-cost-output.md) | [简体中文](2026-10-25-model-cost-output.zh-CN.md)

## 问题与范围

PR #15464 修复 reasoning 被包含在输出中却重复计费的问题，但在聚合后推导计费输出，会丢失哪些请求缺少 total 的信息。一条 reasoning 独立计数的响应包含 prompt 100000、candidates 50000、thoughts 120000 和 total 270000，随后另一条响应包含 prompt 20000、candidates 10000 且没有 total，正确计费输出应为 180000。聚合后相减却得到 150000。缺少 total 的 OpenAI 响应也仍然存在原有重复计费。

目标是使 Ink、OpenTUI 和非交互模型统计的输出成本一致。保留原始 token 计数、定价、managed usage 序列化及历史用量与仪表盘计费行为。

## 设计

在累加每条 API 响应之前计算可计费输出。只有当该响应的 total 减 prompt 位于 candidates 到 candidates 加 thoughts 的区间内时，才接受这个差值。否则，对于输出已经包含 reasoning 的 `openai`、`openai-responses` 和 `qwen-oauth`，使用 candidates；对于独立计数的 usage，使用 candidates 加 thoughts。按模型和来源累加逐响应结果，保存在原始模型统计之外的可选同级映射中。

同级映射可以保持 managed usage 的封闭 schema 不变。修改原始 total 会影响其他消费者；在原始模型或 token 记录中增加字段会破坏 managed 记录校验。状态复制、相等判断、重放回滚和重置必须同步处理计费映射。可能与原型属性重名的模型或来源键，需像其他 telemetry 字典一样安全处理。

成本展示优先使用逐响应累加的权威值，包括零值。缺少该值的已有快照或手动构造统计保留现有聚合回退。仅恢复原始统计的 managed 记录无法还原 provider 口径；后续响应不能让只包含新增请求的计数被当作完整历史总量。明确保留这个旧数据限制，不凭空推断缺失历史。

## 验证与验收

- 完整 OpenAI usage 计费 150000 而非 270000；完整独立计数 usage 仍为 170000。
- 缺少 total 的 OpenAI usage 只计一次 candidates，独立计数 usage 保留 reasoning。
- 同一来源的混合序列无论响应顺序都计费 180000，拆分来源后总和不变。
- 原始计数和 managed 模型 JSON 的数值与结构保持不变。
- 计费数据经过 UI 状态复制和重放回滚后仍正确；重置清空；仅恢复原始历史时，不把不完整历史总量作为精确值发布。
- 所有成本展示使用权威计数，并保持零费用及缺少定价的行为。

针对性回归测试使用真实 telemetry 累加，验证展示金额，并执行构建、类型检查和受影响包的测试。兼容性数据证明受支持的 metadata 缺失路径，不代表捕获到线上 provider 行为。不需要新增 provider 请求或定价规则。
