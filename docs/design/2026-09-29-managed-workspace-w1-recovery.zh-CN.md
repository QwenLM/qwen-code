# Managed Workspace W1：可验证恢复与挂载迁移

[English](2026-09-29-managed-workspace-w1-recovery.md) | [简体中文](2026-09-29-managed-workspace-w1-recovery.zh-CN.md)

状态：W1a 已有实现候选；W1b/W1c 仍为设计提案，Linux 端到端验收待完成。
调研基线：`be1ebc74d7f5b0bdce2b88a6565d4940d5a6b3c0`，2026-09-29。
实现整合基线：`23e0a451e`，2026-09-30；该基线已包含合入的初始 Workspace 文件 Turn 与可审计运维恢复。
属于 [proposal #12380](https://github.com/QwenLM/qwen-code/issues/12380)。
目标契约为 [Workspace v1.12 第 2、3.5、5 节](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-workspace-context.en.md)。

## 1. 建议范围

将 W1 分成三个切片交付。**先做 W1a：对已经绑定 Workspace、Turn 已结算的 Hosted Session，在原位置完成可验证的冷恢复。** W1b 增加有证据的历史回填和外部快照恢复校验，W1c 增加同一存储的受控挂载迁移。这是本文提出的拆分，不是已经认领的路线图任务。

W0 已持久保存 binding，并提供 Runtime 接管与回收。W1 补充的是：文件和私有恢复资源仍属于原 binding 的证据。目录存在、storage holder 已释放或公开 transcript 可读，都不能单独证明恢复成功。

冷打开 Session 不会回滚共享文件。Workspace 是共享的可变存储，按照某个 Session 的旧文件树恢复，可能破坏另一个 Session 后来的工作。灾难恢复必须是 storage 级维护操作，其一致恢复点覆盖所有受影响的 Session。

## 2. 已核实的实现与缺口

下列路径和行号均对应调研基线。实现整合基线已包含初始 Workspace 文件 Turn 与可审计运维恢复。描述更早基线的设计文档不作为当前行为的证据。

| 领域          | 现有行为                                                                                                                                       | W1 缺口                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Binding       | `ManagedAgentStore.java:335,2226` 保存并重建七字段 `ContextBinding`，校验冻结的 config/policy descriptor。V7 要求 binding 全部存在或全部为空。 | 已绑定 Session 不需要猜测身份回填。无绑定 Session 不能安全地继承今天的默认 Workspace。                |
| 授权          | `WorkspaceExecutionStore.java:30` 检查 Session 状态、精确的 Registry generation/storage/state、原创建 actor 的权限和固定 profile。             | 没有独立 trust epoch。W1 应复用实际授权检查，不能增加没有赋值来源的 `trusted` 开关。                  |
| 挂载          | `WorkspaceRuntimeResolver.java:38–81` 解析管理员配置的 tenant/storage root，拒绝别名和重叠，并比较规范路径与 `fileKey`。                       | `fileKey` 只在内存中。重启会建立新基线，当前没有持久挂载连续性回执。                                  |
| 存储所有权    | `WorkspaceExecutionStore.java:92–135,166–228` 按 tenant/storage 串行执行；正常释放或 W0e 停止证据确认后，条件清理精确 holder。                 | 这不是文件清单，也不是跨新旧 placement 的迁移围栏。                                                   |
| Runtime 身份  | `RuntimeScope.java:66–71`、`JdbcRepositorySupport.java:32–50` 和 `LocalRuntimeStore.java:365–379` 的身份或哈希包含物理 cwd。                   | root 迁移必须建立新 placement；原地修改旧 Runtime 行会使其证据失效。                                  |
| Hosted 冷加载 | `hosted-harness-session.ts:302–305,353–356` 把 Harness cwd 写进 `managed-root`；存在未结算输入或恢复 bundle 非 OK 时拒绝加载。                 | Harness cwd 不是远程 Workspace 身份。执行中的 Turn 续跑仍属于 Stage G。                               |
| 文件历史      | `hosted-workspace-tool-turn.ts:67,78` 明确不提供 undo 备份，worker 也关闭文件 checkpoint。其他 Managed 路径能够记录 `file_history`。           | `file_history` 记录只是元数据，不包含全部备份字节；备份可能在 Workspace 外的 Session 文件历史目录中。 |
| 公开路径      | main 仍对 Workspace 执行设门禁；[G0 #12955](https://github.com/QwenLM/qwen-code/pull/12955) 尚未合并，且仅开放初始文件工具 Turn。              | 可以先开发 W1 内部能力；公开恢复与后续 Turn 验收需要另行接通产品路由。                                |

上述 Java 路径位于 `packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/` 或 `packages/sdk-java/runtime-broker/src/main/java/com/alibaba/qwen/code/runtimebroker/`。TypeScript Hosted 路径位于 `packages/cli/src/serve/`。

已合入的 [W0e 恢复设计](2026-09-27-managed-workspace-recovery.zh-CN.md)、[受信任重启切片](2026-09-28-local-reboot-recovery.zh-CN.md)和 [G2 接管扫描](managed-runtime-takeover-scan.zh-CN.md)继续定义各自范围。它们的物理停止与原执行结果证据不能证明文件内容完整。

## 3. 边界与不变量

- 保留 `tenantId`、`workspaceId`、`workspaceGeneration`、`workspaceStorageId`、`cwdRelative`、`contextConfigRef` 和 `contextRevision`。W1 不切换 Session cwd、不改选 Workspace、不替换存储。逻辑变更需要另行准入、W2 或新建 Session。
- 保留原 command、input、execution 身份、结果回执、日志字节和模型实际消费的消息。挂载迁移和回填都不改写已提交内容，也不重放工具副作用。
- 区分三件事：原执行结果、旧写入者不能再回来的证据、存储及资源可用的证据。三者互不推导。`ABANDONED` 仍表示结果未知，不是成功结果或自动解锁。
- W1a 面向受信任的单主机 Linux local-process 部署的进程重启，以及已保存的 `hosted-workspace-files/1` 或 `hosted-workspace-shell/1` profile。整机重启后只有登记身份仍匹配才允许恢复，不承诺可跨重启的通用身份。任意配置快照、Legacy 导入、跨主机接管、Kubernetes、同 UID 恶意写入者、磁盘/虚拟机回滚、在线迁移均不在其验收范围。
- 新执行需要当前授权。获授权的历史/导出，以及基于保存身份的清理，不要求挂载正常。撤权必须阻断新工作，同时允许可信清理继续。
- 公开 Items/Snapshots 不能重建私有 Session authority。O2 的结果字节也不是 Workspace 文件系统备份。

## 4. 交付切片

| 切片                    | 交付内容                                                                                       | 依赖与退出条件                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **W1a：原位置恢复**     | 持久本地存储登记、运行时准入检查、clean-load 校验和运维诊断；显式纳管现有已绑定部署。          | 基于 W0e/G2。证明同 root 恢复，以及跨进程重启后拒绝替换过的 root。公开恢复在产品路由存在前继续受门禁限制。不依赖 O2 或本地 M2/M5/M6。       |
| **W1b：回填与快照校验** | 从 authority 记录有界重建恢复元数据，版本化恢复 manifest，以及外部 snapshot/restore 回执校验。 | 依赖 W1a、可信快照来源及私有资源闭包。仅当所选 profile 的已接纳结果使用 O2 时依赖它。不构建通用备份引擎。                                   |
| **W1c：可验证迁移**     | 同一逻辑存储在同主机上的离线迁移、持久迁移回执与新 Runtime 安装。                              | 依赖 W1a/W1b、全部旧写入者已停止的证据，以及所有受影响 Session/profile 都支持迁移的清单。首版仅支持使用相对路径的 Hosted 文件工具 Session。 |

W1b/W1c 不代表 G1/G3 完成。调研时仍 open 的[运维恢复 #12977](https://github.com/QwenLM/qwen-code/pull/12977)在证明后释放旧 holder，但保留失败 Turn 的阻塞状态。W1 应复用该边界，不另造强制解锁路径。

## 5. W1a：持久存储登记

### 5.1 最小存储改动

扩展按 tenant/storage 定位的 `managed_workspace_execution_lease` 行，不增加另一套锁服务。新增用于核对哈希的精确 tenant/storage 标识、单调递增的 `mountRevision`、`mountState`（`unverified`、`ready`、`fenced`），可空的 `maintenanceOperationId`，以及版本化挂载身份和登记回执。已有 holder 字段及其所有权语义保持不变。大 manifest 不放在这行中。

没有登记意味着 `unverified`，不能自动登记启动时碰巧找到的目录。启用 W1 的执行路径必须拒绝它。现有部署只能在维护期间登记：运维人员检查原存储、停止准入并核对全部旧写入者后，显式纳管。这建立了有记录的 W1 起点，不反向证明全部历史字节都曾被捕获。

首版 Linux 身份格式保存持久 host 身份、规范 root、明确的数值 device/inode，以及随机分配的 storage registration ID。登记 ID 同时写在 root 下由管理员创建的版本化标记 `.qwen-managed-storage.json` 中；SQL 与标记必须一致。登记只校验已存在的 root，绝不创建替代项目目录。标记使用排他/no-follow 创建和持久发布；登记中断后保持 unverified，按原回执恢复。已有冲突标记时拒绝，不能覆盖。

标记是 host/文件系统身份的补充，不是授权凭证或文件完整性证据。复制标记不能授权另一个 root。登记完成后标记丢失会阻断恢复；W1a 不提供修复或重新纳管命令，也不自动重建。这是可信负载下的连续性检查，不防御同 UID 恶意进程、文件系统回滚或管理员有意复制身份。device 身份变化、不支持的身份提供方式或重启后的比较不明确时，保持阻塞，等待维护校验。不能把 `fileKey.toString()` 持久化后当成可移植身份格式。

只有完整且有效的登记才能将 `unverified` 改为 `ready`。`fenced` 关闭准入，直至同一维护操作完成，或明确恢复仍已验证的原映射。进入 `fenced` 时比较 `ready` 状态与预期 revision，并保存 operation ID。续办、切换映射和解围都同时比较该 operation ID 与 revision；第二个操作不能仅凭 revision 相同就接管。解围递增 revision 并保留已完成操作回执，以便丢失 ACK 后重试，且旧 fence 不能重新开启维护。不存在超时自动解锁。`mountRevision` 为已验证物理 placement 及维护转换的证据编号，不替代 Workspace generation、context revision 或 Runtime generation。

### 5.2 检查位置

在 Hosted attachment 和缓存复用时、冷恢复 Session 发起新模型工作之前，以及为新工作解析/provision/acquire Runtime 之前，检查保存的 binding、当前权限和已登记挂载。在 claim 事务内和新的 execute 前再次验证 storage guard。Broker 配置若指向不同 root，必须因与持久身份不符而关闭准入；revision 是维护 CAS 凭据，不是新的 Runtime 协议字段。

最后一次准入检查必须在取得 storage 行锁后读取当前 guard 状态并核对原 root 身份。只在等待前检查一次并不够。正常 release 与 W0e 清理只能清除自己的精确 holder 字段，不能删除登记或撤销迁移围栏。即使新执行被拒绝，原执行的 status/cancel/recovery 仍通过保存的原 generation 处理。

W1a 不改 `managed-context/1`。其七字段逻辑 digest 本来就不含 mount root，现有 attestation/installation 回执绑定物理 Runtime。Java 的 guard 检查补充这些回执。如果要求 Worker 独立校验新增存储证明，必须协商协议新版本，不能向封闭的 v1 envelope 直接加字段。

### 5.3 锁顺序与部署

当前 claim 的锁顺序为 Runtime binding → Runtime Session → storage lease；失联 holder 清理为 binding → storage lease。保留此顺序，绝不能持有 storage 行锁再扫描并锁定 Runtime bindings。

W1a 维护先关闭新工作入口，结算或取消原执行，证明全部写入者停止，再按现有所有权协议释放精确 holder。停止相关服务和外部写入进程并禁止重启后，才在预期 `mountRevision` 上提交 storage fence 短事务。Fence 要求全部 holder 字段已清空，不提供在线排空能力。已经通过 guard 检查的请求仍可能派发，因此 storage fence 本身不证明已经静默。在 worker 侧准入封闭、所有相关执行域都具备合格停止证据之前，不能把文件树当成稳定快照，也不能修改映射。

旧二进制不会读取新增 guard 字段。W1 变更启用前，所有能够控制该 storage 的进程都必须停止/排空并统一升级。维护证据还必须覆盖普通工具和其他能够写入目录的外部服务；升级 Java 并不能隔离它们。首版使用离线部署，避免再建在线版本协调系统。完成 schema migration 不等于完成安全升级。回滚至旧二进制时，服务和入口必须保持停止，直到显式对账完成。持久 fence 或关闭新开关无法约束不读取新增列的旧二进制。

实现使用默认关闭的 Broker 属性 `verified-workspace-recovery-enabled`。私有入口 `WorkspaceStorageRegistrationMain` 支持 `register`、`inspect`、`fence` 和 `restore-original`；修改操作必须显式声明离线维护，并使用精确的 operation ID。[服务端 README](../../packages/sdk-java/managed-agent-server/README.md)给出了调用方式和升级顺序。该声明本身不能停止外部写入者。登记和执行需要受信任的 Linux 身份提供者；本地 H2 测试使用合成提供者，不能代替 Linux 验收。

### 5.4 已确认的 W1a 恢复契约（2026-09-30）

Owner 已选择内部 Java → Hosted → Runtime 恢复、进程重启，以及严格的历史完整性。公开恢复和后续 Turn 准入作为独立接线。Passive Hosted attachment 保留 Session、Registry、grants 和 profile 授权，只跳过物理 mount 校验；原执行清理继续通过保存的 Broker 身份处理。仅接纳已经绑定、Turn 已结算的 Session；W0e/G2 继续负责精确原执行的对账。打开 Session 不清除物理 holder。

取得独占 writer 并安装 activation 后，捕获 `S = restoreBundle.throughSequence`。未结算输入、全部保留的事件/资源根和消息投影统一限定在 S。为现有 record sink/projection 增加实际使用的可选 `throughSequence` 参数；不传参的调用保留原行为。校验期间 activation 续租可推进传输 cursor，因此不要求原始日志尾部完全不变。发布 attachment 前重新验证 writer 所有权。失败加载可能追加租约管理记录，但不能接纳业务输入或运行模型/工具副作用；只关闭本次取得的租约。

验证 header 引用、事件 schema 声明的引用、checkpoint typed refs 和实际消息投影。继续支持内建 session-metadata 标题记录及其 previous-record 引用，扩展 domain 仍拒绝。所有承诺完整的 Shell manifest、page、segment、seal、长度及完整流摘要都必须有效；空流也需要 seal。按资源 ID 去重，同时拒绝引用元数据冲突。输出分块读取，不降级为仅检查最新 checkpoint。旧已结算 Turn 的资源缺失同样拒绝冷加载。不支持的扩展 domain、Legacy file-history 备份和外部附件形态直接拒绝，不能将顶层读取冒充闭包验证。W1a 不构建通用 JSON 引用遍历或快照引擎。

登记先持久化准备好的身份，再持久发布 marker，最后提交 READY。同一操作的并发重试必须收敛，包括最终提交成功但 ACK 丢失。已完成的登记/restore 重试重新验证当前身份和 marker，不再次推进 revision。Inspect 即使在 FENCED 状态也报告状态、revision、操作回执、holder 存在性和物理校验。根 marker 证明连续身份，不证明文件内容完整。

## 6. 冷恢复流程

1. 读取保存的 Session 和原创建回执，重新检查当前访问权、精确的 Registry generation/storage、固定 config/policy 引用及启用的 profile。不能用当前默认值填补缺失字段。
2. 校验已登记存储身份与原相对 cwd。目录缺失、别名、符号链接替换、身份变化或 fenced storage 都保持执行关闭。不能 `mkdir`、clone 或回退到 `.`。
3. 获取现有私有 Session writer lease，恢复权威日志和所需资源闭包，核对原 definition，复用读取器严格的损坏拒绝行为。基线中的 load 检查 definition/checkpoint，但消息投影是惰性的，直到后续输入接纳后才读取。W1a 在报告 load 成功或接纳下一输入前，在同一 committed cut 校验受支持 profile 的 typed message/checkpoint/result 闭包，并拒绝不支持的 domain；后续惰性读取失败不能算恢复成功。未结算输入继续返回 `hosted_turn_recovery_required`，不能作为新工作重放。拒绝时只释放本次新获取的 writer lease，不释放物理 holder。
4. 在考虑新 generation 前，先对账原 Runtime binding。G2 可以恢复有确定证据的原结果，W0e 可以证明丢失和物理释放。未知或 abandoned 结果不能让中断的 Hosted Turn 变得可续跑。
5. 对后续已准入的工具 Turn，解析同一 storage/cwd，获取精确 storage holder，安装原逻辑 context 和支持的冻结 profile。按当前 Runtime 校验 attestation、context 与 activation 回执；旧 incarnation 的回执不能激活新的 Runtime。
6. 准入副作用之前再次检查物理 guard 和当前权限。只报告已证明的事实：私有历史已打开、存储已校验，以及独立的 Runtime 已激活。逻辑 binding ready 与物理 ready 继续区分。

第 2、3 步增加恢复检查，不要求每次模型请求前都预热 worker。冷恢复检查成功后保留 model-first 行为：provisioning 可并行，只有工具等待 activation。仅查询历史不经过上述执行流程，沿用现有访问控制。

W1a 对外沿用 `workspace_unavailable` 和 `hosted_turn_recovery_required`。私有 inspect 区分登记状态、revision、操作回执、holder 存在性及独立 root/marker 检查。cwd 缺失、过期映射、未决执行、私有资源缺失和不支持的 profile 继续保持拒绝，不新增详细公开诊断接口。不新增公开 restore 或任意路径登记接口。

## 7. W1b：可信回填与一致恢复清单

### 7.1 能够回填的内容

对已绑定 Session，只能从原创建回执、精确 binding、权威日志、不可变引用资源及保留的文件历史字节重建派生恢复元数据。记录来源 digest 与固定 committed sequence，按稳定身份分页、保存处理进度，并在提交每条派生记录前复查来源版本。重试同一操作不能增加新的 authority 事件或重复资源引用。

不能从本地路径哈希、`ChatRecord.cwd`、Harness 的 `managed-root`、当前 Registry 默认值或公开 transcript 推断 binding。无绑定旧 Session 保持原行为；只有存在权威导入证据时，才另行设计显式迁移。

文件历史元数据必须与备份字节一起校验。记录中的“文件原本不存在”与“备份丢失”不同，绝不能用当前文件代替丢失的旧版本。现有 Hosted 文件 profile 应明确记录过去未提供 undo 捕获，不补造 snapshot，也不声称能够撤销。新的 storage snapshot 可以保护未来恢复点，但不能创造此前的文件版本。

### 7.2 最小 manifest

使用带 digest 的版本化不可变恢复 manifest，由持久维护回执引用。它描述一个恢复点，而不是持续变化的当前文件树。

| 部分             | 所需证据                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份             | Tenant/storage、原登记与 mount revision、Workspace generations、snapshot provider ID 及不可变 snapshot 身份。                                                             |
| 一致切面         | 维护操作与 fence；完整分页的受影响 Session 集合、精确 bindings、authority committed sequences 与 definition/resource roots；确认不存在已接纳而未结算的工作。              |
| 文件             | Provider 提供的规范 storage 相对路径、条目类型、长度/digest、必要 mode/symlink 元数据；清单 digest 和恢复字节校验。拒绝不支持的特殊文件、越界链接、歧义名称和不完整清单。 |
| 私有恢复闭包     | Journal 回执及全部必要的 checkpoint/message/domain 资源，包括 Workspace root 之外的资源。核对已有 digest，仅有对象名称列表不够。                                          |
| 历史与结果       | Profile 支持时的 file-history 备份闭包；已接纳结果引用及其字节归属的存储；明确的 unavailable/not-captured 状态。                                                          |
| Placement 与完成 | 原映射、目标身份、验证结果，以及绑定操作和预期 mount revision 的完成回执。                                                                                                |

Java 请求路径不递归复制存储，SQL 元数据/SSE 不携带文件字节。首个集成消费可信的外部不可变快照，并以有界内存流式校验。W1b 实现前必须选择并写明首个具体 snapshot provider；这个契约不表示已有对应 adapter。

### 7.3 恢复点规则

捕获切面前，对整个 tenant/storage 域设置围栏，包括共享它的所有 Workspace 和 Session。先关闭该 storage 的 Session 创建、prompt/无工具输入准入以及后台派发。全部已接纳输入及其 tool/history/result 提交都必须完成或取消并结算，仅标记为 blocked 不满足此门禁。可以保留含 blocked 工作的诊断快照，但它不是可激活的恢复点。

首版离线实现停止相关 Harness 和 Session Store writer 进程，释放或等待 writer lease 失效，并禁止续租/重启，然后才能枚举最终 Session 集合及固定 journal 水位。现有工具 claim/execute guard 不能冻结这两者；当前 Session Store writer acquisition 不读取 storage guard。快照捕获或迁移完成之前保持产品入口和 writer 停止，由私有维护进程完成操作。同时核对 Broker 之外的写入者。provider 即使提供原子文件系统快照，也不能单独证明 SQL/journal 一致性。

原存储仍在时，冷打开读取当前文件，不应用该 manifest。灾难恢复先在活动目标之外暂存并验证选定快照，恢复/验证其私有资源闭包，再与当前 authority 比较水位。只要任一受影响 Session 的更晚已接纳状态或缺失闭包与恢复点不兼容，就拒绝整个共享 storage 的切换与解围，而不是只拒绝该 Session。可保留暂存快照供检查，但不能覆盖活动文件树。W1 不重放 Shell 来追平文件、不回滚 authority、不抹掉较新工作。显式分叉的恢复需要单独的运维/产品决策，不能当成普通 resume。

不能把旧 snapshot 的内容 digest 当成后来已合法变化的 Workspace 的预期 digest。SQL 备份回滚、虚拟机回滚或登记 authority 本身丢失，需要独立灾备/fencing 契约；本切片不会自动接纳。

## 8. W1c：同存储的受控迁移

### 8.1 首版支持场景

在维护期间，把已验证的存储树迁移到同一可信主机上的另一个 root。保留逻辑 storage 和全部七字段 Session binding。私有 Session Store key 保持不变，它不能与产品 Workspace ID 相互替换。目标只能来自获授权的部署数据，不能是浏览器调用者传入的路径。

先支持已结算、使用相对路径的 Hosted 文件工具 Session。其新文件调用本来就要求相对保存的 cwd，所以不需要重写已提交消息。清点共享 storage 的所有 Session 和资源，包括已归档的 Session。只要存在不支持安全迁移的 profile 或保留资产，就保持旧挂载或拒绝迁移，不能因为当前选中的 Session 可以迁移就破坏其他旧 Session。

首版迁移能力不支持 Shell 命令、MCP/Hook 配置、Workspace 外的文件历史引用、Memory root 及其他不透明绝对路径依赖；这些需要 profile 专属支持。W1c 不能通过升级现有 Session 的不可变 definition 来绕过检查。

### 8.2 持久操作

1. 检查原 storage 登记、全部引用 Session 和全部旧 placement，记录 operation ID、预期 mount revision 和 request digest。同 ID 改载荷必须冲突。
2. 提交 storage fence，并完成第 7.3 节的完整离线准入/journal 静默，再排空并证明全部旧写入者不能恢复。复用正常/W0e/运维证据。holder 为空、租约过期、公开 Turn 已完成或 root PID 已退出，都不足以证明任意 Shell 后代已停止。
3. 捕获/验证一致 manifest，通过可信存储流程恢复或迁移文件，再验证目标身份和完整内容。此时不启动新 Runtime。
4. 验证全部路径敏感消费者。未来支持的历史 adapter 只能按已验证的源 root 归属和目标 containment 映射类型化路径，保留 backup ID 和字节。不能做字符串前缀替换（`/old/a` 不等于 `/old/ab`），不能改写原始 Shell 字符串，也不能修改已提交消息、资源、哈希和执行引用。派生映射写成不可变旁路记录，不修改原证据。
5. 确认旧 placement 已退役，并经精确 owner 协议释放原 holder。在 storage 仍 fenced 时，按预期 revision CAS 切换至新的登记映射并持久化完成证据。旧 Broker 继续因映射不符而失败。
6. 目标和全部必要证据提交后，才开放新准入。后续获授权的工具 Turn 获取新的 Runtime placement 及新的 attestation/context/activation 回执。binding digest 不变不表示可以复用旧物理回执。

每个持久边界都能使用同一 operation 和证据重启续办。失败时保留 fence 和原记录。映射切换后，回滚也是 mount revision 更大的新验证转换，不能递减版本或直接恢复旧 SQL 行。原 status/cancel 和清理继续指向保存的旧执行，不指向新 root。

不能修改旧 Runtime 记录中的 `canonical_cwd`、request keys、持久 handle 或 attestation，它们是不可变证据。新旧 placement 记录同时保留，只有经验证的登记决定新工作可以在哪里执行。

## 9. 组件、所有权与兼容性

| 组件 / 消费者                                                                  | 所需变更或保留边界                                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `ManagedWorkspaceRegistry`、`ManagedAgentStore`                                | 复用原 binding 与当前授权；有界回填不能修改旧创建回执。                                           |
| `WorkspaceExecutionStore`                                                      | 增加 storage 登记/guard，在 claim/assertion 路径检查，精确 holder 释放时保留它。                  |
| `WorkspaceRuntimeResolver`、`WorkspaceRuntimeTransport`                        | 比较配置与持久映射、root 身份；guard revision 仅用于维护 CAS。保留 cwd 检查和回执校验。           |
| `EmbeddedRuntimeBroker`、`WorkspaceRuntimeProvisioner`、`RuntimeBrokerService` | 对新工作施加门禁，保留原身份观测/清理，维护时枚举所有相关已保存 placement；复用 W0e/G2。          |
| `QwenHostedHarnessConnector`、`HarnessCoordinator`                             | 在 attachment 和缓存复用时校验；接通 clean-load，不意外扩大 G0 公开 Turn 范围。                   |
| `hosted-harness-session.ts`、Managed authority/resource readers                | 保留严格私有恢复及未结算输入拒绝；若需要新增明确的 binding/profile 证据，通过版本化契约交付。     |
| Worker context/activation                                                      | 在新 Runtime 重新安装和验证原逻辑 context；W1a 不静默增加 boot-envelope 字段。                    |
| File-history readers / snapshot adapter                                        | W1b 校验元数据和字节；W1c 只支持逐项审计过的类型化路径映射。                                      |
| 公开 API / WebShell                                                            | 保留读权限与现有失败语义；不开放 cwd 变更、storage 路径、强制恢复或提前宣告 `workspace_context`。 |

W1a 首版实现包含一个增量 migration、登记/guard 及其调用者、小型私有维护入口、定向测试和本设计。后续 PR 不应将 W1b snapshot adapter 或 W1c 迁移状态机并入其中。整合基线已包含 #12977；保留其可审计原 owner 清理，并将 storage 登记与部分 Shell 恢复分开。

V21 在整合基线之上增量添加；#12894 独立开发期间，后续 rebase 继续核对 migration 编号。保留现有封闭 ContextBinding 和 worker 协议，整个部署升级并完成登记前不启用 W1。普通本地 Managed 引擎仍按独立排期延期。

## 10. 验证与验收

详细工作计划位于 `.qwen/e2e-tests/managed-workspace-w1-recovery.md`（被忽略的开发产物）。随本设计提交的验收要求如下：

| 门禁               | 必须观察到的结果                                                                                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1：干净重启       | 保存一个已绑定、Turn 已完成的 Session；重启 Java/Harness，只删除其可丢弃 home。同一 storage/cwd/config 和私有模型历史能够恢复，没有重复物理副作用。                                                                                                 |
| A2：持久身份       | 服务停止时替换原路径上的 root。重启后 W1 拒绝它；未变化的已登记 root 成功。标记缺失/冲突和不支持的身份也应拒绝。                                                                                                                                    |
| A3：权限           | 默认值改变不会重新绑定。Registry generation/storage 不符、移除、撤权、cwd 缺失或配置不符时阻断新工作，同时保留相应授权的历史访问和基于原 owner 的清理。                                                                                             |
| A4：并发           | 两个 Broker 进程的 claim/execute 与 storage fence 竞争，包含已经通过早期检查的请求。Claim 先成功则 fence 拒绝；fence 先成功则 claim 拒绝，包括已通过早期检查的请求。过期 release/cleanup 不能清除较新的 holder 或 guard。Fence 本身不证明在线静默。 |
| A5：中断 Turn      | 物理 storage 可复用之后，unsettled/unknown/abandoned 执行仍保持阻塞。只查询原 ID；拒绝冷加载时断言模型调用和替代执行均为零。                                                                                                                        |
| B1：回填           | 在每批处理边界崩溃重试，派生数据保持相同身份/digest、内存有界且无重复引用；无绑定或证据不足的 Session 不升级。                                                                                                                                      |
| B2：快照闭包       | 检出缺失/损坏的备份、checkpoint、message/result 对象、变化文件、越界链接及来源水位不符。任何不兼容 Session 都阻止整个 storage 激活；晚到的 Session 创建和无工具 journal 提交不能越过维护边界。不能报告完整恢复，也不能覆盖活动共享文件树。          |
| C1：迁移           | 两个 Workspace/子目录以及共享 storage 的多个 Session 保留逻辑 binding。新副作用只写入验证后的目标路径，旧回调仍绑定旧 placement。                                                                                                                   |
| C2：迁移中断       | 在 fence 后、字节校验后、映射 CAS 后和最终 ACK 前杀掉维护进程。同一 operation 重试；旧请求不能解开或切换更高 revision。                                                                                                                             |
| C3：不支持的消费者 | 存在不可映射绝对路径资产的 Session/profile 时，拒绝整个 storage 迁移。成功的受支持迁移也保持历史消息和结果字节完全不变。                                                                                                                            |

使用真实打包的 Harness/worker、生产 Broker/SQL 接线和确定性本地模型。H2 用于定向契约；双进程竞争和持久化门禁还必须在 MySQL 8 上运行。Linux 进程重启是必需验收，合成身份检查不能替代它。整机重启验收不属于 W1a，不重启共享工作站。公开 G0/后续 Turn E2E 在路由落地前继续是独立门禁。

## 11. 替代方案与各切片前的决策

- **重启后重新读取部署 root 即可：** 不采用。这会重建当前的内存基线，可能接纳替换后的存储。
- **只增加 root 标记或文件树哈希：** 不作为唯一权威。标记必须匹配持久登记和物理身份；snapshot digest 只证明一个内容版本，不证明身份连续性或写入者已隔离。
- **换 Session/默认目录来恢复：** 不采用。会丢失 binding，并可能重复副作用。
- **把备份、迁移和 G1 一起实现：** 不采用。会混淆文件恢复、进程清理和逻辑 Turn 续跑。
- **替换全部旧绝对路径：** 不采用。路径也存在于任意模型内容、Shell 和配置中，改写会破坏不可变证据。

W1a 的可信 Linux/原位置、仅内部、进程重启、离线登记和严格历史范围已确认；W1b 前选择具体不可变快照 provider；迁移开发前接受 W1c 对相对路径文件 profile 的限制。如需更广的平台、profile 或在线迁移，应先修订对应切片和故障门禁，不能把未回答的部署选择处理为宽松回退。

## 12. 实现证据

已检查 Java 持久化/租约/placement 和 TypeScript 恢复/context/file history，并对两侧分别进行了独立代码探索。通过 `gh` 重新核对了 #12955、#12977、#12894 的 PR 边界；前两项已在实现整合基线中合入。全局 CLI 报告版本 `0.24.6`。

本工作树中已实现 W1a 候选。本地 H2 测试覆盖持久登记、同操作并发登记/fence、真实登记提交后的 ACK 丢失、替换 root 拒绝、已完成 restore 的重新验证及旧 fence 拒绝。29 个定向 Java 测试、29 个 Hosted 测试和 62 个投影/sink 测试已在实现整合基线上通过，全仓 build、typecheck、bundle、ESLint 和 Java Checkstyle 也已通过。Java 测试还覆盖缓存新工作重新授权，以及保留 grants、仅跳过物理 mount 验证的 passive attachment。Hosted 测试验证合法 activation 续租期间固定恢复水位、资源元数据冲突、不支持的 domain、writer 丢失、重命名后文件/Shell Session 的兼容性及新模型工作前拒绝缺失的历史资源。

打包后的 macOS/H2 E2E 也已通过真实 Java SDK 的无 tool-profile 加载。用例篡改实际持久化的空 stderr seal，观察到冷加载拒绝且模型/工具执行不增加；修复 seal 后重启 Harness 进程、取得新 boot ID，再加载原 Session 并执行下一 Turn。验证使用生产 Broker/worker 接线，并覆盖 100 MiB Shell 输出和七个 Shell producer 退出。macOS 上关闭物理 mount 验证，因此这项结果不成立 Linux/MySQL 验收。仅 Linux 运行的 `HostedWorkspaceStorageGuardMySqlIT` 新增独立维护进程的登记/restore 和双客户端维护测试，已由现有 MySQL 8 Hosted CI profile 选中，但未在本机执行。新增的 `HostedWorkspaceConcurrencyIT` 通过生产内嵌 Broker 接线启动两个独立 JVM，分别运行真实 Node worker 并共享 SQL 存储。测试屏障设在早期授权之后和 claim 提交之后，固定两种竞争顺序。派发屏障验证持有者存在时 fence 被拒，再完成实际批准的文件写入。普通 release 和有效的 LOST cleanup 在另一个 Broker 取得已恢复的新 revision 后重试，完整存储行必须保持不变。Linux 使用生产物理身份及精确登记 worker 的停止证明；macOS/H2 使用合成身份且不执行 Linux LOST cleanup 分支。现有 Hosted MySQL 选择器包含这项门禁。进入 Ready 前仍需新 head 的 Linux/MySQL 结果，以及移除锁内 claim 验证后测试失败的反向检查。公开 Workspace 恢复/后续 Turn 准入仍需产品路由接线。全局 CLI 没有 W1 维护入口，不能直接 dry-run；测试计划记录了这一基线及剩余环境门禁。
