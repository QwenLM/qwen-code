# 从原生 journal 快照恢复 Managed HTTP 会话（PR3）

[English](2026-10-26-managed-http-snapshot-recovery.md) | [简体中文](2026-10-26-managed-http-snapshot-recovery.zh-CN.md)

## 问题与基线

本次是 [#13184](https://github.com/QwenLM/qwen-code/issues/13184) 的 HTTP 恢复切片，消费 [PR2 原生快照契约](2026-10-26-managed-native-journal-snapshots.zh-CN.md)。在只有 PR2 的基线中，具名 `committed-prefix-v1` 快照已经可用，但 HTTP 恢复仍从 revision zero 读取全部事务，生产路径没有快照选择器。仅增加没有生产者的客户端选项不能接通恢复。

HTTP 切片按 PR2 [#15569](https://github.com/QwenLM/qwen-code/pull/15569) 的契约开发，初始版本为 `c144d2fa65ff1f31e616fd73d205eabdff7dbf18`。PR3 [#15599](https://github.com/QwenLM/qwen-code/pull/15599) 现已合入该分支，#15569 将协议/存储与 HTTP 恢复两个切片一起交付到 main。本文保留 HTTP 切片设计；合并验收要求最终接受的集成版本通过两份设计的 gate。本次传输无损前缀，不是紧凑 authority 状态；快照体积、重放成本和驻留历史仍与历史量成正比。

## 范围与决策

当 Core journal 恢复请求 `includeNativeSnapshot=true` 时，在现有 internal、Session 作用域的 `GET /restore` 路由选择已发布快照。响应保留原有展开的 restore 字段，并增加可选 `nativeSnapshot` descriptor。仅查询 head 的消费者（包括 append 结果核验与最终 writer 探测）不带该参数，不查询快照。不增加路由、boot 选项、schema 或自动发布器。旧客户端保留原响应，新客户端在没有公布 descriptor 时沿用事务路径。选中的快照损坏时拒绝恢复，不改选其他快照或静默重放另一份历史。

保持 `ManagedSessionStore.restore` 与 `RestoreHead` 模型不变，仅 HTTP controller 包装响应。Java 历史读取器、original-CSI 内联 receipt-checkpoint 格式、append 结果核验和生命周期/恢复消费者继续使用现有权威路径。不启用 journal 删除、重放下界推进、本地替换、内存淘汰或独立权威的终态归档。

## 服务端选择与权威

选择前使用既有 tenant/Workspace/Session writer 认证。读取冻结 restore head，再选择覆盖 revision 不超过它的一条已提交原生 manifest owner。查询准确的 Session scope、`NATIVE_SNAPSHOT` ownership 与 manifest kind，按覆盖位置降序、resource 身份确定性排序。未 pin 的构建中 claim 不能成为候选。

复用 PR2 具名 descriptor/resource 校验，要求选中 root 和 owner 覆盖位置匹配返回 manifest，再核验 writer generation。冻结 head 可以落后于并发追加后的当前 head，但不能回退或跨 generation。不可恢复 head 保持现有响应，不选择快照。选中 root 损坏是错误，不是缓存未命中。客户端下载页面期间不持有 head 锁。

验证候选后，如果 ID 恰好为 `.` 或 `..`，或者包含 `/` 或 `\`，则不公布该 descriptor：现有具名 HTTP 路由无法寻址这些原本允许发布的名字。该响应继续通过 journal 恢复，不继续寻找另一候选。Unicode 与编码后的分号名字仍可选。这项资格判断发生在 descriptor 公布前；损坏仍会先在验证阶段报错，客户端选中已公布 descriptor 后绝不回退。

响应仍为 internal、Session 作用域；现有 controller 认证、tenant header、writer token 与 Workspace 检查保持权威。Snapshot/page ownership 由 PR2 继续固定；恢复不增加 resource owner，也不执行发布。

## HTTP 客户端恢复

1. 获取现有 writer，冻结并验证 restore head。
2. 存在 `nativeSnapshot` 时，要求准确作用域、受支持格式/payload/storage version、正数且有界的覆盖位置、page count 与有效 resource 元数据。
3. 使用当前 writer 读取具名页面，验证 kind/schema/大小/SHA-256、连续 revision/cursor、前页 digest 链、末尾 digest 与页数。Descriptor 提供 manifest 对象和引用，没有原始 manifest 字节；不能对该对象执行 `JSON.stringify` 后校验摘要，凭空建立跨语言 JSON 规范化契约。
4. 复用现有 record/metadata 校验解析每个事务；检查 genesis、sequence、前一 commit digest、activation 与 checkpoint 连续性。验证 resource census 身份、元数据、去重计数、直接依赖及声明的嵌套依赖，通过既有校验路径读取原资源。原生 manifest/page 引用不走普通资源路由。
5. 要求重建前缀的位置匹配 manifest，再仅从覆盖 revision 之后读到冻结 head。不能通过实时页面间接采纳更新的 head。
6. 使用原 scanner 校验完整 journal 与准确冻结 head，再返回给 `LocalManagedSessionAuthority`。`maxBytes` 投影不能绕过完整快照校验。采纳结果前再次检查 writer fence。

没有快照时沿用全量 journal 路径。一旦选择快照，页面/资源缺失或损坏、未知格式、断链和过期 writer 都应停止恢复。失败不能重跑工具、创建替代操作或修改 journal。Pending append 结果核验保留准确的单事务直接探测，不改用快照重放。

## 组件与兼容性

| 组件                              | 改动                                                      |
| --------------------------------- | --------------------------------------------------------- |
| 原生快照 repository               | 相对冻结 head 选择符合条件的已提交 descriptor。           |
| Internal Session-store controller | 展开现有 head，并在 descriptor 为 null 时省略它。         |
| Core HTTP store                   | 复用 authority journal 语义校验并重建快照前缀和实时尾部。 |
| 定向 Java/Core 测试               | 选择、JSON 兼容、损坏、资源闭包、接管和幂等恢复。         |

普通 Hosted attachment 与 private CSI 初始化已经创建同一 Core HTTP store，因此不增加其他地方没有设置的选项。PR2 发布边界继续拒绝 private original-CSI mutation，PR3 不扩大该准入。独立的 `qwen-csi-receipt-checkpoint-snapshot/1` 只读检查器保持离线且不修改。

## 验证与验收

- 先尝试全局安装的 CLI；没有公开命令控制原生快照发布或选择，再使用直接协议/适配器验证。
- 证明旧快照加较新尾部恢复出的 command、outcome、event、checkpoint 和 resource 与完整 journal 重放一致；旧 operation 重试保留原 transaction 与 sequence 范围，沿用当前 committed 高水位语义，冲突继续拒绝。
- 证明 exact-head 快照不读取前缀 `/transactions`；没有快照时保留旧路径。
- 拒绝错误作用域/格式/覆盖位置、page digest/链/cursor 损坏、census 资源缺失或冲突、过期 generation 和损坏的选中 manifest；同时覆盖 `maxBytes` 有界读取。
- 覆盖最新可用快照、确定性平局、未 pin claim、冻结上界、旧 writer 拒绝及原 JSON 形状不变。在模块共享十分钟本地验证预算内运行定向真实 MySQL 选择/HTTP 检查，保留完整 CI gate，记录不能执行的真实路径。
- 运行受影响 Core/CLI 消费者测试、全仓 build/typecheck/bundle、Java 编译/样式和定向测试、双语/引用检查、两轮干净自审与独立审查。分别报告本地通过、HTTP 测试替身证据和真实 MySQL/进程证据。

HTTP 验收目标是无损快照恢复路径。合并 #15569 还须通过原生协议/存储设计中的发布、ownership、fence 与退休 gate。定向本地或 fast-CI 通过不能替代所需完整 profile 和最终集成版本成功的真实进程恢复检查。验收不代表紧凑快照、服务内存有界、物理崩溃耐久、Java 历史读取器迁移或生产 Hosted/CSI 恢复完成。

## 风险与后续

恢复会验证额外快照元数据与原资源依赖，因此可能拒绝此前未发现的不一致。完整前缀仍消耗与历史成正比的 CPU 和内存。选择增加 ownership-index 查询；本次没有自动发布器扩大快照数量。继续拒绝不支持的 schema/storage 组合。

PR4 增加感知租约的本地恢复。后续紧凑状态格式与持久历史完整性边界必须先于 authority 内存窗口。删除任何活跃 journal 前缀前必须迁移全部旧历史消费者。#13184 保持开放。

## 开放问题

无损消费者切片没有待定项。紧凑状态表示、发布调度与保留策略仍是独立设计。
