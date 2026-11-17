# Managed Tool v4 执行方测量

[English](2026-11-07-managed-execution-diagnostics.md) | [简体中文](2026-11-07-managed-execution-diagnostics.zh-CN.md)

## 状态与基线

作者已选择以 #16499 为基线收敛 PR #16498，本设计据此缩小范围。前置仍为 #16475，初始整合基线是 `d886d0640a623928cea4507a413a1f1899bb1e8a`。实现状态与最终 CI 验收分别记录。

基线负责调用身份、activity evidence v1、SQL 增量投影、授权 activity 查询、统计面板及子代理调用树。本增量扩展这些路径，不恢复此前的 `execution_diagnostics` domain、第二套 collector、`/stats.execution` 或另一张关系图。

## 剩余行为

普通 Hosted Runtime 可以报告实际执行耗时及原生文件变更测量。Runtime 关闭及重放后，现有 activity 视图仍需保留这些信息。文件系统操作已成功时，后续格式化、输出限制或交付失败不能抹去成功证据。

| 测量     | 含义                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| 执行耗时 | 执行方用单调时钟围绕实际调用测得的非负整数，不包含审批、排队和结果发布。           |
| 模型行数 | 原内容与模型提议之间的增删行。                                                     |
| 实际行数 | 原内容与最终应用内容之间的增删行。                                                 |
| 文件范围 | 仅成功的原生 `read_file`、`write_file`、`edit`，不推断 Shell 或 MCP 内部文件行为。 |

行数按操作累计，包括重复编辑；不表示 Git diff，undo 不扣减此前工作。明确的零、无变化、未测量及证据缺失保持可区分。后台 Shell/Monitor 只测量启动调用。执行耗时不冒充完整调用响应延迟，也不将不同进程的时间戳相减。

Harness 比较已持久化的模型请求与 dispatch 输入，记录有界的提议来源（`original / modified / unknown`）。Hook 或审批修改了输入，或无法证明原始输入时，模型行数不作为确定的测量样本公开。实际应用行数与执行耗时仍可用。诊断证据不复制原始内容。

## Runtime 协议

Tool v2/v3 保持闭合且不变。Tool v4 在 `/internal/managed-runtime/v4/` 下提供 `execute`、`status`、`cancel`、`acknowledge`。请求选择底层执行协议 2 或 3；响应封装原结果、`managed-tool-measurements/1` 及完整结果与测量包的规范化摘要。

测量包只包含可空执行耗时、物理执行结果及可空原生文件测量。文件测量包括 operation/status 和可空模型/实际增删行，不携带路径、文件内容、patch 或 Skill 正文。解析保持闭合，整数有界，引用包限制为 4 KiB。

新的经过 attestation 的普通 Workspace capability 显式声明 v4。既有 ordinary、extension、resident 和 CSI digest 保持原义。dispatch 前确定协议；丢失 v4 响应后查询同一 execution 的状态，不降级为 v2 重新执行。

Worker 在 settled 前一起冻结结果和测量。Broker 校验规范化摘要，使用现有结果/version CAS 持久化完整结果后再 ACK。v3 publication 先于测量 settled 时，仍按原 execution 和结果核对归并。ACK 携带原冻结摘要；v3 capture、manifest、publication receipt 及回收规则保持不变。

## 现有 activity 投影路径

```mermaid
flowchart LR
  W[执行方结果与测量] --> B[Broker 持久结果]
  B --> H[Hosted 完成 writer]
  H --> J[tool.measured 来源事件]
  J --> P[现有 ActivityProjection]
  P --> Q[现有授权 activity 查询]
  Q --> U[现有 activity 视图]
```

专用 `tool.measured` 来源事件引用原 `toolOutcomeRef` 和不可变 `managed-tool-measurements` 资源。资源将测量包与冻结结果摘要绑定到 execution call 和已有 invocation 身份。这是现有 ActivityProjection 的来源证据，不是另一个 collector 或投影 domain。

部分 v3 receipt 在 Worker 发布期间提交，早于 v4 结果冻结。事后增加字段会改变其不可变身份和闭合发布契约。独立事件保留 v2/v3 结果及全部原 receipt 字节，在模型结果交付或 ACK 前提交，也覆盖交付受阻的情况。它不授权 dispatch、不创建 invocation、不使 Context 失效，也不推动执行完成。v2 的 results-ready checkpoint 仍与 receipt 区分。

Harness 冻结测量包字节和 command 身份；恢复时先检查已提交证据。精确重放不改变总数，证据冲突则拒绝。事件与现有 activity 更新共享 journal 原子事务和 writer/activation fence。reducer 校验 kind、version、digest、字节上限、outcome 来源和已有 execution-to-invocation 关联；文件测量必须匹配实际解析的原生工具。不增加数据库表或公开写入入口，也不为改善诊断重新执行工具。

大型 publication outcome 可以只有已验证的对象存储引用，没有内联字节。reducer 不在 journal 事务持锁期间下载对象。无法内联读取的 receipt 保留已知执行与交付观察，增加 `receipt_outcome_not_inline` 覆盖缺口，并在现有私有 execution link 中绑定完整 outcome 引用。后续测量必须匹配同一 execution 已提交 receipt 的完整引用，包括 resource ID、kind、version、length 和 digest；只有 digest 相同不足以证明绑定。内联及分块 outcome 保留既有正文和调用身份校验。journal receipt 引用保留重放与快照所需的原资源闭包。

writer 准入重建缺失投影时，复用 journal 提交使用的同一 Session 范围已验证资源解析器，包含无法内联读取的 publication 元数据。保留 publication 归属、隔离和完整性校验，不下载对象，也不放宽通用内联 record reader。

测量事件提交后，取消或交付恢复可以产生不同的对话结果。相同冻结测量的重放保留原事件及 outcome 引用。即使取消改变对话返回，已证明完成的 Shell 或原生文件副作用仍保留成功执行证据。

聚合加入现有工具/文件总览和三种文件操作分组。按工具分桶保持基线的有界表示，执行方测量仍可在分页调用详情中读取。这样保留累计测量总数，同时避免给每个保留桶扩充测量负载。

仅在存在测量证据时惰性增加测量字段。未测量的内联 activity-v1 和 CSI `/3` 记录保留此前投影字节；无法内联读取的 publication receipt 只增加上述私有绑定及明确覆盖缺口。activity 响应不公开内部引用和摘要，新增公开字段只包含有界测量、来源 sequence 和十进制字符串聚合计数。

## 覆盖与展示

现有工具/文件概要及调用详情展示执行耗时、有效样本数和模型/实际增删行。平均值以测量样本数为分母，不使用全部请求数。旧记录缺少测量字段表示未记录；测量只覆盖部分 activity 时显示部分覆盖，不支持的 profile 不产生值为零的样本。

测量复用 activity 查询的授权、被动读取、分页和 `no-store` 语义。查询不新增 Runtime attach、MCP discovery 或文件系统读取。既有子代理调用树及其授权限制不变。

## 兼容与发布

新的来源事件要求 Session storage floor 5、HTTP reader version 5 和原生 reader capability `managed-session/3`，与数据库 schema 版本区分。升级条件依据已提交的测量事件/reference，包括重放已存储资源，不只检查本次新上传的字节。先部署新 reader，再开启测量 producer；旧 reader 不能接管 floor-5 Session。

兼容 reader 和 Worker 部署后，设置 `QWEN_MANAGED_AGENT_RUNTIME_TOOL_MEASUREMENTS=true`（默认 `false`），为新解析的普通 binding 选择测量 profile。已有 binding 保留 attested capability。测量提交还要求基线 activity evidence 和 storage-version-5 grant，不增加第二个 collector 开关。

CSI `/1`、`/2`、`/3` 分别保留既有 storage 1、3、4 支持。CSI `/3` 的 activity evidence 继续可用，本增量不增加 CSI 执行方测量能力。普通测量 profile 不得放宽 extension/resident/CSI 准入。资源快照、恢复及永久删除沿用现有机制，保留新增引用闭包。

## 实现边界

| 层次              | 增量                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------- |
| Core              | 有界测量契约/fixture，测量事件/引用及引用/version 校验。                              |
| Runtime 与 Broker | attested v4 封装，单调时钟/原生文件测量，冻结结果持久化，status/cancel/ACK 恢复。     |
| Hosted            | 将 Broker 测量接入实时及恢复完成 writer，持久提交后释放临时测量状态。                 |
| Server            | 扩展现有 activity reducer、storage/reader 门禁、快照闭包及既有 activity 响应 schema。 |
| WebShell          | 扩展现有概要/详情和中英文文案，重新生成 API 类型。                                    |

## 验证与验收

TypeScript/Java 共享 fixture 覆盖整数/null/status 校验和包含 UTF-8 的规范化摘要。定向测试覆盖重复请求/结果、v4 status/cancel/ACK、publication 先于测量完成的竞态、文件成功后的输出失败、模型/最终内容不同、无变化文件及旧版本兼容。无法内联读取的 receipt 回归检查保留已知证据、拒绝缺失或不匹配的完整 receipt 引用，并确保重放测量只计一次。测量绑定、重放、贡献替换和快照闭包需要事务测试，包括 Hosted publication 丢失 ACK 的真实进程门禁。

test-engineer 运行相关打包 Worker 路径和浏览器展示检查；内部契约无公开 CLI 命令时采用既有 test-script 回退。展示 fixture 不替代真实 Worker/Broker、MySQL 或恢复验收。根 build/typecheck/bundle、受影响 TypeScript 测试、API/SurfaceRegistry 校验和生成类型检查继续为必需项。

Java 验证继续使用既有十分钟账本，不因本次整合重置。定向检查只消耗剩余预算。完整 Java、MySQL、Hosted/fault、native CSI 和 SpotBugs 门禁交给 CI，未运行的真实路径明确报告。成功标准为：同一次冻结执行只贡献一次，离线 activity 保留已知测量，旧数据/未测量数据仍能清楚区分。
