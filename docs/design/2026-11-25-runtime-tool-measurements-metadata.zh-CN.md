# Runtime 工具测量 Metadata

[English](2026-11-25-runtime-tool-measurements-metadata.md) | [简体中文](2026-11-25-runtime-tool-measurements-metadata.zh-CN.md)

状态：本地已实现；CI 验收待完成

调研基线：`f38f6fe7c3e`

## 问题

v4 工具结果的 `diagnostics` 成员具有封闭的四键结构，但 Java 代码通过
`Map<String, Object>` 构造和消费它。尽管 `RuntimeToolMeasurements` 已定义并检查
该外壳，读取方仍依赖字符串键，导致协议不够直观，并在 transport、对账和持久化之间
散播强制转换。

完整工具结果不能变成固定 DTO：其内容和 `measurements` 载荷仍是动态 JSON。

## 目标与非目标

- 引入一个具名 `RuntimeToolMeasurements.Metadata` 值，表示 `protocolVersion`、
  `executionProtocol`、`measurements` 和 `resultDigest`。
- 让 attachment、acknowledgement、对账和持久化消费强类型值。
- 保持外层动态 result 和动态 `measurements` 载荷。
- 保持历史 result JSON、digest 计算、错误码和幂等 attachment 行为。

本次不修改 HTTP wire schema、SQL、TypeScript、OpenAPI 或工具结果形状，也不对
`metadata(result)` 返回的值增加新校验；该方法保持当前仅检查四个 key 的行为。

## 设计

`Metadata` 是嵌套 record，并提供 `wireValue()` 投影。其分量在读取历史值时保留原
JSON 值，不做强制类型转换，避免仅因引入 Java 字段类型而拒绝旧数据。`attach` 新建
值仍使用既定类型：整数协议字段和小写十六进制 digest 字符串。

`wireValue()` 按原顺序输出相同四个 key，并使用 `BrokerValues.immutableMap`，在值
附着到 result 时保持递归 JSON 不可变性。`metadata(result)` 检查封闭 key set 后提供
具名访问器，不再返回原始 Map。

`ToolExecutionRecord.withMeasurements`、`ToolExecutionRepository.attachMeasurements`
及其 JDBC 实现接收 `Metadata`。相等性和幂等判断继续对 wire 投影使用
`BrokerValues.sameJsonMap`，而不是 record `equals`，因为持久化前后 JSON 数字子类型
可能不同。

`HttpRuntimeTransport.acknowledgeV4` 读取 `resultDigest()`，
`RuntimeExecutionReconciler` 将 `metadata(observed)` 传入强类型仓储边界。任何消费方
都不直接序列化该 record。

## 兼容性约束

- `measurements` 即使为 null 也必须存在，不能省略该 key。
- `attach` 仍在构造 metadata 前对 `{executionProtocol,result,measurements}` 计算 digest。
- `metadata(result)` 不新增协议版本、digest 格式或载荷类型校验。
- `withMeasurements` 仍拒绝冲突 metadata，并对相同 JSON 值保持幂等。
- 只有 `wireValue()` 可以重新进入 result JSON 或持久化边界。

## 影响文件

生产改动限定为 `RuntimeToolMeasurements`、`ToolExecutionRecord`、
`ToolExecutionRepository`、`JdbcToolExecutionRepository`、
`JdbcToolExecutionObservations`、`RuntimeExecutionReconciler` 和
`HttpRuntimeTransport`。

现有 v4 transport 和对账测试改用具名访问器。聚焦值测试覆盖显式 null、旧值原样透传、
封闭 key 和不可变 wire 快照。本地证据包括两套 Checkstyle 及受影响的 v4 transport/
对账测试；完整 Java、MySQL、Hosted 和 fault profile 仍由 CI 验收。

## 实现证据

聚焦套件通过 229/229，并编译全部生产及 verification 测试源码。每个模块（含 verification）的两套 Checkstyle 均报告 0 violation。独立类尺寸运行仍报告 `AgentSessionPolicies` 和 `AgentTurnExecution` 的两项既有违规；本切片未修改这两个类，该失败不计为通过。完整 Java、MySQL、Hosted、fault 和归档 profile 仍待 CI 验收。

完整生产/测试 diff 已按 wire 相等性、JSON 数字比较、null 处理和签名覆盖完成自审。未修改 TypeScript 或 SQL。

## 验收标准

1. 四个 metadata 字段均有具名 Java 访问器，动态 result/payload 类型不变。
2. 历史 result JSON、digest 字节、错误码和幂等 attachment 行为保持不变。
3. 聚焦 v4 transport/对账测试和两套 Checkstyle 通过，或将未运行证据明确列为待验证。
4. 在独立小 PR 提交前完成完整小 diff 自审。
