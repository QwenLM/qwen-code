# Managed java_durable 准入（Stage D7-3）

[English](2026-10-17-managed-java-durable-admission.md) | [简体中文](2026-10-17-managed-java-durable-admission.zh-CN.md)

状态：已在本次改动中实现，契约 `1.61.0`，schema 不变。

这是 [#14122](https://github.com/QwenLM/qwen-code/issues/14122)（[#12380](https://github.com/QwenLM/qwen-code/issues/12380) Stage D 的 D7 总 issue）的 **D7-3** 切片，由 [#14167](https://github.com/QwenLM/qwen-code/issues/14167) 跟踪。#12380 规定，只有同时具备持久命令投递和原命令对账，Stage D 才能暴露 `java_durable`。对 Turn 输入与取消来说，这两者都已在 `main` 上：D7-1（[Turn 命令 operation](2026-10-16-managed-turn-command-operations.zh-CN.md)）在每次准入时保存一个 `submit_input` 或 `cancel` operation；D7-2（[operation 对账](2026-10-17-managed-operation-reconciliation.zh-CN.md)）依据 Session journal 对准入未知的输入做对账。

## 问题

`java_durable` 过去只是一个结果，是没有 Harness 确认某个 operation 时记下的阶段。调用方无法主动请求它，也没有可以开关它的配置。Turn 准入以 `202` 返回 Turn id，D7-1 保存的 operation 对外不可见，所以客户端丢失响应后无从找回。契约在 `CommandAdmission` 和 `WebShellAdmission` 上预留了 `operation_id`、`admission_stage`、`delivery_state`，在 Session 能力上预留了 `durable_operations`，全部是 `planned`。

## 目标

来自 #12867 的 D7 行和 #14167：

- 未开启时该能力保持关闭。开关关闭时，行为与现在逐字节一致，而且这一点可以直接从配置类看出来。
- 开关打开时，`harness_confirmed` 仍是产品默认。开启 profile 不会让任何现有调用方改用它。
- 请求了 `java_durable` 的准入会返回 operation、准入阶段与投递状态。响应丢失时，可以通过原 operation 找回结果，且不会产生重复副作用。

## 非目标

- 新的投递或对账逻辑。profile 只暴露 D7-1 保存、D7-2 对账的内容。
- #14167 的 triage 列出的 10 处内部 `admission_stage` 写入点保持各自的规则。profile 只决定 Turn 输入与取消的准入暴露什么，不决定任何 operation 如何记录其阶段。
- `PublicTurn` / `WebShellTurn` 的 operation 字段。读取 Turn 时要逐行关联 operation，所以这些字段保持 `planned`。
- 改名 `harness_confirmed`。固定的参考设计把它写作 `qwen_confirmed`；契约记录了这层对应关系，仍使用仓库内的名字。
- Session 创建。它返回的 `WebShellAdmission` 从不包含这些字段。

## 决定

### 1. 开关关闭时，相关代码根本不存在

`qwen.managed-agent.java-durable-admission.enabled`（默认 `false`）控制 `JavaDurableAdmissionConfiguration`。这是一个 `@ConditionalOnProperty` 配置，也是唯一创建 `JavaDurableAdmission` 的地方；`JavaDurableAdmission` 本身不是组件。#14029 处理 event transport 时用的也是这个做法。`ManagedAgentService` 通过可选 setter 拿到这个 bean，所以开关关闭就是 null：准入返回原来的响应体，没有 Session 带 `durable_operations`，请求 digest、SQL 与派发都不变。

### 2. 由调用方按命令请求

Turn 输入或取消用请求体字段来请求：公开事件路由用 `admission_profile`，WebShell 的 `turns/submit` 与 `turns/cancel` 用 `admissionProfile`。取值为 `harness_confirmed`（默认值，缺省时也是它）和 `java_durable`。

- **放在请求体，不用 header。** 签名模式下，HMAC 覆盖请求体，但不覆盖新增的 header；而且 WebShell 路由的所有输入都在请求体里。
- **不计入请求 digest。** 自 D7-1 起，每次准入都会保存 operation，profile 只决定响应用哪种视图。重试时可以换视图，仍然会重放；之前记录的 digest 也继续有效。
- **profile 关闭时拒绝。** 没开启 profile 却请求 `java_durable` 时，返回 `400 unsupported_feature`。这个检查是 `submitTurn`/`cancelTurn` 的第一条语句，在任何读、重放和写之前执行。如果悄悄改用 `harness_confirmed` 语义来应答，会误导一个以为 `202` 表示"已保存并负责投递"的调用方。所有在 `1.60.0` 下合法的请求都不受影响，因为四个请求 schema 都拒绝未知字段。

### 3. 响应内容

`CommandAdmission`（`operation_id`、`admission_stage`、`delivery_state`）与 `WebShellAdmission`（`operationId`、`admissionStage`、`deliveryState`）只在请求了 `java_durable` 时返回这三个字段，而且三个总是一起出现。`JavaDurableAdmission.operation` 通过 `AgentStateStore.findOperation` 读取 operation，并把阶段与状态转成小写。

- **新准入：** 响应体在派发器运行之前构造，所以它反映的是准入保存时的 operation。输入显示 `java_durable` 与 `pending`；对仍在运行的 Turn 的取消也一样；对已结束 Turn 的取消在准入事务内就已结算，显示结算后的值。
- **重放：** 相同 key 与 digest 会返回原 `operation_id`（取自回执的 `result_operation_key`）、`replayed: true`，以及 operation 当前的阶段与状态。D7-1 之前记录的 key 没有 operation，保持原来的响应体。
- **响应丢失：** 可以重试同一个 key 拿到 id，也可以凭 id 通过 `GET …/operations/{operationId}` 或 WebShell `operations/query` 读取 operation。

### 4. 能力声明

`SessionCapabilities.durable_operations` 与 `WebShellSessionCapabilities.durableOperations` 只在 profile 开启时出现，并且和其他能力标志一样，随 Session 是否可读而变化。关闭时省略，契约的 `default: false` 把省略解读为关闭。

## 验证

- `JavaDurableAdmissionConfigurationTest`：开关缺省或为 `false` 时，不存在 `JavaDurableAdmission`，也不存在对应的配置 bean；为 `true` 时创建 profile。
- `ManagedAgentApiContractTest.javaDurableAdmissionIsRefusedWhileTheProfileIsOff`（profile 关闭，即默认上下文）：在公开事件路由与两个 WebShell Turn 路由上请求 `java_durable` 都返回 `400 unsupported_feature`，并且没有准入任何 Turn 或 Turn 命令 operation；显式请求 `harness_confirmed` 时返回原来的响应体；能力声明中没有 `durable_operations`。
- `JavaDurableAdmissionContractTest` 在 profile 开启、使用独立数据库的条件下，把整套契约测试再跑一遍。所有默认准入的应答都与 profile 关闭时相同；`bothSurfacesReportTheSameSession` 只多出 `durable_operations` / `durableOperations`。它自己的用例 `javaDurableAdmissionNamesTheOperationItsAdmissionSaved` 验证以下几点：
  - 被挂起的输入返回 `op_…`、`java_durable`、`pending`。
  - 用同一个 key 重试，以 `replayed: true` 返回同一个 operation；不带 profile 重试时返回原来的响应体。
  - 取消返回它自己的 operation。
  - 两个 id 都能通过 operation 查询读出，分别是已完成的 `submit_input` 和 `cancel`。
  - 不带 profile 的普通输入返回原来的响应体。
  - WebShell 返回 camelCase 字段。
- 所有响应体都按契约做了校验。

## 验收（来自 #14167）

- 开关关闭时行为逐字节一致，并且这一点可以从配置类直接看出（决定 1、`JavaDurableAdmissionConfigurationTest`，以及 profile 开启时重跑的整套测试）。
- 开关打开时 `harness_confirmed` 仍为默认（决定 2；开关开启那轮测试中的普通输入）。
- 请求了 `java_durable` 的准入会返回 operation、准入阶段与投递状态，响应丢失时可以通过原 operation 找回（决定 3）。
