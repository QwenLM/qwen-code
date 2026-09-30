# Managed Workspace W1：可验证恢复与挂载迁移

[English](2026-09-29-managed-workspace-w1-recovery.md) | [简体中文](2026-09-29-managed-workspace-w1-recovery.zh-CN.md)

状态：W1a 已有实现候选；W1b/W1c 仍为设计提案。`7c54aa78` 已有 Linux/MySQL 验收证据；birth-time 身份修复及 O2 整合需要重新验证。
调研基线：`be1ebc74d7f5b0bdce2b88a6565d4940d5a6b3c0`，2026-09-29。
实现整合基线：main `78143fe33`，2026-09-30；已包含初始 Workspace 文件 Turn、可审计运维恢复及 O2 远端 Shell 结果持久交付（#12894）、私有 Hosted MCP（#12946）、Runtime JSON 序列化（#13108）及持久权限 Actions（#13101）。
属于 [proposal #12380](https://github.com/QwenLM/qwen-code/issues/12380)。
目标契约为 [Workspace v1.12 第 2、3.5、5 节](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-workspace-context.en.md)。

## 1. 建议范围

将 W1 分成三个切片交付。**先做 W1a：对已经绑定 Workspace 的 Hosted Session，在原位置完成可验证的冷恢复，并保留已有的原回执恢复规则。** W1b 增加有证据的历史回填和外部快照恢复校验，W1c 增加同一存储的受控挂载迁移。这是本文提出的拆分，不是已经认领的路线图任务。

W0 已持久保存 binding，并提供 Runtime 接管与回收。W1 补充的是：文件和私有恢复资源仍属于原 binding 的证据。目录存在、storage holder 已释放或公开 transcript 可读，都不能单独证明恢复成功。

冷打开 Session 不会回滚共享文件。Workspace 是共享的可变存储，按照某个 Session 的旧文件树恢复，可能破坏另一个 Session 后来的工作。灾难恢复必须是 storage 级维护操作，其一致恢复点覆盖所有受影响的 Session。

## 2. 已核实的实现与缺口

下列路径和行号均对应调研基线。实现整合基线已包含初始 Workspace 文件 Turn 与可审计运维恢复。描述更早基线的设计文档不作为当前行为的证据。

| 领域          | 现有行为                                                                                                                                         | W1 缺口                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Binding       | `ManagedAgentStore.java:335,2226` 保存并重建七字段 `ContextBinding`，校验冻结的 config/policy descriptor。V7 要求 binding 全部存在或全部为空。   | 已绑定 Session 不需要猜测身份回填。无绑定 Session 不能安全地继承今天的默认 Workspace。                |
| 授权          | `WorkspaceExecutionStore.java:30` 检查 Session 状态、精确的 Registry generation/storage/state、原创建 actor 的权限和固定 profile。               | 没有独立 trust epoch。W1 应复用实际授权检查，不能增加没有赋值来源的 `trusted` 开关。                  |
| 挂载          | `WorkspaceRuntimeResolver.java:38–81` 解析管理员配置的 tenant/storage root，拒绝别名和重叠，并比较规范路径与 `fileKey`。                         | `fileKey` 只在内存中。重启会建立新基线，当前没有持久挂载连续性回执。                                  |
| 存储所有权    | `WorkspaceExecutionStore.java:92–135,166–228` 按 tenant/storage 串行执行；正常释放或 W0e 停止证据确认后，条件清理精确 holder。                   | 这不是文件清单，也不是跨新旧 placement 的迁移围栏。                                                   |
| Runtime 身份  | `RuntimeScope.java:66–71`、`JdbcRepositorySupport.java:32–50` 和 `LocalRuntimeStore.java:365–379` 的身份或哈希包含物理 cwd。                     | root 迁移必须建立新 placement；原地修改旧 Runtime 行会使其证据失效。                                  |
| Hosted 冷加载 | `hosted-harness-session.ts:302–305,353–356` 把 Harness cwd 写进 `managed-root`；存在未结算输入或恢复 bundle 非 OK 时拒绝加载。                   | Harness cwd 不是远程 Workspace 身份。执行中的 Turn 续跑仍属于 Stage G。                               |
| 文件历史      | `hosted-workspace-tool-turn.ts:67,78` 明确不提供 undo 备份，worker 也关闭文件 checkpoint。其他 Managed 路径能够记录 `file_history`。             | `file_history` 记录只是元数据，不包含全部备份字节；备份可能在 Workspace 外的 Session 文件历史目录中。 |
| 公开路径      | 调研基线的 main 仍对 Workspace 执行设门禁；[G0 #12955](https://github.com/QwenLM/qwen-code/pull/12955) 当时尚未合并，且仅开放初始文件工具 Turn。 | 可以先开发 W1 内部能力；公开恢复与后续 Turn 验收需要另行接通产品路由。                                |

上述 Java 路径位于 `packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/` 或 `packages/sdk-java/runtime-broker/src/main/java/com/alibaba/qwen/code/runtimebroker/`。TypeScript Hosted 路径位于 `packages/cli/src/serve/`。

已合入的 [W0e 恢复设计](2026-09-27-managed-workspace-recovery.zh-CN.md)、[受信任重启切片](2026-09-28-local-reboot-recovery.zh-CN.md)和 [G2 接管扫描](managed-runtime-takeover-scan.zh-CN.md)继续定义各自范围。它们的物理停止与原执行结果证据不能证明文件内容完整。

## 3. 边界与不变量

- 保留 `tenantId`、`workspaceId`、`workspaceGeneration`、`storageId`、`cwdRelative`、`contextConfigRef` 和 `contextRevision`。W1 不切换 Session cwd、不改选 Workspace、不替换存储。逻辑变更需要另行准入、W2 或新建 Session。
- 保留原 command、input、execution 身份、结果回执、日志字节和模型实际消费的消息。挂载迁移和回填都不改写已提交内容，也不重放工具副作用。
- 区分三件事：原执行结果、旧写入者不能再回来的证据、存储及资源可用的证据。三者互不推导。`ABANDONED` 仍表示结果未知，不是成功结果或自动解锁。
- W1a 面向 root 具有无歧义持久 birth time 的受信任单主机 OpenJDK 21/Linux local-process 部署的进程重启，以及已保存的 `hosted-workspace-files/1` 或 `hosted-workspace-shell/1` profile。Broker 重启后的下一工具 Turn 需要 `durable-local-process=true`。整机重启后只有登记身份仍匹配才允许恢复，不承诺可跨重启的通用身份。任意配置快照、Legacy 导入、跨主机接管、Kubernetes、同 UID 恶意写入者、磁盘/虚拟机回滚、在线迁移均不在其验收范围。
- 新执行需要当前授权。获授权的历史/导出，以及基于保存身份的清理，不要求挂载正常。撤权必须阻断新工作，同时允许可信清理继续。
- 公开 Items/Snapshots 不能重建私有 Session authority。O2 的结果字节也不是 Workspace 文件系统备份。

## 4. 交付切片

| 切片                    | 交付内容                                                                                       | 依赖与退出条件                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W1a：原位置恢复**     | 持久本地存储登记、运行时准入检查、clean-load 校验和运维诊断；显式纳管现有已绑定部署。          | 基于 W0e/G2，启用远端 publication 时复用 O2 校验。证明同 root 恢复，以及跨进程重启后拒绝替换过的 root。公开恢复在产品路由存在前继续受门禁限制。本地 M2/M5/M6 保持独立。 |
| **W1b：回填与快照校验** | 从 authority 记录有界重建恢复元数据，版本化恢复 manifest，以及外部 snapshot/restore 回执校验。 | 依赖 W1a、可信快照来源及私有资源闭包。仅当所选 profile 的已接纳结果使用 O2 时依赖它。不构建通用备份引擎。                                                               |
| **W1c：可验证迁移**     | 同一逻辑存储在同主机上的离线迁移、持久迁移回执与新 Runtime 安装。                              | 依赖 W1a/W1b、全部旧写入者已停止的证据，以及所有受影响 Session/profile 都支持迁移的清单。首版仅支持使用相对路径的 Hosted 文件工具 Session。                             |

W1b/W1c 不代表 G1/G3 完成。调研时仍 open 的[运维恢复 #12977](https://github.com/QwenLM/qwen-code/pull/12977)在证明后释放旧 holder，但保留失败 Turn 的阻塞状态。W1 应复用该边界，不另造强制解锁路径。

## 5. W1a：持久存储登记

### 5.1 最小存储改动

扩展按 tenant/storage 定位的 `managed_workspace_execution_lease` 行，不增加另一套锁服务。新增用于核对哈希的精确 tenant/storage 标识、单调递增的 `mountRevision`、`mountState`（`unverified`、`ready`、`fenced`），可空的 active `mount_operation_id` 与 completed `mount_completed_operation_id` 回执，以及版本化挂载身份和登记回执。已有 holder 字段及其所有权语义保持不变。大 manifest 不放在这行中。

没有登记意味着 `unverified`，不能自动登记启动时碰巧找到的目录。启用 W1 的执行路径必须拒绝它。现有部署只能在维护期间登记：运维人员检查原存储、停止准入并核对全部旧写入者后，显式纳管。这建立了有记录的 W1 起点，不反向证明全部历史字节都曾被捕获。

V25 保存规范 root、应用专属 host 身份、明确的数值 device/inode、独立的 `mount_birth_time`，以及随机分配的 storage registration ID。Marker v2 `.qwen-managed-storage.json` 保存同一身份，其中 `birthTime` 为保留纳秒精度的规范 `Instant` 字符串；SQL 与 marker 必须一致。Host 身份使用 HMAC-SHA256，以去除首尾空白的 `/etc/machine-id` UTF-8 字节为 key，以 `Qwen-Code/verified-workspace/v2` 为输入；marker 不暴露原始 machine ID。登记只校验已存在的 root，绝不创建替代项目目录。标记使用排他/no-follow 创建和持久发布；登记中断后保持 unverified，按原回执恢复。已有冲突标记时拒绝，不能覆盖。读取前以 no-follow 检查拒绝非普通文件，避免静止 FIFO 阻塞登记或维护；这不防御同 UID 写入者的恶意并发替换。

在同一次 no-follow 属性读取中取得 `unix:creationTime`、`lastModifiedTime`、`dev` 和 `ino`。OpenJDK 21 在 birth time 不可用时会返回 mtime 或 epoch，因此 creation time 不晚于 epoch 或等于 mtime 都拒绝。真实 birth time 恰好等于 mtime 也保守拒绝：离线完成项目布局或更新 root 的 mtime 后再重试登记。Mtime 只用于识别歧义，绝不作为身份持久化；普通 mtime 变化不能使未变的 birth time 失效。仅 device/inode 不够，因为删除目录后从备份解压可能复用 inode 号。

标记是 host/文件系统身份的补充，不是授权凭证或文件完整性证据。复制标记不能授权另一个 root。登记完成后标记丢失会阻断恢复；W1a 不提供修复或重新纳管命令，也不自动重建。这是可信负载下的连续性检查，不防御同 UID 恶意进程、文件系统回滚或管理员有意复制身份。device 身份变化、不支持的身份提供方式或重启后的比较不明确时，保持准入关闭。新建 fence 与 restore 需要完整的原身份与 marker；W1a 不能 force-fence、重新登记或修复变更后的映射。只有重新呈现已验证的原映射才能继续现有维护校验；其他修复需独立离线设计。不能把 `fileKey.toString()` 持久化后当成可移植身份格式。

Storage root 必须位于所有 Git worktree 之外，Session 工作目录放在其子目录中。Marker 是管理员维护文件，不能通过模型工具读写，也不能纳入 Git cleanup/stash 操作。这种布局减少误删除，不限制工具通过主机权限访问其他路径。缺失 marker 的修复需另行设计，包含精确 revision/回执和 holder 校验。

只有完整且有效的登记才能将 `unverified` 改为 `ready`。`fenced` 关闭准入，直至同一维护操作完成，或明确恢复仍已验证的原映射。进入 `fenced` 时比较 `ready` 状态与预期 revision，并保存 operation ID。续办、切换映射和解围都同时比较该 operation ID 与 revision；第二个操作不能仅凭 revision 相同就接管。解围递增 revision 并保留已完成操作回执，以便丢失 ACK 后重试，且旧 fence 不能重新开启维护。不存在超时自动解锁。`mountRevision` 为已验证物理 placement 及维护转换的证据编号，不替代 Workspace generation、context revision 或 Runtime generation。

### 5.2 检查位置

在 Hosted attachment 和缓存复用时、冷恢复 Session 发起新模型工作之前，以及为新工作解析/provision/acquire Runtime 之前，检查保存的 binding、当前权限和已登记挂载。在 claim 事务内和新的 execute 前再次验证 storage guard。Broker 配置若指向不同 root，必须因与持久身份不符而关闭准入；revision 是维护 CAS 凭据，不是新的 Runtime 协议字段。

最后一次准入检查必须在取得 storage 行锁后读取当前 guard 状态并核对原 root 身份。只在等待前检查一次并不够。正常 release 与 W0e 清理只能清除自己的精确 holder 字段，不能删除登记或撤销迁移围栏。即使新执行被拒绝，原执行的 status/cancel/recovery 仍通过保存的原 generation 处理。

W1a 不改 `managed-context/1`。其七字段逻辑 digest 本来就不含 mount root，现有 attestation/installation 回执绑定物理 Runtime。Java 的 guard 检查补充这些回执。如果要求 Worker 独立校验新增存储证明，必须协商协议新版本，不能向封闭的 v1 envelope 直接加字段。

### 5.3 锁顺序与部署

当前 claim 的锁顺序为 Runtime binding → Runtime Session → storage lease；失联 holder 清理为 binding → storage lease。保留此顺序，绝不能持有 storage 行锁再扫描并锁定 Runtime bindings。

W1a 维护先关闭新工作入口，结算或取消原执行，证明全部写入者停止，再按现有所有权协议释放精确 holder。停止相关服务和外部写入进程并禁止重启后，才在预期 `mountRevision` 上提交 storage fence 短事务。Fence 要求全部 holder 字段已清空，不提供在线排空能力。已经通过 guard 检查的请求仍可能派发，因此 storage fence 本身不证明已经静默。在 worker 侧准入封闭、所有相关执行域都具备合格停止证据之前，不能把文件树当成稳定快照，也不能修改映射。

旧二进制不会读取新增 guard 字段。W1 变更启用前，所有能够控制该 storage 的进程都必须停止/排空并统一升级。维护证据还必须覆盖普通工具和其他能够写入目录的外部服务；升级 Java 并不能隔离它们。首版使用离线部署，避免再建在线版本协调系统。完成 schema migration 不等于完成安全升级。回滚至旧二进制时，服务和入口必须保持停止，直到显式对账完成。持久 fence 或关闭新开关无法约束不读取新增列的旧二进制。

物理 mount guard 使用默认关闭的 Broker 属性 `verified-workspace-recovery-enabled`。Hosted Workspace 冷加载校验始终启用，不受该属性控制；省略 tool profile 或 Shell `captureBytes` 时采用保存的 definition，显式提供的值必须精确匹配。保存的审批设置继续固定。私有入口 `WorkspaceStorageRegistrationMain` 支持 `register`、`inspect`、`fence` 和 `restore-original`；修改操作必须显式声明离线维护，并使用精确的 operation ID。[服务端 README](../../packages/sdk-java/managed-agent-server/README.md)给出了调用方式和升级顺序。该声明本身不能停止外部写入者。登记和执行需要受信任的 Linux 身份提供者；本地 H2 测试使用合成提供者，不能代替 Linux 验收。

### 5.4 已确认的 W1a 恢复契约（2026-09-30）

W1 保留资源校验和省略 profile 时的自动采用只适用于保存的文件/Shell profile。已独立合入的 MCP profile 保留显式 profile/server-pin 加载规则及自身恢复契约。原 MCP status/cancel/release 检查保存的 lease、Runtime 状态和精确 storage holder，不要求物理 mount 可用；新的 MCP 配置、发现和调用仍要求已验证 mount。

Owner 已选择内部 Java → Hosted → Runtime 恢复、进程重启，以及严格的历史完整性。公开恢复和后续 Turn 准入作为独立接线。Passive Hosted attachment 保留 Session、Registry、grants 和 profile 授权，只跳过物理 mount 校验；原执行清理继续通过保存的 Broker 身份处理。保留 O2 对原 `results_ready`、consumed-final 和 `not_started` 回执的受控恢复，不能将 unknown/abandoned 执行当作新工作。W0e/G2 继续负责精确原执行的对账。打开 Session 不清除物理 holder。

取得独占 writer 并安装 activation 后，捕获 `S = restoreBundle.throughSequence`。发起新模型工作或 Broker prepare/execute 之前，在同一 S 校验全部保留的事件/资源根和消息投影。Record sink/projection 使用可选的 `throughSequence`，不传参的调用保留原行为。保留原回执的受控恢复，包括为不完整回执 ACK blocked 或修复历史后仍拒绝加载。因此拒绝加载不意味着零 journal 写入或零 ACK。恢复扫描和投影使用已验证的 cut，只按原身份写入已校验的原结果，不 prepare 或 execute 替代工具。完成本次 history/checkpoint 修复后，按最新授权及 continuation 状态判定，在 `executeHostedTurn` 和发布 attachment 之前最终调用 `assertWritable`。这些已知恢复写入不要求再次完整扫描历史。Activation 续租可以推进传输 cursor，不要求原始日志尾部完全不变。拒绝时不接纳新业务输入，只关闭本次取得的租约。

验证 header 引用、事件 schema 声明的引用、checkpoint typed refs 和实际消息投影。继续支持内建 session-metadata 标题记录及其 previous-record 引用，扩展 domain 仍拒绝。所有承诺完整的 Shell manifest、page、segment、seal、长度及完整流摘要都必须有效；空流也需要 seal。按资源 ID 去重，同时拒绝引用元数据冲突。输出分块读取，不降级为仅检查最新 checkpoint。旧已结算 Turn 的资源缺失同样拒绝冷加载。不支持的扩展 domain、Legacy file-history 备份和外部附件形态直接拒绝，不能将顶层读取冒充闭包验证。W1a 不构建通用 JSON 引用遍历或快照引擎。

对于 O2 持有的输出，受 Session writer 授权的窄验证入口按原 outcome 引用定位唯一 REFERENCED publication，核对执行 ID 和 journal 回执序列，复用 `validateFinished` 校验远端 pages、全部 segments 和 SQL seals。顶层 publication receipt 可读并不足够。不完整回执只有在该校验成功后才允许修复原历史或 ACK blocked，加载仍拒绝。已证明 `not_started` 且 capture 为 null 的回执无需 publication catalog。其他私有引用仍按固定 committed cut 校验。该整合仍需新版本验收结果。

登记先持久化准备好的身份，再持久发布 marker，最后提交 READY。同一操作的并发重试必须收敛，包括最终提交成功但 ACK 丢失。已完成的登记/restore 重试重新验证当前身份和 marker，不再次推进 revision。Inspect 即使在 FENCED 状态也报告状态、revision、操作回执、holder 存在性和物理校验。根 marker 证明连续身份，不证明文件内容完整。

## 6. 冷恢复流程

1. 读取保存的 Session 和原创建回执，重新检查当前访问权、精确的 Registry generation/storage、固定 config/policy 引用及启用的 profile。不能用当前默认值填补缺失字段。
2. 校验已登记存储身份与原相对 cwd。目录缺失、别名、符号链接替换、身份变化或 fenced storage 都保持执行关闭。不能 `mkdir`、clone 或回退到 `.`。
3. 获取现有私有 Session writer lease，恢复权威日志和所需资源闭包，核对保存的 definition，包括 tool profile 和 `captureBytes`。新模型工作或 Broker prepare/execute 之前，在同一 committed cut 校验 typed message/checkpoint/result 闭包。保留 O2 基于该 cut 对原回执的受控恢复；修复后按最新授权/continuation 状态判定，并在模型工作或发布 attachment 前复查 writer 所有权。不可恢复的未结算输入返回 `hosted_turn_recovery_required`，绝不作为新工作重放。拒绝时只释放本次新获取的 writer lease，不释放物理 holder。
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

| 组件 / 消费者                                                                  | 所需变更或保留边界                                                                                               |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `ManagedWorkspaceRegistry`、`ManagedAgentStore`                                | 复用原 binding 与当前授权；有界回填不能修改旧创建回执。                                                          |
| `WorkspaceExecutionStore`                                                      | 增加 storage 登记/guard，在 claim/assertion 路径检查，精确 holder 释放时保留它。                                 |
| `WorkspaceRuntimeResolver`、`WorkspaceRuntimeTransport`                        | 比较配置与持久映射、root 身份；guard revision 仅用于维护 CAS。保留 cwd 检查和回执校验。                          |
| `EmbeddedRuntimeBroker`、`WorkspaceRuntimeProvisioner`、`RuntimeBrokerService` | 对新工作施加门禁，保留原身份观测/清理，维护时枚举所有相关已保存 placement；复用 W0e/G2。                         |
| `QwenHostedHarnessConnector`、`HarnessCoordinator`                             | 在 attachment 和缓存复用时校验；接通 clean-load，不意外扩大 G0 公开 Turn 范围。                                  |
| `hosted-harness-session.ts`、Managed authority/resource readers                | 原回执恢复前验证保留的私有资源及 O2 输出闭包；拒绝不可恢复的未结算输入，并在 continuation 前复查 writer 所有权。 |
| Worker context/activation                                                      | 在新 Runtime 重新安装和验证原逻辑 context；W1a 不静默增加 boot-envelope 字段。                                   |
| File-history readers / snapshot adapter                                        | W1b 校验元数据和字节；W1c 只支持逐项审计过的类型化路径映射。                                                     |
| 公开 API / WebShell                                                            | 保留读权限与现有失败语义；不开放 cwd 变更、storage 路径、强制恢复或提前宣告 `workspace_context`。                |

W1a 首版实现包含一个增量 migration、登记/guard 及其调用者、小型私有维护入口、定向测试和本设计。后续 PR 不应将 W1b snapshot adapter 或 W1c 迁移状态机并入其中。整合基线已包含 #12977；保留其可审计原 owner 清理，并将 storage 登记与部分 Shell 恢复分开。

V25 接在 main 的 O2 migrations V20–V22、MCP V23 及 Actions V24 之后，在 mount 登记中增加 `mount_birth_time`。保留现有封闭 ContextBinding 和 worker 协议，整个部署升级并完成登记前不启用 W1。预合并实验的 W1 V21/V24 数据库和 marker v1 不能直接升级至 V25/v2。实验 W1 V24 还与 main 的 Actions V24 冲突，不能将 migration 重命名视作原地升级。不能通过 Flyway `repair`、`outOfOrder` 或手动改 history 绕过不匹配。有保留数据的部署需要备份及独立的离线迁移设计；只有可丢弃测试部署可以重建。普通本地 Managed 引擎仍按独立排期延期。

## 10. 验证与验收

详细工作计划位于 `.qwen/e2e-tests/managed-workspace-w1-recovery.md`（被忽略的开发产物）。随本设计提交的验收要求如下：

| 门禁               | 必须观察到的结果                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1：干净重启       | 保存一个已绑定、Turn 已完成的 Session；重启 Java/Harness，只删除其可丢弃 home。同一 storage/cwd/config 和私有模型历史能够恢复，没有重复物理副作用。                                                                                                                                                                                                  |
| A2：持久身份       | 停服后替换原路径上的 root，包含删除后从备份解压、复制 marker 且实际复用 inode 的情形。Birth time 变化必须拒绝；身份未变时重启及普通 mtime 变化仍成功。缺失/冲突/v1 marker、缺失 birth time、epoch 和 birth==mtime 均拒绝。                                                                                                                           |
| A3：权限           | 默认值改变不会重新绑定。Registry generation/storage 不符、移除、撤权、cwd 缺失或配置不符时阻断新工作，同时保留相应授权的历史访问和基于原 owner 的清理。                                                                                                                                                                                              |
| A4：并发           | 两个 Broker 进程的 claim/execute 与 storage fence 竞争，包含已经通过早期检查的请求。Claim 先成功则 fence 拒绝；fence 先成功则 claim 拒绝，包括已通过早期检查的请求。过期 release/cleanup 不能清除较新的 holder 或 guard。Fence 本身不证明在线静默。                                                                                                  |
| A5：中断 Turn      | Storage 可复用后 unknown/abandoned 执行仍阻塞。保留 O2 原 ID 的 results_ready/consumed-final/not_started 恢复及保存的 captureBytes/profile 匹配。私有或远端 pages/segments/seals 缺失或损坏时不能发起新模型/prepare/execute；不完整回执可在拒绝前 ACK blocked 或修复历史。恢复使用已校验 cut，之后按最新授权/continuation 状态判定并最终复查所有权。 |
| B1：回填           | 在每批处理边界崩溃重试，派生数据保持相同身份/digest、内存有界且无重复引用；无绑定或证据不足的 Session 不升级。                                                                                                                                                                                                                                       |
| B2：快照闭包       | 检出缺失/损坏的备份、checkpoint、message/result 对象、变化文件、越界链接及来源水位不符。任何不兼容 Session 都阻止整个 storage 激活；晚到的 Session 创建和无工具 journal 提交不能越过维护边界。不能报告完整恢复，也不能覆盖活动共享文件树。                                                                                                           |
| C1：迁移           | 两个 Workspace/子目录以及共享 storage 的多个 Session 保留逻辑 binding。新副作用只写入验证后的目标路径，旧回调仍绑定旧 placement。                                                                                                                                                                                                                    |
| C2：迁移中断       | 在 fence 后、字节校验后、映射 CAS 后和最终 ACK 前杀掉维护进程。同一 operation 重试；旧请求不能解开或切换更高 revision。                                                                                                                                                                                                                              |
| C3：不支持的消费者 | 存在不可映射绝对路径资产的 Session/profile 时，拒绝整个 storage 迁移。成功的受支持迁移也保持历史消息和结果字节完全不变。                                                                                                                                                                                                                             |

使用真实打包的 Harness/worker、生产 Broker/SQL 接线和确定性本地模型。H2 用于定向契约；双进程竞争和持久化门禁还必须在 MySQL 8 上运行。Linux 进程重启是必需验收，合成身份检查不能替代它。整机重启验收不属于 W1a，不重启共享工作站。初始公开 G0 路由已合入；公开 Workspace 恢复/后续 Turn 准入仍为独立整合门禁。

## 11. 替代方案与各切片前的决策

- **重启后重新读取部署 root 即可：** 不采用。这会重建当前的内存基线，可能接纳替换后的存储。
- **只增加 root 标记或文件树哈希：** 不作为唯一权威。标记必须匹配持久登记和物理身份；snapshot digest 只证明一个内容版本，不证明身份连续性或写入者已隔离。
- **换 Session/默认目录来恢复：** 不采用。会丢失 binding，并可能重复副作用。
- **把备份、迁移和 G1 一起实现：** 不采用。会混淆文件恢复、进程清理和逻辑 Turn 续跑。
- **替换全部旧绝对路径：** 不采用。路径也存在于任意模型内容、Shell 和配置中，改写会破坏不可变证据。

W1a 的可信 Linux/原位置、仅内部、进程重启、离线登记和严格历史范围已确认；W1b 前选择具体不可变快照 provider；迁移开发前接受 W1c 对相对路径文件 profile 的限制。如需更广的平台、profile 或在线迁移，应先修订对应切片和故障门禁，不能把未回答的部署选择处理为宽松回退。

## 12. 实现证据

已检查 Java 持久化/租约/placement 和 TypeScript 恢复/context/file history，并对两侧分别进行了独立探索。当前整合基线为 main `78143fe33`，包含 #12955、#12977、O2 #12894、Hosted MCP #12946、#13108 及 Actions #13101。全局 CLI 基线为 `0.24.6`，没有 W1 维护入口，因此不能直接通过全局 CLI dry-run。

此前本地验证已通过定向 Java、Hosted、projection/sink 测试，以及 build、typecheck、bundle、ESLint 和 Java Checkstyle，覆盖登记/重试/fence、缓存新工作授权、passive attachment、固定 cut 校验、重命名后的文件/Shell Session 历史及保留资源缺失。打包 macOS/H2 E2E 覆盖 stderr seal 修复、Harness 重启、下一 Turn、100 MiB Shell 输出和七个 Shell producer 退出；该环境关闭物理 guard，单独不构成 Linux 验收。

[维护者针对 `7c54aa78` 的真实环境报告](https://github.com/QwenLM/qwen-code/pull/13088#issuecomment-5910509307)提供了 Linux/ext4 与 MySQL 8.4 证据，包括进程重启、专用主机重启/断电检查、两个真实 Broker JVM/worker、两种 claim/fence 顺序、派发前 fence 拒绝，以及旧 release/LOST cleanup 保持完整 storage 行不变。该精确 head 的选择集通过 209 个单元测试、15 个 Hosted 集成测试和 44 个故障门禁；只移除锁内 claim 校验的反向检查连续失败两次。这些结果证明该 head，不能代替更新候选的验证。

同一报告复现了删除目录后从备份恢复并复用 inode，以及普通 Git 清理导致 marker 丢失，分别促成本轮 birth time 和 storage 布局要求。V25/marker v2 及 O2 整合后的 load 路径仍需新的定向测试、Linux/MySQL 门禁及精确 head 验证，尤其要重跑实际 inode 复用拒绝、远端输出闭包失败时零新模型/prepare/execute，以及原回执的成功恢复。公开 Workspace 恢复/后续 Turn 准入保持独立；被忽略的测试计划记录剩余门禁。
