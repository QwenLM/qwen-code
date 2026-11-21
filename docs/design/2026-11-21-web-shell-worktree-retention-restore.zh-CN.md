# 托管会话 worktree 保留清扫与恢复（P6 U4/U5）

[English](2026-11-21-web-shell-worktree-retention-restore.md) | [简体中文](2026-11-21-web-shell-worktree-retention-restore.zh-CN.md)

- 状态：U4/U5 已实现，隔离的 primary＋secondary 真实 HTTP/Chromium 验证已通过。本文不表示已合入，也不表示后续 P6/P7 范围已完成。
- 调查基线：`01b7e92f61b1593517acd1e4afe752d431280e90`。
- 跟踪：[#17237](https://github.com/QwenLM/qwen-code/issues/17237) 中 P6 的 U4/U5，不扩展其它范围。
- 承接：`2026-11-17-worktree-carry-metadata.md` 与 `2026-11-17-worktree-retention-snapshots.md`。
- E2E 计划：`.qwen/e2e-tests/2026-11-21-web-shell-worktree-retention-restore.md`。
- 2026-11-21 进展：core 快照、绑定与 pin store 套件共 167 项通过；受影响 CLI 路由套件共 380 项通过；archive 生命周期共 123 项通过；DaemonClient SDK 579 项通过；SessionOverviewPanel 共 182 项通过。筛选的 lifecycle 用例另有 71 项通过。修复 live/cache 生命周期投影后，扩展的 preview 套件为 6/6，原有 session-list 套件为 64/64。primary＋secondary 的真实 HTTP 与浏览器验证也已完成；这不是根据包测试或更早基线推断的结论。
- 基线发现的权限偏差已在归档解包边界修复：node-tar 不把捕获的 mode 应用到复用的 HEAD 文件上。恢复时替换这些文件，从而保留快照的属主可执行位。这不是对整个 checkout 做权限归一化，也不表示已经在未验证的平台通过。

## 问题与改动前状态

快照与 dirty 覆盖层原语已经存在。`packages/core/src/services/worktree-snapshot-service.ts` 中的 `captureWorktreeSnapshot`、`buildWorktreeSnapshotMeta` 与 `restoreWorktreeSnapshot` 保存原始字节、属主可执行位、符号链接、hardlink 及 tracked 删除；`.git`、会话 marker 与 ignored 的可再生输出被排除。`packages/cli/src/serve/server/worktree-orphan-cleanup.ts` 的保护式清理也会在隐藏索引位、暂停操作、初始化子模块、内容漂移或 checkout 无法校验时拒绝移除。

剩余缺口是编排，不是 tar 能力：

- `worktree.maxRetained` 虽已声明，但仍是预留字段：没有保留清扫读取方，不在 daemon settings allowlist 中，中文说明仍明确写着尚未应用（`packages/cli/src/config/settingsSchema.ts`、`packages/cli/src/config/config.ts`、`packages/core/src/config/config.ts`、`packages/cli/src/serve/routes/workspace-settings.ts`）。
- 尚无保留清扫、按会话的归档选择器或生产侧快照恢复调用。
- `WorktreeSession` 没有「已移除＋快照」状态。更关键的是，`packages/core/src/services/worktreeSessionService.ts` 的 `restoreWorktreeContext` 在目录不可用时可能清除绑定。
- 普通 archive/unarchive 搬移 transcript 与 worktree sidecar，却不搬移旁置的快照对；快照状态可能因此脱离所属会话。
- `executeWorktreeCleanup` 不返回移除结果，且假定会话记录已经删除，不能供保留 chat 的清扫原样调用。
- pin store 为普通 UI 读取而把不可读 store 降级为空 store。此行为绝不能成为清扫的删除授权：应以 `packages/core/src/services/session-organization-service.ts` 中已有的 `readStoreDocument()` 为基础，实现严格的限定范围 pin 检查。
- `restoreWorktreeSnapshot` 只支持在全新重建的 worktree 上解档。它不负责选择归档、创建 Git worktree 或 owner marker、校验仓库对象，也不原子更新 sidecar。直接对非空目录调用它并不安全。

P7 可配置 worktree 根、既有按龄期的 tool/agent 清扫、arena/managed-agent 会话存储、Java 生命周期代码、归档过期清理开关，以及另行跟踪的 R5/覆盖建议均不在本阶段范围内。

## 决策与范围边界

### 1. 只对归属唯一的管理根计数

每次清扫都隶属于选定的 workspace runtime、其自身的 `SessionService` 与持久化 store。它不会缺省枚举 primary workspace，也不会把资源迁移到其它 runtime。候选必须通过现有严格 ownership 与 containment 校验，包括 route-owned 的 `workspaceCwd`、来源根、slug、marker 和预期的托管根推导。

**清扫范围覆盖整个 daemon 的合规 workspace**：`workspaceRegistry.list()` 返回的每一个 active、合规、non-internal runtime 都在范围内，主 workspace 与非主 workspace 都包括在内。每个 runtime 都使用自己的 settings、session/pin store、bridge、生命周期 generation 和在途任务记录；非主 runtime 的操作不得转交给 primary runtime 的配置或存储。internal/scratch runtime 不纳入清扫，除非它明确处于所要求的 worktree 范围内。

对 linked checkout，仅凭原始 `cwd`/transcript cwd 或 `originalCwd` 不能证明 daemon workspace 的所有权。`originalCwd` 定位创建它的 worktree service/repository；需要由 `workspaceCwd`、marker、runtime 本地存储、当前 registry 与 session-owner index 共同证明归属。父级/包含关系须使用 canonical realpath；若 workspace 发现结果中有多个可包含的父级，则选择最具体的已登记父级 scope，而不是默认落到最外层 primary。该关系必须与当前 runtime owner 一致，不能只是字符串前缀或 `$QWEN_CODE_PROJECT_DIR`。历史记录缺少经证明的 `workspaceCwd`，或其它不能唯一证明 owner 的记录/根，都应保留并报告，不能凭假定清扫。

若多个 runtime 声称同一个规范管理根，或其有效设置冲突，则停止该根的自动清扫并输出诊断。workspace 的 ownership 未知、不受信任、runtime 正在 drain，或其根不可读时，同样停止。这里不做跨 runtime 聚合计数，也不回退到 primary runtime。这是已选择的保守边界，不另外发明分布式锁或隐式的配置优先级赢家。

仅符合条件且通过 ownership 校验的记录计入 `N`。活跃及置顶 chat 受到额外保护，且不占用可删除配额：最近 `N` 个合规记录和这些受保护记录均存活。保留最新 `N` 个合规记录后，对更旧的合规记录优先清扫。chat 记录及 sidecar 存活，只有合规 checkout 被回收。

最后活动时间采用已有持久化 session/transcript 时间戳；如已有 live 活动时间，取较新的值。若无法读取 session 时间戳但已确认 sidecar 的 ownership，则使用经校验的 sidecar/快照时间戳作为已定义的 fallback。目录 mtime 不是活动时间；不可读或非法时间戳不能静默变成「最旧、最该删除」的候选。

### 2. 保留孤儿归档，不猜测 ownership

没有可验证的存活记录与 sidecar 时，不因数量、龄期或恢复探测而自动删除归档。本阶段不新增 TTL 设置，也不新增自动「孤儿清理」。

同理，孤儿归档不能催生新的 live chat，也不能从文件名猜测仓库。快照头只有捕获元数据，不是完整的 repository/workspace ownership 证明。在失去有效 owner 时的恢复，仍是需要另行决定的政策问题。此决定既不删除归档，也不断言它对人工恢复毫无价值。

### 3. 每次保留清扫移除前都必须捕获快照

保留清扫删除任何合规 checkout 前，都要先捕获该 checkout。即使现有会话删除规则允许对只含原始搬运覆盖层的 checkout 裸回收，也不适用此例外。来源在清扫后仍可能变化，保留的 chat 必须有可用于日后恢复的归档。

其它生命周期路径原有的 U3 裸回收结果保持不变。U3 计算出的 `needsSnapshot`、`worktreeHasWork`、前后内容摘要、隐藏索引位检查、暂停操作检查、搬运来源复核、populated-gitlink 检查和 `checkoutMatchesCapture`，继续作为共享安全逻辑。不可读或快照不能忠实表示的状态一律保留 checkout，不放宽这些不变量。

### 4. 明确定义移除状态及其归档对键

建议在保持旧字段兼容的前提下，新增以下可选 sidecar 状态：

```text
worktreeRemoved?: { archiveKey: string }
```

`archiveKey` 只能是经过校验的 tar 基本文件名，不得包含目录分量、路径穿越或平台分隔符替换。对应 JSON 头文件使用同基名的 `.json`。稳定的键使 archive/unarchive 可以同步搬移归档对，而不会记录随目录变更而失效的绝对路径。

只有在真实移除结果成功，且确认目标 checkout 目录已经不存在后，才写入该状态。快照已创建、HTTP 返回 `removed`，或仅凭 `removeUserWorktree().success`，都不是证明。`branchPreserved`、`keptBranch` 与部分移除的诊断必须继续区分，并决定后续分支策略；`removeUserWorktree` 的未合并提交和 ref ownership 保护不变。

sidecar 的 64 KiB 上限继续有效。既有 `fitSidecarToReadCap` 可以丢弃 `carriedEntries` 来保住绑定，但必须保留移除记录。移除记录畸形时，sidecar 视为损坏，而不是「干净」。严格读取继续沿用现有 `readWorktreeSessionStrict` 契约，不以宽松解析接受新状态。

不得改写 `originalCwd`、`workspaceCwd`、`originalHeadCommit` 与 `worktreeBase` 等创建来源，使后续历史看起来像首次创建。恢复采用捕获时的 `headCommit` 和 `branch`；可变的 `worktreeBranch` 反映重建后的实际 checkout，因此 detached 恢复不会意外获得旧 slug 派生 ref 的 ownership。既有 carry 元数据在仍有效时保留，但恢复不能编造新的搬运豁免。

### 5. 归档对必须随 archive/unarchive 搬移，并使失败可见

archive/unarchive 必须让全部归属明确的同名归档对随 transcript 和 sidecar 一起在 `chats/` 与 `chats/archive/` 间移动。配对身份由 `sessionId`、`slug`、基本文件名、头文件对应关系和移除记录共同校验；不能仅凭前缀相同就把文件提升为受信任的归档。对仍有效的现有 checkout 做普通 archive，仍是非破坏性的，也不额外创建快照。

搬移不完整、归档对不可读、目标重复/冲突或 active/archived 位置含义不明时，必须明确失败并保留可恢复产物。不能让读取方静默选用另一个目录中的无关旧副本。读取使用当前已验证 archive 状态对应的归档对。选择器不得跟随目录级或文件级 symlink 逃出所属位置。

worktree 已移除的恢复会话在 archive 操作中仍须与恢复协调。沿用既有 archive coordination 与串行化顺序；在没有该协调时，不得于选择或解档期间搬移其快照。

### 6. 目录缺失本身不是恢复许可

必须在通用的 missing-directory 清理之前处理 `worktreeRemoved`，使已识别的移除状态不会被当作陈旧状态删除。其它没有此状态的旧非 daemon 情形仍保留原行为，除非另行评审；通用 CLI/agent worktree 不被拉入本功能。

物理移除成功、但 sidecar 写入失败，可能留下旧 sidecar 和新归档。只有在以下各项同时成立时才允许识别为可恢复候选：记录属于当前选定的 runtime、ownership 有效、预期位置不再是一个经验证的 live checkout，并且完整归档对确实匹配同一个 session/slug。它可以提供恢复，但不能被描述为一次原子历史移除的证明。快照生成与 sidecar 修改不是原子事务。

只有目录缺失、陈旧的 `.git` 指针、前缀碰巧匹配的任意快照，或一句「not found」错误，都不足以成为证据。既有 load/reset 路径必须区分认可的恢复候选与无法辨认的陈旧状态。仅做只读枚举不能静默改写状态；受认可的写入属于经过所有权控制的恢复操作。

## 共享捕获/移除执行器

在既有清理实现内做窄提取，不另建第二条删除流水线：

- 保留 `worktree-orphan-cleanup.ts` 中现有检查顺序和条件。
- 提取一个内部执行接缝，返回结构化的 `removed`/`preserved` 结果、快照信息和真实分支/移除结果。
- `executeWorktreeCleanup` 保持为兼容 wrapper，对旧调用方丢弃结果。
- 为保留清扫提供明确的 `requireSnapshot` 选项及可选的最后保护回调。该回调在既有捕获/漂移检查之后、实际移除之前执行，重新检查严格 pin 状态与活跃会话保护，不能替代 U3 的任何检查。
- 使用所选 runtime 的存储和 bridge，复用既有 checkout 的 `preclassifyWorktreeCleanup`/`verifyWorktreeCleanupOwnership`。不得调用会删除存活 chat 或其附件的会话删除入口。

这里不需要抽象的「清理算法仓库」。只有两个调用点，共享同一条安全关键的执行路径，不能削弱 U3 已验证的条件。

## U4：限定 runtime 的保留清扫编排

在既有 worktree 清理代码旁增加职责单一的 daemon 模块及其同目录测试，不把调度器放进 ACP bridge 的 idle-turn reaper。仅对符合条件的受信任 workspace runtime 启动，并使用现有 scheduled work 的 runtime 生命周期停止。枚举 registry 中每一个 active、受信任、non-internal runtime，而不是仅枚举 primary。动态加入、drain/cancel、移除及 generation 变化也适用同一覆盖范围：closed、blocked、removed、untrusted runtime 均不得接受新的破坏性保留操作。尤其是 scope 缺失时，不能借 `resolveWorkspaceCwd(undefined)` 将 owner 不明的请求回退到 primary。

可接入的位置包括 `server.ts` 中 per-runtime start/stop map 与 `scheduledActivity`、`run-qwen-serve.ts` 的 workspace add/drain 钩子，以及在 ownership 证明或破坏性变更前调用的 `captureRuntimeGenerationAssertion`。调度器必须：

1. 读取当前 runtime 的配置，而不是进程级 primary profile；
2. 严格读取该 runtime 自身的 active/archived 会话 sidecar；
3. 仅分类唯一归属的根和合规候选，避免同一根的重复清扫；
4. 按 canonical-path/raw-fallback 键规则取得 `acquireWorktreeOwnershipOp`，并保持既有 ownership-lock → archive-coordinator 顺序；
5. 在破坏性操作前重新校验 ownership、严格 live/pin 状态以及全部 U3 条件；
6. 捕获、移除、确认文件系统结果，再原子保存并回读仍存活的 sidecar；
7. 把在途工作纳入停止/drain 等待，不能在 Git 或元数据写入中途强杀任务。

许可在候选之间取消。Git/元数据变更开始后，沿用 `removeUserWorktree` 的完成并保护语义，不得强杀写入方。重启后按上述 ownership 规则恢复，不盲从旧的内存快照继续执行。

live 判断中，只有明确 not-found 且不在 closing 的会话才算消失；查询能力缺失、查询失败或 closing 状态均按保护处理。pin 检查增加一个小的 strict getter，复用 `readStoreDocument()`、同一存储和 store-lock 语义，区分真正没有 pin 记录与 store 不可读/损坏。不得改变普通 UI 的 pin 降级展示语义。实际移除提交后再发生 pin 变化时，仍须让归档和保留 chat 可恢复，不可将其表述为移除前就已受保护。本阶段不宣称跨进程分布式 pin 事务。

## U5：确定性的归档选择

在 `worktree-snapshot-service.ts` 中增加小型会话选择器，复用现有头部读取方及 root/package 导出面，不新增归档格式。

对当前已验证归档目录中的每个合规归档对，选择器必须：

- 只枚举精确 session 前缀的快照名与头文件对；
- 当基本文件名违反「不含目录分量」键规则，或 JSON 头指向其它 session/slug 时拒绝；
- 要求受支持的 schema version 2、完整同基名归档对和完整有效的头部内容，其中 `createdAt` 必须是非负、安全的整数，单位为 epoch milliseconds；
- 要求普通文件及已有 no-symlink/link ownership 输入约束；以及
- 依次比较头部 `createdAt`、归档 `mtimeNs`、完整归档路径的确定性顺序，绝不依赖目录枚举顺序。文件系统的 `mtimeNs` 必须作为 `bigint` 比较，不得转成 `Number`；如需写进 JSON 证据，应序列化为十进制字符串。

竞争头部不可读或畸形、版本未知或目录不可读时，拒绝选择；不能静默回退到一个看似有效的旧归档。无关文件不得被臆造为会话快照。

既有 `checkoutMatchesCapture` 是捕获时结果，而不是写入归档的持久认证。选择不代表归档有签名，也不证明过去的删除一定已提交。它只为后续受保护恢复建立结构、归属绑定和确定性选择。

## U5：受保护的恢复编排

在 `packages/cli/src/serve/routes/session.ts` 的既有 worktree 流程旁增加恢复操作，不把 reset 改造成另一种 ownership 转移功能。路由形状可采用 `POST /session/:id/worktree-restore`，复用 reset 的 runtime resolver/owner-activity 模型。调用方不得提供原始目标目录或任意归档路径；归档选择由服务端拥有并重新校验。

操作顺序如下：

非 primary/linked workspace 的调用方必须显式提供该会话所属 runtime 的已注册 workspace `cwd`，不能因为请求中省略 `cwd` 就采用 resolver 默认给出的 primary。此 `cwd` 必须与 sidecar 注册的 owner、marker 及 live-owner resolution 一致。缺失、非规范、runtime 不符、不受信任、歧义或不匹配的 owner 证据都应拒绝，不得重定向到 primary。既有 primary 缺省规范化行为只保留给确实由 primary 拥有的流程。

1. 通过 `resolveRuntimeForSessionRestore`、`createWorkspaceRuntimeSessionService` 与 stored-id resolver，确定选定 runtime 及真实保存的 session id。具体的 workspace-qualified scope 必须与 sidecar 的 `workspaceCwd` 一致，scope 缺失或不明确时不得回退 primary workspace。
2. 严格读取 worktree 记录，校验当前 runtime 的 root/source/slug containment。为缺失 checkout 提供所有权解析的变体：所属管理根下的目标缺失，不应套用现有 reset 的 `realpathSync` 规则而直接失败，也绝不能把请求转到 primary workspace。
3. 按既定顺序取得 worktree ownership lock 与 archive coordination。锁内重读 sidecar，区分认可的恢复候选与陈旧状态，再确认其类别未发生变化。
4. 选择最新的有效归档对。要求 `headCommit` 是仓库实际对象格式对应的完整十六进制对象 id（SHA-1 为 40 位，SHA-256 为 64 位），不得为空、形似选项，或仅以 ref fallback 代替。再确认该精确 commit object 存在于**同一来源仓库**。对象缺失时，在创建或解档任何内容之前失败；归档不含 Git object database，也不承诺通过 remote fetch 恢复。
5. 对捕获时记录的命名分支，仅当目标 ref 仍解析到捕获 head，且不是不安全/越界引用时，才附着该分支。ref 缺失、已前进或含义不明时，改为在 `headCommit` 上 detached 恢复，报告命名 ref 未被修改，并将当前分支字段更新为真实值。`createUserWorktree(..., { detached: true })` 是不重写 ref 的路径；绝不能以 reset/rebase 强制把用户分支退到旧位置。
6. 要求目标 fresh 且归属明确。只调用 `mkdir` 或 restore 并不是完整重建：必须使用 `createUserWorktree` 和 `getUserWorktreePath`，保持 checkout、Git 管理登记与托管根一致。已有、意外非空或外部目录一律拒绝，不得清空或覆盖。
7. 使用所选头部调用 `restoreWorktreeSnapshot`，随后通过 `createWorktreeSessionMarkerExclusive` 为实际 stored session id 创建 marker。`.git` 和 marker 不属于快照内容。
8. 将恢复内容与所选归档比较：原始字节、属主可执行位、真实链接目标、记录的删除、期望 commit，以及按上述分支决策产生的当前分支状态（有意 detached 时为空）。不能仅因合法的 detached 回退与捕获时分支名不同，就拒绝这次恢复。复用 snapshot 区域已有的比较职责，不以文件是否存在作为弱校验。必要时，在解档后及最终 sidecar 修改前分别比较。ignored 的可再生输出继续遵循 U1 的排除契约。
9. 原子更新存活 sidecar，清除移除状态，并写入当前真实分支、路径与 carry identity；再次确认 marker 与 checkout 仍然有效。只有此时才允许普通 `restoreSessionCore` 迁移/打开该会话的 checkout，并向客户端提供已恢复状态。

### 失败与重试行为

不承诺 Git 与文件系统的全域原子事务。失败时保留归档及部分或完整恢复结果，返回明确失败状态，不得声称成功。

- 归档畸形、恶意成员、commit 缺失、目标异常或 marker 失败会阻止继续恢复，并保留既有文件。
- 解档/marker 创建后、sidecar 翻转前失败时，保留保守的移除记录。后续重试只有在 owned marker、目标位置及内容都证明与所选归档匹配时，才可作为绑定收尾；否则拒绝，不能在该目录上盲目重新解档。
- 迟到的用户改动、损坏或部分快照、未知额外文件及目标漂移，不能为了得到看似成功的结果而被清除。归档与明确失败原因必须保留。
- 归档元数据非法、来源不可读或竞争头部不可读时，不得回退到其它归档或其它仓库。

普通 load 的后续步骤继续按现有 `session-restore.ts` 验证 realpath containment、marker owner 及真实目标。只有这些证明完成后才返回成功的 2xx，不能在读取归档或创建目录后就宣告完成。ignored/可再生输出和 index 状态的限制保持不变：不恢复 staged 与 unstaged 的索引区别。此前失败关闭的状态仍应保留，不能借保留清扫之名变成可删除。

## 设置、SDK、API 与 UI

### 设置

只使用 `worktree.maxRetained` 作为数量设置，缺省 15，`0` 禁用保留清扫。基于现有设置机制增加非负的安全整数校验：负数、小数、非有限值及错误类型均拒绝，不得静默变成 0 或 15。`0` 必须在枚举前生效，不能被 truthiness 检查吞掉。它只禁用自动清扫，不影响经 ownership 校验的显式人工恢复。

保留清扫的实际设置读取路径必须使用现有 `LoadSettingsOptions` 的 `preserveInvalidWorkspaceSettings: true`，或等价的严格错误传播。workspace 配置损坏时，不得把它改写为空对象或缺省配置后再据此授权删除。在根级每轮之间刷新有效设置，并在每轮持有一份校验后的设置快照；热更新从下一轮生效，不反向重新解释已经在执行的删除。其它设置和无关的 daemon UI 继续保持现有降级与兼容行为。

补齐全部现有边界，而不是绕过它们：

- `packages/cli/src/config/config.ts` 与 `packages/core/src/config/config.ts` 的 CLI/core worktree 设置转发；
- `packages/cli/src/config/settings.ts` 已提供的优先级（System Defaults → User → Workspace → System）；
- `WEB_SHELL_SETTINGS` 及其 public settings alias、类型与漂移测试；
- 生成的 VS Code settings schema；
- schema 说明及适用的 Web Shell settings 文案；只有在消费方与恢复界面同时具备后，才能移除「尚未应用」。

`showInDialog`/allowlist 行为必须沿用现有 number-row 模式，不另造数字编辑器。说明必须包含缺省值、active/pinned 保护、`0` 退出自动清扫，以及唯一托管根/ownership 限制，不能承诺跨无关 workspace 的全局 N。

### 会话元数据与恢复 API

通过 `packages/cli/src/serve/server/session-list.ts` 的现有 session-summary/worktree 投影，以及 `packages/sdk-typescript/src/daemon/types.ts` 暴露语义化恢复状态，不暴露本地归档路径，也不向客户端开放任意 archive key。仅在有真实移除/恢复状态时才新增字段；旧记录保持原有形状。不得把缺席字段默认为「可恢复」。

可恢复记录在 `deriveSessionCards` 中继续保留 branch/slug 绑定，不因物理目录或旧 marker 消失而被丢弃。沿用现有 request/workspace scope 模式扩展 `DaemonClient`/`DaemonSessionClient`，并使用当前 helper 编码 session id；补充相应 SDK 方法及兼容性、非法 scope 测试。恢复客户端必须等待服务端最终完成后，才能调用普通 reopen/load 路径。

次级/linked 调用中，浏览器和 SDK 必须从当前 runtime/discovery 上下文获得**选定的、已注册的 owner workspace `cwd`**，不能盲目复用 transcript cwd；后者可能是子 worktree使用中的目录，而非已注册 workspace 根。省略 scope 或替换为未经校验的 scope 必须拒绝，不能回退到 primary。

如果将恢复接口提升为受支持的公开 REST integration surface，必须同步更新全部 `GUIDE_OPERATIONS`、`SDK_METHOD_BY_OPERATION`、`docs/developers/daemon-rest-api.openapi.json`、现有 operation ID/type 及 integration guide 表格，并执行 `rest-integration-docs-contract.test.ts`，不能只更新一层。选择该公开兼容面是明确决定；保留为内部或 capability-gated 的接口，不能宣称扩大了稳定的公开集成契约。`check-contract-version.js` 适用于 **Managed Agent public API contract**，不自动适用于此 daemon REST 文档。

### Web Shell

使用 `SessionOverviewPanel.tsx` 及其现有 busy/error/open 模型和 workspace-scoped 客户端调用。入口放在 Session Overview，不向仅枚举真实 Git worktree 的 `GitWorktreesDialog` 添加不存在的 worktree 行。

- 对有记录的已移除 checkout，展示恢复入口，并区分加载、进行中、不可用和读取失败。
- 打开已移除记录时，不得静默回退到源 checkout。先完成明确的恢复流程，再调用正常 open 路径。
- 自身恢复操作进行中，及其它不兼容生命周期操作进行中时禁用动作，沿用现有 busy/error 行为，不新增 watcher 子系统。
- 失败时显示保守失败原因，不掩盖仍保留的归档或部分恢复目标。
- 不复用 `ManagedSessionWorktrees.tsx` 或另一套 arena/provider API 来表示本地 daemon sidecar 数据。

沿用当前 `sessionsOverview.*`/`gitWorktrees.*` i18n 位置及中英文和其它 locale fallback 约定。测试必须使用携带完整状态的夹具，不能只给一个无快照的 `worktreeRemoved: true`，并证明非法 scope 不会变成可执行动作。

## 拟修改文件分组

| 范围             | 现有可扩展文件；按需增加职责单一的文件                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 快照与 sidecar   | `packages/core/src/services/worktree-snapshot-service.ts`、`worktreeSessionService.ts`、`sessionService.ts`、`session-organization-service.ts`                                               |
| 保护式移除       | `packages/cli/src/serve/server/worktree-orphan-cleanup.ts`，另加职责单一的保留模块及同目录测试                                                                                               |
| 恢复/加载/活动   | `packages/cli/src/serve/routes/session.ts`、`server/session-restore.ts`、`server.ts`、`run-qwen-serve.ts`、runtime-scoped storage/resolution helpers                                         |
| 设置             | `packages/cli/src/config/settingsSchema.ts`、`config.ts`、`settings.ts`、`packages/core/src/config/config.ts`、`packages/cli/src/serve/routes/workspace-settings.ts`、生成的 settings schema |
| 对外/client 投影 | `packages/cli/src/serve/server/session-list.ts`、`packages/sdk-typescript/src/daemon/{types,DaemonClient,DaemonSessionClient}.ts`、必要的 index 导出                                         |
| Web Shell        | `components/SessionOverviewPanel.tsx`、`client/i18n.tsx`、`client/settings/messages.ts`、相关 settings alias/漂移/UI 测试                                                                    |

每个新增可选字段都必须在这几层中存在明确的生产者、校验器、投影和消费者检查。只有没有被读取的可选 flag 不算实现。

## catalog 生命周期的新鲜度

持久化 worktree sidecar 是 `worktreeRemoved.archiveKey` 与 `canRestore` 的权威来源。当 live 摘要仍携带旧的 checkout 状态时，不得让其完整 worktree 对象覆盖较新的移除状态，也不得在成功恢复后把该移除状态复活。其它 live worktree 字段继续保持原有合并行为。PR/artifact 元数据的并发读取去重不得冻结这些生命周期字段：每个 catalog 视图都要验证当前 sidecar，并在适用时验证与其精确绑定的快照对。

## 验收与验证

实现必须满足 `.qwen/e2e-tests/2026-11-21-web-shell-worktree-retention-restore.md` 中场景，至少包括：

1. 真实 Git/tar/文件系统归档覆盖 dirty tracked/untracked 内容、tracked 删除、文件与目录互换、可执行位、链接及可再生输出排除。
2. 保留清扫恰好保留最近 N 个合规 worktree；`0` 禁用；active/pinned 独立保护。非法设置、pin store 状态未知、根冲突及 ownership 未知均保留。
3. 保留清扫后 chat/transcript/sidecar 仍存活；文件系统确认 checkout 已移除；每个接受的移除都有可定位的归档对。普通 archive/unarchive 仍保留已有 checkout 内容与绑定。
4. 恢复按捕获 HEAD 重建托管目标，保留真实 dirty/deleted/mode/link 内容。不得覆盖已有非空目标，也不得强制回退已前进的命名分支。
5. 对象缺失、头部畸形、归档对不完整、恶意归档成员或错误 workspace 均失败关闭，不转移 ownership、不丢弃归档。
6. 移除后 sidecar 写入失败要通过严格 ownership 与有效归档对修复；恢复后、绑定前失败只能通过严格匹配的验证完成，不能盲目重新解档。
7. scheduled activity 防止 shutdown 遗留未完成工作；retention、archive、reset 和 restore 的 ownership 关键区段均串行。
8. 既有响应保持兼容；SDK 方法实际调用正确的 scoped 路由；Session Overview 的真实恢复点击触发实际 HTTP 恢复，并能成功 load。

Linux/Node 26 下完成的隔离运行使用真实的 primary、secondary runtime HOME、存储、Git 仓库与文件系统，模型提供方为 mock，浏览器为真实 Chromium。两个保留目标都通过各自注册的 owner `cwd` 恢复，并验证了内容、删除项、`0755`、detached HEAD、owner marker 与归档。随后一次 primary 移除产生了存储与 owner-scoped preview 一致的新绑定。破坏选中的 tar 后，UI 显示可见错误，实际响应为 `TAR_BAD_ARCHIVE`/500；owner marker 没有重新产生，绑定归档和移除状态均未被覆盖。证据位于 `/tmp/qwen-u45-baseline3-B2sRuw/evidence/`（`report.json`、`ui-done.json`、`overview-after-restore.png`、`restore-failure-visible.png`）。这是该环境下的集成结果，不表示所有 CI 车道或其它平台均已通过。

## 范围外与剩余限制

- P7 自定义根语义，及与之相关的 `worktree.root`、根迁移或 shell-guard 政策调整。
- 删除孤儿归档、TTL、跨 runtime 聚合全局计数、新增分布式锁层，或生产 debug sweep/remove 端点。
- 将孤儿归档恢复到猜测的 workspace、允许任意选择归档目录，或仅因路径缺失就恢复无关的手动 `git worktree remove`。
- 涵盖 Git 对象库、外部进程崩溃、归档/头文件成对写入及任意原始文件系统并发修改的逐字节事务保证。本阶段保证仅限上述 selected-runtime 防护与部分状态修复。
- 为让新功能测试更容易而改变归档 `jobs: 1`、sparse/index 规则、分支 ownership 守卫、已接受的旧 Git 兼容路径或广泛的生命周期约定。
