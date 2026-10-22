# CSI 退役的原 receipt 与 checkpoint 证据

[English](2026-10-02-csi-receipt-checkpoint-evidence.md) | [简体中文](2026-10-02-csi-receipt-checkpoint-evidence.zh-CN.md)

状态：私有只读组件已实现并通过历史基线的本地验证，包括真实 MySQL 接线。[ACK-2 后续设计](2026-10-03-csi-durable-worker-ack.zh-CN.md)现已实现持久 worker ACK；MCP 及聚合物理/云端资格验证仍待完成。这是已通过本地验证的
[原 publication 结算 consumer](2026-10-02-csi-original-publication-settlement.zh-CN.md)
之后的 [K2c](2026-10-01-managed-kubernetes-k2.zh-CN.md) 分片。

## 问题与当前行为

原 REFERENCED publication 证明其 outcome 和 receipt 已提交到原 Session，
但不证明 Harness checkpoint 包含该 receipt。仅提交 receipt 时，Session head
会保留此前的 checkpoint 指针。原 Harness 通常在 receipt 后调用
`resolveAwaitRuntime`，但该 helper 可能返回 null 或此前已结算的 checkpoint；
仅成功返回不能证明新的覆盖关系。

现有 Session authority 重放已提交 journal 字节，并用完整 Harness v1 parser
读取 checkpoint resource。Java 持久层校验 checkpoint resource 的元数据，
不执行该语义解析。复用原生 authority，不新增第二套 checkpoint 格式或 parser。

原 worker ACK 已允许 parent 为 DRAINING，同时要求原 READY Runtime Session、
原 lease 和 publication receipt。Worker 将 acknowledgement 保存在内存中；
本历史组件中的 ACK 路径当时不持久保存确认；ACK-2 后续增量利用可信原 provenance 加入该持久化。Session receipt 不能替代该确认。MCP 的最新
`released` 状态也不能证明严格 drain：兼容路径可能未经正常持久化的 `drained`
转换便到达该状态。

## 范围与交付顺序

首先验证精确的原 receipt 与 checkpoint 的关联。这是组件观测，不是释放判定。
物理 holder、active slot 和 retirement 保持 DRAINING。不修改 producer 准入、
获取新 writer 或 activation、发布替代 checkpoint、启动 worker 或改变公共 CSI
selector。

顺序如下：

1. 复现仅提交 receipt 时覆盖仍旧的窗口，用原生 API 建立正例并从新 authority 重放。
2. 使用既有 Session authority 和 Harness parser 实现最小私有覆盖 consumer，
   然后接入固定的原 SQL 只读快照。
3. 在 RPC 后核实并持久保存精确原 worker ACK 确认，不放宽新工作准入，不将
   Session receipt 复制成 worker 证据。
4. 核实完整的原 MCP configuration、operation 和 release 历史。
5. 将已认证应用证据与原 worker/container 停止及可信 CSI unpublish 证据结合，
   然后设计原子物理释放。

第 3–5 步仍是独立工作。首个 checkpoint 分片不决定新 ACK 字段、迁移或 RPC 契约。

## 证据与身份

后续聚合库存必须枚举全部原候选。本次首个实现只观测明确选择的单个原 publication，
不声称工作区库存完整，也不证明其他工作不存在。

原 CSI journal 和 sealed binding 固定 tenant、workspace、binding/generation、
reservation 和物理 holder。枚举全部原 Runtime Session、execution 和 publication
候选；空 execution 列表不能排除孤立 publication 或 MCP configuration。有界扫描
必须显式报告未完成，不能将截断视为空。

通过原 REFERENCED publication 的 receipt revision 和 sequence，在同一 Session
journal 中定位原事务。匹配 executionCallId、outcome/manifest 引用、outcome 字节
和 receipt 的 `historyRevision`。此处 historyRevision 是事件 sequence，不是 SQL
journal revision。保留完整 committed capture 与 blocked 或 partial outcome 的区别。

重放连续已提交 journal prefix，将其与已保存 head 的 revision、committed sequence
和 commit digest 比较。校验 resource scope、kind、schema、长度、digest 和已提交
引用。原 `checkpoint.committed` 事件必须匹配 activation、checkpoint ID、前驱、
stateRef、coveredSequence 和 boundary。已解析 body 必须匹配同一 Session、
checkpoint 身份和 resume 覆盖。

要求 `receipt.sequence <= checkpoint.coveredSequence`。通过 checkpoint 的 tool
item 或已验证的消费历史，匹配原 execution 和 outcome；runtime invocationBindingId
不是 Java runtimeBindingId。初始组件接受原 activation 的已认证 results_ready
或 turn_settled 状态，或通过 turn_complete boundary 和原子 C+1/C+2 伴随事件
证明的 before_model checkpoint。任意更旧的 before_model 状态不合格。
要求没有相关未解决的 tool、runtime 或 approval 工作。
原生 parser 的 `runnable` 可包含 await_runtime，不能单独作为通过条件。必须
检查最新状态及剩余已提交 prefix，不能挑选较旧的干净 checkpoint。

当前工具状态（before_model 时取紧邻前驱）必须保留原 dispatch 批次的全部
execution，以及该 dispatch 后到最新 covered sequence 之间 journal 中的每个
tool.intent。消费结果或 turn completion 不能隐藏没有对应工具状态的新 intent。

Turn completion 的既有原子事务使用 coveredSequence=C、C+1 处的 turn.settled，
以及 C+2 处的 checkpoint.committed。不能错误要求该 checkpoint 覆盖这些同事务
伴随事件；它必须覆盖此前原 receipt，并满足既有 finished-turn 约束。

## 读取边界与失败行为

复用固定 journal/resource 读取接口和既有 authority 的 open/replay 路径。
Inventory reader 不得调用会获取 writer 的 open，也不得 append、publish、seal、
abort 或标记 recovery。不能调用会更新 last_verified_at 或隔离对象的正常 resource
校验，再将其称为只读检查。

SQL connection 必须提供真正的只读一致快照。在语义重放前，在该快照内校验
descriptor、完整 journal prefix、resource 元数据和原 CSI pins。数据库锁不能
跨对象 I/O 或 worker RPC。首个支持的 inline profile 必须显式拒绝不支持的对象
表示；缺失 resource 不能变成空状态。

缺失或过旧 checkpoint、null resolution、未完成 batch、activation 替换、opaque
或损坏 resource、缺失 revision、未认证 compaction 和不完整枚举，均返回显式
未解决结果。本组件不能报告 DRAINED、可释放或持久聚合成功。后续会变更数据的
确认阶段必须在 RPC/I/O 后重取原 parent 到 publication 的锁序，复查全部原 pins。

## 验证与验收

固定私有 SQL exporter 用自己的 MySQL 只读 repeatable-read 一致快照 connection
读取单个原 publication，拒绝外围事务，校验原 sealed CSI 身份与 execution，
导出原 Session head、transaction descriptor、REFERENCED inline 字节及其真实
resource-reference revisions。不导出凭据。不支持非 InnoDB 表、对象资源、缺失
记录或超出固定界限时，显式未解决；不调用加锁检查或会写入的资源校验方法。
私有 JSON reader 拒绝将 CSI 整数 pin 的小数 token 截断，并以精确十进制比较
原 terminal/result 数值。

TypeScript 快照 adapter 复用既有 HTTP journal descriptor validator 和原生 scan，
包括 checkpoint 与 extension resource 的依赖闭包。全部读取 handle 拒绝变更。
语义 consumer 重放新 authority，核对精确原 receipt 与完整 outcome/manifest，
再核对最新 checkpoint 身份、原 dispatch、工具映射及未覆盖后缀。before_model
要求紧邻前驱保留原已结算且 consumed 的 tool checkpoint，并核实真实原子
turn-complete 伴随事件；仅原生 turn-complete 而未消费时仍未解决。

首个固定界限为 4096 个 transaction/resource/resource-reference row、32 MiB 已解码快照字节及 48 MiB
JSON 输入。超限不能产生部分成功。私有 CLI 读取该导出文件，返回 matched/unresolved
观测，不连接数据库或推进 Harness。复制的 JSON 文件只是所捕获数据库状态的观测，
不能作为当前释放凭据。

生产变更涉及 Session HTTP store 的只读 adapter、新原 receipt checkpoint consumer、
私有 CLI 检查入口、Java CSI snapshot store，以及既有 JDBC binding mapper
的同 connection 读取方法。测试与源码在各自 package 中同址存放。

记录全局 CLI baseline。全局 CLI 未暴露该边界时，使用自有私有原生 API fixture。
通过生产 API 生成 journal 和 checkpoint 状态，不用 SQL 或 `covered=true` 标志
伪造覆盖。验证仅提交 receipt 后的旧 checkpoint、正常原 results_ready 覆盖、
turn-complete C/C+1/C+2 语义，以及新 authority 重放。

负例覆盖错误原 receipt/outcome/activation、null resolution、未完成 tool batch、
缺失或 opaque state、字节变化、缺失 revision，以及截断或不支持的快照。观察
零 writer 获取，以及零 inventory 写入、provider 调用或 worker 调用。清理自有
资源，baseline/post 证据固定源码和运行时版本。

实现验收要求聚焦测试、build/typecheck/bundle、两轮干净自审和限定范围审查。
仅原生内存/文件 baseline 不能认证 SQL 快照、持久 worker ACK、MCP、物理释放
或新的 ACK 云端执行。

## 已记录基线

2026-10-02，全局 CLI 返回 0.24.6。独立 fixture 通过既有 tsx runtime 调用
当前 TypeScript 生产 API。完整原 capture 提交了 sequence 为 5 的 receipt，
而最新 ckpt-4 仍只覆盖 3，其 tool 仍为 in_progress。原 Harness resolver
随后提交 results_ready 的 ckpt-6，覆盖 5，匹配精确原 outcome 和 invocation。
新原生 authority 重放核实两个快照及原 receipt。

在 results_ready 后，对原 execution 和不存在的 execution 执行 resolution，
均返回 null，且不改变 journal。不存在的 execution 没有 receipt 或 tool item，
null 不能证明其覆盖。这不意味着已观察到有效原 await_runtime resolver 在
覆盖前返回 null。原 receipt 的重试也不追加记录。

四个只读新 authority 没有获取 writer，也没有调用写方法。十三个源码/probe
指纹不变，fixture 临时根目录已删除。Fixture 使用惰性 capture 字节及合成进程
元数据，没有运行 Shell、provider、worker、数据库或云端进程。它没有核实 SQL
快照、Hosted publication 准入、turn-complete 和更广负例矩阵、持久 ACK、MCP
或物理释放；该基线没有认证这些能力。

2026-10-03，实现后的组件通过 36 项聚焦 TypeScript 测试、50 项聚焦 Java 映射
测试，以及 build/typecheck/bundle、ESLint 和 Java Checkstyle。独立原生检查
通过 42 个场景；编译后的私有 CLI 用独立子进程通过同样 42 个场景（7 matched、
35 unresolved）。这是两条执行路径，不是 84 个不同场景。真实原生 API 回归
复现了后续未表示的 tool intent 被消费或 turn completion 隐藏；新增 journal
到工具状态检查拒绝了实际观察到的三个窗口。

独立自有 MySQL 8.4.11 链路通过 20 组，使用 JDK 21.0.12.1、Jackson 2.21.4
以及 UTC JVM/driver/session。实际原生 Session/Java publication API 提交原
schemaVersion 1 admission profile 和 sequence 5、SQL revision 6 的 receipt。
Fixture 提供惰性 producer 字节及受控 outcome/history 输入，没有运行 Hosted
应用、模型或物理工具。真正只读 RR 快照在另一连接提交原 checkpoint 时保持
完整 receipt-only 导出，下一快照匹配 results_ready。具备权限的 locking-read
正向对照成功后，同 query 在 READ ONLY 事务中被 MySQL 1792/25006 拒绝。
三个原 JSON 身份小数 pin 在修复私有 parser 前复现截断，最终完整链路复跑
全部拒绝。观察未改变全部 16 张跟踪表和 object 字节；自有进程、端口和临时
目录已回收，870 个输入与 121 个依赖保持不变。

报告保存在 `.qwen/e2e-tests/`：native/CLI post 报告及 2026-10-03 独立 SQL
报告。较早 39 场景/16 组运行和失败复现保留为历史证据。本次只认证固定 inline
profile 下显式选择的一条原 publication。Workspace 全量库存、持久 ACK、严格
MCP 历史、可信 stop/unpublish、物理 holder 释放、新云端执行，以及 CST JVM/
UTC driver 组合仍未认证。
