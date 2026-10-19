# 原 CSI 的原生退役终止边界

[English](2026-10-07-csi-native-retirement-boundary.md) | [简体中文](2026-10-07-csi-native-retirement-boundary.zh-CN.md)

状态：已在本地实现的 K2-A2 观察组件，2026-10-07。基于
`99596829308df61fe3d64c1bf0bf73e8db1821f3` 和
[K2 完成设计](2026-10-06-kubernetes-k2-retirement-handoff.zh-CN.md)。
本组件不封闭准入、不提交 application cut、不 finalize worker、不建立
`DRAINED`，也不释放存储。

## 问题和当前状态

A1 inventory 观察器验证原文件结果及其已消费的原生 checkpoint。有序退役随后提交
原生 `releaseActivation` 边界。这个事件晚于结果 checkpoint，观察器必须验证其
自身证据，不能声称此前的 checkpoint 覆盖了更晚的事件。校验和正确或 phase 为
released，均不能证明边界对应此前已结算的历史。

完整 A2 准入工作还需要私有 CREATE 持久化的文件 profile、原 request 和首个
activation pin、所有生产 writer 的父级门禁、Harness 的 mutation/renewal barrier、
加锁提交的不可变 cut 及原 worker finalizer。这些需要协调修改，本观察器不提供。
旧 activation 替换、writer 接管和普通 release 保留其现有契约。

## 输入和验证

新增私有观察格式 `qwen-csi-session-retirement-boundary/1`，仅含三个字段：
`format`、`settledInventory` 和 `terminalSnapshot`。前者是完整的 A1
`qwen-csi-retirement-inventory/1`；后者是完整的现有原生
`qwen-csi-session-checkpoint-snapshot/1`。该格式不是新 worker boot、capability
profile，也不是调用者可提交的释放凭证。

比较边界前，先运行原 A1 inventory 观察器并要求没有 blocker。要求恰好一个
`READY` Runtime Session、一个 durable Session snapshot、Session isolation
以及精确的原 Session key。每个允许的 execution 仍通过 A1 文件验证器；独立枚举
的 publication、lifecycle 和 resource 义务继续保留其 blocker。

只读解析并重放两个完整原生 snapshot，不获取 writer。已结算 head 必须为
`ACTIVE`、未 compact、recovery-ready，原 activation 必须 active 且 epoch 为 1。
终止 head 可以是 `ACTIVE` 或 `SEALED`；两者均是观察，均不证明不可变 cut。
保留 storage version、writer generation、activation epoch、checkpoint reference
及 recovery 字段。终止 journal 必须只多一个 revision 和一个 event。此前每个
transaction 的 metadata 和原始字节必须完全相同。

唯一的后缀 transaction 必须为 `releaseActivation`。重放必须产生且仅产生一个
`activation.changed` 事件，phase 为 `released`，ID、epoch、worker 和 subject
均属于原 activation，expiry 不变，install reference 和 lease duration 为 null。
所引用的 `managed-activation-boundary` v1 body 必须恰好包含原 activation
ID/epoch、已结算 committed sequence 和已结算 journal 的最后一个 record UUID。
最后的 UUID 是 commit marker 的 UUID，不是最后一个 event 的 UUID。resource
字节和引用必须有效。所有此前 resource 描述、字节及引用 revision 必须保留；只
允许一个新的 boundary resource，且只被后缀 revision 引用。

组合输入继续遵守既有的 48 MiB JSON、32 MiB decoded-data、每集合 4,096 条
上限，以及严格的原生 resource 检查。超限、不完整历史、替换 activation、额外
后缀工作、不一致 pin 或不支持的形状，均返回明确 unresolved 原因。不允许截断、
按时钟过期推断、替换 writer、RPC 或数据库写入。

## 输出和集成

提供一个由现有私有 checkpoint evidence 入口消费的小型原生观察器。成功返回
`status: observed`、`stage: original_native_boundary`、inventory 和 observation
摘要、精确 Session key、原 activation、boundary reference 及前后 journal pin。
退出码零仅表示输入被解析并符合这些原生条件，不代表完整退役或验收。输出不包含
cut、finalization、`drained` 或 `releasable` 声明。

未来可信协调器从原 authority 派生两个输入，并在提交 cut 前将这些精确 pin 与当前
加锁 authority 比较。本组件不认证所提交 snapshot 的来源，也不资格验证物理证据，
不得单独用于释放授权。现有 live 文件/publication 验证和旧 worker 协议保持完整。

## 影响范围和验证

修改涉及 core 原生观察器、现有私有 CLI evidence 入口、共享 decoded-size 计数
以及原生测试 fixture。测试使用真实 Session、resource、journal、checkpoint 和
activation API。fixture 中的 Broker 结果和文件效果仍为合成数据，不构成 worker
或云上测试。

验证 Read/Write/Edit 结算后追加真实原生释放边界，包括相同重试。拒绝未结算成员、
过早 Runtime Session release、错误 Session/CSI 身份、替换 activation、renewal
或普通工作后缀、被修改的前缀 metadata/字节/resource、额外 resource、错误边界
body/subject，以及损坏或超限输入。加入重新计算内部合法 hash 的语义篡改；仅因
校验和错误而拒绝并不足够。保留 A1/旧契约控制，检查私有入口退出码及不存在释放
授权字段。

本地已通过 67 项 core 针对性测试、320 项私有入口/worker/envelope 测试，以及
build、typecheck、bundle、针对性 lint 和格式检查。独立 test-engineer 对重新
构建的私有入口完成 37 项脚本检查，覆盖真正的空原生 Session、Read/Edit 成功、
Write 错误、相同重试、内部合法的语义篡改及组合 decoded/JSON 上限。超限组合中
的两个子树分别低于对应上限，但完整输入被拒绝。临时原生 fixture 和大型填充输入
已清理。这些结果仅描述观察组件，不证明 MySQL 准入竞态、真实 worker 文件效果
或集群交接。

## 验收和剩余工作

只有中英文设计、针对性测试、build、typecheck、bundle、独立 test-script 验证及
评审均符合观察契约，本组件才算完成。它只提供 A2 的一个原生语义输入。完整 A2、
K2-B 来源资格验证、K2-C 原子释放/复用及 K2-D 公开集成仍是整体 K2 目标的要求。
本变更不执行或授权安装特权 collector。
