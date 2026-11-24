# Managed Agent JSON 值强类型化

[English](2026-11-24-managed-agent-typed-json-values.md) | [简体中文](2026-11-24-managed-agent-typed-json-values.zh-CN.md)

状态：本地已实现；CI 验收待完成

调研基线：`e6e2857b65`

## 问题与现状

Managed Agent 生产源码中有 1,448 行匹配 `Map<String, Object>`。这些 Map 承担着
不同职责：封闭协议文档、加密数据库 JSON、异构执行结果、开放用户 JSON 和通用
JDBC 行。全部替换会破坏必要的动态边界，并制造大量全可空 DTO。

以下四个封闭结构已有稳定字段和可枚举消费方，适合现在引入具名 Java 值：

1. `SessionModelConfig` 已校验封闭模型配置，但内部仍用 Map 保存并通过字符串读字段。
2. Runtime 对账在传输协议投影后接收封闭的 `state` 加可选动态 `result` 文档。
3. `ManagedContextProtocol` 构造并校验封闭的 Boot 和 Ready 文档，但 Java 消费方
   继续以无类型 Map 传递。
4. AgentDefinition 编译已校验执行字段，却丢弃其中大部分，导致后续 policy 和
   Harness 消费方重复解析 pinned JSON。

目标是提高可读性并获得编译期字段检查，不是改变产品行为或在全仓消灭 Map。

## 目标与范围边界

本次将：

- 为上述四个结构引入具名值；
- 保持动态载荷的动态表示，不编造通用 result 或 extension schema；
- 保持 HTTP JSON、加密数据库明文、规范化摘要、Runtime 错误映射和
  Java/TypeScript 协议行为；
- 迁移仓内所有受 Java 签名变化影响的调用方，包括两个 archived CSI 源码调用点。

本次不会：

- 转换开放 metadata、工具 input/result、事件 data、递归用户 JSON 或通用 JDBC row；
- 修改 TypeScript 实现、OpenAPI、共享 JSON Schema、fixtures、SQL、事务边界或
  存储 schema 版本；
- 引入 Jackson default typing、fastjson2 AutoType、反射选择类名或由输入驱动的
  多态反序列化；
- 为没有仓内消费方的兼容重载保留重复 API；
- 顺带对齐 Java/TypeScript 对 developer `managedExtensions.cgroupRoot` 的既有
  差异；这是独立的行为决策。

## 设计

### 1. Session 模型配置

`SessionModelConfig` 继续作为公开的校验领域类。长期保存的状态由 Map 改为私有
`Value` 和 `Generation` record。record 仅包含已准入字段：

- value：`protocol`、`model`、`baseUrl`、`apiKey` 和可选 `generation`；
- generation：`temperature`、`topP`、`topK`、`maxTokens`、`presencePenalty`、
  `frequencyPenalty` 和 `seed`。

解析继续使用显式 `JsonNode` 校验。未知字段、null、URI 规则、文本限制、采样范围
和数值归一化保持当前顺序。整数采样字段仍为 `Integer`，其余采样字段仍为
`Double`。装箱的 generation 分量表示字段缺省；所有分量为 null 的非空
`Generation` 表示显式空对象。

`wireValue()` 成为唯一序列化投影。它重建现有 snake_case Map，省略缺省值，保留
空 generation 对象，并返回不可修改的外层和嵌套 Map。`baseUrl()` 改读强类型值。
`digest()` 和字节数限制继续作用于这个完全相同的 wire 投影，不直接作用于
Jackson 默认 record 序列化。现有脱敏 `toString()` 保持权威。

Controller、Session 创建命令、加密持久化、SDK、CLI 和 WebShell 消费方均保持
现有契约。

### 2. Runtime 执行状态

在 `contracts` 新增小型不可变值 `RuntimeExecutionStatus`，包含：

- 五值 state 枚举，沿用 wire 名称 `prepared`、`executing`、`cancel_requested`、
  `settled` 和 `unknown`；
- 可空的动态 `Map<String, Object>` result，仅 `settled` 持有。

单个显式 Map 转换入口校验封闭键集、状态名和 `result` 存在性规则，拒绝
present-null 和非 object result，并通过 `BrokerValues` 获取递归不可变 JSON
快照。该值不提前校验工具专属的终态 `executionStatus`；这一领域检查继续由
`ToolExecutionRecord` 在后续执行。

`RuntimeExecutionReconciler.absorbRuntimeStatus` 消费强类型值。原始 Map 继续留在
`RuntimeTransport`、HTTP v2/v3/v4 投影、取消、后台轮询、测量补全和 Workspace
转发边界。三条对账输入——durable publication evidence、durable v3 快捷路径和
实时 transport lookup——共用同一转换，并保持现有
`runtime_execution_status_invalid` 映射及 takeover 降级。

`RuntimeBrokerSupport.projectV3Status` 继续刻意容忍并丢弃非 settled 的标量或
null `result`。更严格的 canonical 状态校验不得提前到该投影之前。公共 HTTP、
cooldown、取消和 transport 签名均不变。

### 3. Managed Context Boot 与 Ready

`ManagedContextProtocol` 增加嵌套 `Boot` 和 `Ready` record。

`Boot` 保存 13 个可变核心字段，包括 `long epoch`、字符串
`workspaceGeneration` 和可选动态 `managedExtensions`。固定的 `type=boot`、
`version=2` 和 `managedContext=managed-context/1` 仅由 `toWire()` 补入。
`Boot.toString()` 对 token 脱敏。`toWire()` 重建现有封闭 Map，并在 JSON、摘要和
外层 envelope 边界强制使用；record 本身绝不直接序列化。

`boot(...)` 返回 `Boot`。`parseBoot(Map<String, Object>)` 先取得不可变 JSON
快照，再应用现有校验，防止调用方后续修改使已准入值失效。现有 Map 版
`validateBoot` 保留给对抗 fixtures 和原始协议消费方。

`ready(...)` 接收强类型 Boot，返回包含三个匹配身份字段、epoch 和已校验 loopback
URI 的强类型 Ready。Java 只校验 Worker 生成的 Ready，因此不增加没有消费方的
wire 序列化器。External publication 字段继续位于该封闭核心类型之外。

`attestationRequest` 和 `attestationResponse` 保留 Map 签名及现有删键/加键算法。
`parse`、`verify`、`installation`、`receipt`、legacy v1/v2 路径、External storage
envelope 和所有 TypeScript 代码均不变。Java 活跃调用方和两个 archived CSI
envelope 构造点在仍需要 Map 的位置显式增加 `toWire()`。

### 4. AgentDefinition 执行字段

`AgentDefinitionCompiler.Compiled` 现在暴露 `modelId`、`instructions`、生效的
`approvalMode` 和 `toolProfile`、规范化后的 `skills`、`mcpServers`、
`hookCatalog` 以及 `hookCatalogPresent`。Admission 保持现有 model、
instructions、policy、tools、extension 和 environment 校验顺序。开放
`metadata` 刻意不进入该值，也不能影响执行。

`fromPinnedContent` 投影已 pin 的 Session，不重新应用当前部署的 model 或工具
allowlist。审批模式和工具 profile 取自 Session，保留 Hook 字段缺省与
present-null 的区别，并复用现有规范化扩展值，不再增加一层叶子 Map 到 record
的转换。创建和存储 JSON 保持前向兼容；本次不是封闭请求 DTO 改造。

`AgentSessionPolicies` 直接消费编译后的 skills、MCP 和 Hook 存在性，不再重复解析
定义。`QwenHostedHarnessConnector` 每次 create/load 只投影一次 pinned content，
并在 definition、MCP 和 Hook 构造间共享。Create 仍发布 model、instructions 和
skills，load 仍只发送 definition identity 及既有 MCP/Hook 值。资源计费和其它
非执行消费方仍使用完整原始内容。

## 兼容性与安全不变量

| 范围        | 必须保持的不变量                                                    |
| ----------- | ------------------------------------------------------------------- |
| JSON 名称   | 现有 snake_case/camelCase wire 名称和固定协议标记不变。             |
| 缺省与 null | 可选字段缺省仍缺省；显式空对象仍为空；原被拒绝的 null 仍拒绝。      |
| 数字        | 现有整数、浮点、safe-integer 和归一化行为不变。                     |
| 摘要        | 模型配置和 External 身份哈希继续消费与之前相同的规范化 Map 内容。   |
| 集合        | 强类型值不能通过保留的源 Map 或嵌套 List 被修改。                   |
| 错误        | Runtime 对账与取消保留各自状态码和失败时点。                        |
| 秘密        | 模型 API key 和 Boot token 不出现在值对象的 `toString()` 中。       |
| 反序列化    | 只使用显式目标类型和手工校验器，不引入 AutoType 或 default typing。 |
| 线上兼容    | Java record 只是实现细节，不构成新 wire schema 或多态 envelope。    |

## 影响文件

生产改动限定为：

- `contracts`：`SessionModelConfig`、新增 `RuntimeExecutionStatus`、
  `ManagedContextProtocol` 和 `AgentDefinitionCompiler`；
- `runtime-broker`：`RuntimeExecutionReconciler`、`RuntimeBrokerService` 中的
  durable 快捷路径，以及 `RuntimeBrokerSupport` 的共享状态名校验；
- `runtime-http`、`runtime-local`、`runtime-ssh`、`runtime-external` 和
  `persistence`：Managed Context 调用方迁移，以及 `AgentSessionPolicies` 的
  编译定义消费；
- `adapters`：`QwenHostedHarnessConnector` 共享编译定义消费；
- `sdk-java/managed-kubernetes-archive`：两处 Boot `toWire()` 机械调用点更新，
  不恢复或重设计归档。

测试继续放在 `verification`；未修改的 TypeScript conformance 测试作为消费方
证据运行。尽量扩展现有测试类，只为新 Runtime 状态和既有覆盖不足的 Boot/Ready
行为增加聚焦值测试。

## 验证计划

### Session 配置

- 在修改实现前固定历史 wire JSON 和 digest 向量。
- 覆盖 generation 缺省、显式空对象、非法 null、未知字段、数字词法归一化、
  Map 不可变和脱敏。
- 验证加密保存/读取、继承、私有 HTTP 读取和响应字段名不变。

### Runtime 状态

- 覆盖五个状态、非法键集、result 缺省/present-null、动态嵌套 JSON、防御性
  复制和非法 JSON 值。
- 保留对账、takeover、durable v3、非法 lookup、取消、轮询、测量和 cooldown
  回归。
- 增加直接 v3 投影用例，证明当前对非 settled 标量/null 的丢弃行为未被移动或收紧。

### Managed Context

- 运行全部共享 Boot/Ready fixture，并以 JSON 树比较强类型往返结果。
- 覆盖两种 managed extension profile、不可变快照、token 脱敏、attestation
  派生、epoch 边界和现有 developer cgroupRoot 行为。
- 运行受影响的 HTTP、Local、SSH、External ownership、extension、恢复和容量测试，
  以及未修改的 TypeScript Worker/conformance 测试。
- archived CSI 验证单独报告，因为普通 Maven reactor 不构建它。

### AgentDefinition

- 断言全部编译字段、规范化扩展值、空集合，以及 Hook 缺省与 present-null 的
  存在性区别。
- 证明 pinned 投影不重新应用当前 allowlist，且 metadata 仍不影响执行。
- 在同一 create+load 场景核对一致的 model、instructionsRef、skillsRef、MCP、
  Hook 和 load-only identity，并验证每次操作只读取一次 pinned content。
- 运行 admission、approval-change、资源计费和 Hosted definition 消费方回归。

## 验收标准

1. 四个封闭结构在领域消费方暴露具名字段；动态 result 和 extension 载荷仍显式保留。
2. 不需要修改 wire JSON、OpenAPI、TypeScript、SQL 或存储格式。
3. 历史模型配置 JSON 和 digest 仍可按原样解密、解析和比较。
4. Runtime 对账保持错误码、UNKNOWN/takeover 行为和动态 result 内容。
5. Managed Context fixtures、身份哈希、扩展变体和 Java 活跃调用方保持现有行为。
6. 聚焦 Java 测试和两套 Checkstyle execution 在模块共享十分钟本地预算内通过；
   未运行的证据明确记为待验证，不暗示已经通过。CI 保留完整 Java、Hosted、故障、
   MySQL 及其他必需 profile。
7. 完整 diff 按仓库要求完成自审和代码评审；修正后重新运行受影响的检查。

## 实现证据与剩余验收

四个切片均已通过显式 wire 投影实现。历史模型 JSON 和 digest 断言先于生产改动在
旧实现上通过。两轮开放式自审和当前会话内的完整 diff 评审均未发现剩余正确性问题。

| 证据                | 观测结果                                                                                                                                                        | 限制                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Java 基线           | 236/236 通过；新增模型 golden 随后在旧实现上通过 13/13。                                                                                                        | 基线证据不能替代改后测试。                                    |
| 改后聚焦 Java       | 249/249 通过，所有生产源码及 702 个 verification 测试源码均完成编译。                                                                                           | 这是聚焦套件，不是完整 Maven verify。                         |
| External 跨语言路径 | 真实 Worker boot contract 通过 2/2；External ownership 通过 13/13。                                                                                             | Local、SSH 和完整 Hosted/fault profile 未在 Java 预算内运行。 |
| AgentDefinition     | 编译器/Connector/admission/approval 核心测试通过 331/331；另有 58 个消费方测试通过；SDK 通过 4/4，TS 消费方通过 3/3。create+load 恰好读取 pinned content 两次。 | 完整 Hosted 和 MySQL profile 仍待验收。                       |
| Checkstyle          | 每个生产模块及 verification 的两套 execution 均报告 0 violation。                                                                                               | 聚焦执行，不是完整 Maven verify。                             |
| TypeScript 消费方   | 同一组 4 文件在改前/改后均通过 1,673/1,673；仓库 build 和 typecheck 通过。                                                                                      | 未修改 TypeScript 源码。                                      |
| 评审                | `git diff --check` 通过；两轮自审和当前会话内评审未发现 bug。                                                                                                   | 环境没有可用的外部 bugbot 子代理。                            |

较早的架构运行报告了 `AgentSessionPolicies` 和 `AgentTurnExecution` 的基线违规。
AgentDefinition 切片删除重复解析后，`AgentSessionPolicies` 已降回 ceiling 内；
最近一次运行仍报告未修改的 `AgentTurnExecution` 为 798>797 行。该剩余基线失败
没有通过筛选隐藏，也不计为通过。完整 Java/H2、SpotBugs、MySQL、Hosted、fault
和 archived CSI 验收仍待完成；不暗示任何 CI 或归档结果已经通过。

## 待决问题

本次范围没有待决问题。仓外 Java 源码兼容不是保留 typed/untyped 双套 API 的理由；
外部集成继续使用不变的 wire 协议。
