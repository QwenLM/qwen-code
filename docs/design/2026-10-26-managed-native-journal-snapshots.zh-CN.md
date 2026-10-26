# 原生 Managed Session journal 快照（PR2）

[English](2026-10-26-managed-native-journal-snapshots.md) | [简体中文](2026-10-26-managed-native-journal-snapshots.zh-CN.md)

## 问题与当前状态

Issue [#13184](https://github.com/QwenLM/qwen-code/issues/13184) 需要先建立原生恢复边界，才能安全删除 journal 或淘汰 authority 状态。Java 公共消息快照不能恢复 Harness。在协议与 HTTP 恢复增量之前，原生 journal 提供 head 与从 revision 0 开始的事务分页；活跃 Session 的 `compacted_through_revision` 仍为零。

Authority 从原生已提交前缀重建命令重放、事件身份、receipt、checkpoint、Action、领域版本、扩展唯一性、Hook once key 与 occurrence，以及 child continuation。Harness checkpoint 和 Java 最新记录投影都不包含全部这些事实。

## 范围与依赖顺序

PR1（activation/inbox 身份查询）与本 PR2 可以独立开发。PR3（Hosted HTTP 恢复）与 PR4（本地租约感知替换）依赖快照契约；PR5 必须等持久身份查询和两条恢复路径验证完成后才启用驻留窗口。这更新了[有界保留设计](2026-10-19-managed-session-bounded-retention.zh-CN.md)中此前建议的串行开发顺序。

PR3 [#15599](https://github.com/QwenLM/qwen-code/pull/15599) 已合入 PR2 分支。[#15569](https://github.com/QwenLM/qwen-code/pull/15569) 将两个增量一起交付到 main。本文描述协议/存储切片，配套的 [HTTP 恢复设计](2026-10-26-managed-http-snapshot-recovery.zh-CN.md)描述生产消费者。合并 PR 的验收要求两个切片均通过。

存储切片提供发布、不可变存储、完整性检查、资源 ownership 与有界分页读取。HTTP 切片让 Core journal 从已发布快照与连续尾部恢复，同时保留仅查询 head 的结果核验，以及没有符合条件且已公布快照时的旧恢复路径。自动发布、原生事务删除、公共事件快照修改、本地 journal 替换和 authority 淘汰继续不在范围内。首个 payload 格式明确命名为 `committed-prefix-v1`：无损重放映像，不声称是紧凑 authority 状态。其大小和重放工作量仍与历史成正比。未来紧凑格式必须明确保留每个 authority 索引和历史查询契约，不能重新解释本版本。

## 协议

所有新路由都是 internal、Session 作用域，要求与原生 journal 读取相同的 tenant/Workspace 凭据及活跃 writer grant：

| 方法 | `/internal/managed-session-store/v1/sessions/{sessionId}` 下的后缀 | 行为                                                      |
| ---- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| POST | `/journal-snapshots:publish`                                       | 从准确的已提交 head 发布具名快照。                        |
| GET  | `/journal-snapshots/{snapshotId}`                                  | 读取不可变 descriptor。                                   |
| GET  | `/journal-snapshots/{snapshotId}/pages`                            | 在响应字节预算内，从排他 revision 游标后读取最多 100 页。 |

发布指定 `snapshotId`、`workspaceId`、writer ID/generation、expected journal revision、expected committed sequence 和 expected last commit digest。服务端从权威已提交行生成 payload，调用方不能上传不透明的 authority 状态。有效的当前 writer 用相同 head 元组重试已有 ID 会得到原 descriptor，后续 append 后也一样。另一个 head 复用该 ID 会冲突。旧 generation、过期或 sealed writer 不能发布或读取。

Descriptor 绑定格式、tenant/Workspace/Session、snapshot ID、覆盖的 journal revision、committed sequence、commit digest、activation epoch、最新 checkpoint、storage version、页数、资源数和最后一页 digest。每页包含一个完整 `StoredTransaction`、准确的 record bytes 与 commit marker、原命令/operation/content digest 和 sequence 范围、资源 census，以及前一页 digest。分页从 genesis 开始，构成连续 digest 链。Descriptor 承诺最后一页 digest。消费者接受恢复前必须验证页面 digest 与连续性、最终 digest、原生 record/marker 语义、资源引用及快照到尾部的边界。

该无损表示保留了重建执行恢复状态、命令重放及 authority 索引所需的全部源事实，不承诺提供可以直接安装的 TypeScript 私有对象序列化，也不承诺更小的内存状态。

## 存储与发布

原生 manifest 与页面在 `ma_resource` 中使用独立 kind：`managed-native-journal-snapshot` 和 `managed-native-journal-snapshot-page`，不使用 `ma_snapshot` 或其公共投影字段。新增 `NATIVE_SNAPSHOT` resource owner 固定 manifest、页面和完整的原资源 census。Owner key 从 Session scope 和 snapshot ID 派生，以覆盖位置作为 owner revision。页面资源使用内容派生的 ID，可被多个快照共享。原资源 bytes 保持不可变，沿用已有 inline/publication 校验与读取边界。

初始短事务在查询状态前认证，要求普通准入与 READY 恢复状态，捕获 head 和持久退休读取租约。构建在独立的 READ_COMMITTED 事务中运行，复制不可变前缀时仅持有具名 manifest 行和原生私有页面行。源批次及资源体通过另外的短事务读取，不持续持有 tenant/head 锁，也不更新源资源元数据。初始读取租约只检查、不续期，以其现有 120 秒期限约束一次构建。并发 append 或接管可以继续，并使新的发布在最终 CAS 时失败。

只有最终发布才按现有 placement/publication/root/head 顺序取锁、读取当前锁定的 head，并验证 revision/sequence/digest CAS。原资源 FK pin 在这些 guard 后用一条 SQL 复制，并设置两秒查询超时；若构建期间就取得这些资源锁，会反转普通 writer 的锁顺序。最终插入之后也按新鲜数据库时间复查 writer。任何失败都会一起回滚具名 manifest、页面及 ownership，不留下待收集的 staged build。原资源引用在各页 census 中保留来源 revision。资源缺失、损坏、跨作用域、已收集或引用不完整都会终止发布。发布不消耗 journal revision 或 sequence，也不推进活跃重放下界。

Manifest claim 复用已有行前验证其 scope、kind、schema、storage 和 state。普通 commit/tool-result/继承扩展发布以及通用资源读取拒绝保留的原生资源 ID 命名空间；原生读取使用专用非锁定路径，避免普通 writer 持有 head 锁等待构建私有 manifest/page 行。事件依赖只枚举 schema 声明的字段，包括 header 可选的 `baseTranscriptProof`；`cancel.requested.target` 等任意 JSON 都是数据。资源图采用迭代遍历，JSON 嵌套上限不会变成历史页数限制。

每页和每次页面响应最多包含 16 MiB 解码后的页面 bytes，每次最多 100 页。Base64 会增加线上传输体积。首版格式仍会复制原生 record 存储；启用自动发布前，元数据 pin 与大历史运行时间还需 CI 及部署资格验证。

初版发布器使用现有 publication 通道，该通道拒绝 private original-CSI mutation。HTTP 消费者不扩大该准入；生产 CSI 恢复与资格验证仍属于独立验收工作。普通 commit 资源发布不能提交快照专用资源。

首个正式 Managed Agent 版本前，在共享 V1 baseline 原地添加 owner kind，不改变 schema version。开发 catalog 必须重建。Server 与 Broker 使用同一个 baseline 及封闭 owner-kind 契约。

## 读取、失败与退休

Descriptor 与页面读取认证当前 writer，校验 manifest 完整性和 ownership。Descriptor 的 census 数量可以发现 pin 丢失。页面返回数据前校验 bytes、页序号、原生 revision、资源元数据及资源体。缺页不能被当作流结束。未知格式及损坏均停止恢复；调用方不能静默改用另一个 head。

快照 ownership 跨 writer 接管保留，新 writer 获得 grant 后可以读取已有快照。现有带围栏的永久 Session 退休流程会先分批移除原生快照 ownership，再由已有资源收集器清空资源体。活跃 Session 保留与永久退休继续使用独立策略。

## 受影响组件与消费者

存储切片修改 Java Session store API/持久层、resource owner baseline/契约、退休流程与定向测试。合并 PR 还在现有 restore 路由增加选择逻辑，并在 Core HTTP journal adapter 中重建快照。公共 OpenAPI 和 WebShell 类型不变；internal surface registry 新增三个快照路由。

HTTP 快照重建不授权删除 journal。未来删除任何 journal 前，必须迁移或验证所有剩余原历史路径：`WakeRecoveryStore`、取消证据、生命周期清理、命令/model/history 读取、工具详情/结果、publication 准入/证明、child relay、original-CSI 准入/资格验证、CSI inventory/history/image、CSI snapshot/recovery export、Core HTTP 剩余查询路径和 CLI recovery worker。本地替换还需要 `SessionWriterLease` inode/hash/seal proof 支持。这些剩余读取器继续保留完整原 journal。

## 验证与验收

- 基线：检查全局 `qwen` 能力；CLI 不暴露这些 API 时直接验证 internal store。
- 往返读取 genesis 与多个已提交事务、准确的命令重放元数据、资源引用、append 后旧快照稳定，以及接管后读取。
- 拒绝旧 writer/generation、错误 scope/token、错误 revision/sequence/digest、blocked 或 retired Session、缺失/损坏的事务/页面/资源，以及 ID 冲突。
- 在资源与 ownership 插入中注入故障；重开后只能看到原状态或完整快照，不能存在部分 pin。
- 验证页面数量/字节限制、游标连续性、资源闭包及有界永久退休清理。
- 通过 Core HTTP 恢复已发布前缀与较新尾部，保留命令重放并拒绝冲突复用。Exact-head 快照不能读取前缀事务；选中内容损坏时必须失败且不回退，仅查询 head 的结果核验不能执行快照选择。
- 在本模块共享的十分钟本地预算内运行定向 H2、真实 MySQL 8.4、样式、共享 schema 和 API surface 检查。完整 profile 仍是 CI gate；H2 不证明 MySQL 并发或物理进程恢复。

存储验收表示原生协议/存储切片通过所需 gate。合并 #15569 的验收还要求通过 HTTP 恢复设计中的前缀加尾部、旧路径兼容、损坏拒绝与 writer fence 检查。它不关闭 #13184，也不代表本地快照恢复、紧凑 payload、有界 authority 内存或生产 Hosted/CSI 验收完成。这两个切片没有未决的行为选择。

macOS 本地存储证据包括审查前的 H2/MySQL 8.4 增量（24 个定向用例）、API/schema/surface 检查、202 个 CLI parity 用例，以及 build、typecheck、bundle、ESLint 和 Checkstyle。审查随后修正了依赖枚举、锁顺序和保留资源命名空间，并增加回归用例。存储任务共享十分钟验证预算保守地在 574 秒封账，独占 MySQL 已停止；合并增量不重置该预算。独立 PR3 报告记录其较早本地证据与最终真实进程缺口。编译、H2 和样式结果必须对应准确版本的 CI；完整 MySQL/并发/故障 profile、最终集成恢复、大历史行为与平台资格仍是独立 gate。较早的定向通过结果不能证明合并验收完成。
