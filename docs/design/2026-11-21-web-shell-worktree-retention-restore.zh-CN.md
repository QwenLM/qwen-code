# 托管会话 worktree 保留清扫与恢复（P6 U4/U5）

[English](2026-11-21-web-shell-worktree-retention-restore.md) | [简体中文](2026-11-21-web-shell-worktree-retention-restore.zh-CN.md)

- 状态：U4/U5 已在 [PR #18009](https://github.com/QwenLM/qwen-code/pull/18009) 交付到 `main`（squash 提交 `ed5d033e813f90ecb12153ae3307fd035d4b3741`）；U4/U5 验收仍在 [#17237](https://github.com/QwenLM/qwen-code/issues/17237) 跟踪。在该 PR squash 前的 head（`68a4074b60a4a161e94eb8eaa9e7a467f9977653`，不是 `main` 上的提交）上完成的后续验证覆盖保留守卫、快照搬移、恢复围栏以及隔离的 primary＋secondary HTTP/Chromium 恢复。合入提交的 GitHub CI 结果仍另行观察；本文不把它混同为已完成的本地交付事实。后续 P6/P7 仍不在本阶段范围。
- 调查基线：`01b7e92f61b1593517acd1e4afe752d431280e90`。
- 跟踪：[#17237](https://github.com/QwenLM/qwen-code/issues/17237) 中 P6 的 U4/U5，不扩展其它范围。
- 承接：`2026-11-17-worktree-carry-metadata.md` 与 `2026-11-17-worktree-retention-snapshots.md`。
- E2E 计划：`.qwen/e2e-tests/2026-11-21-web-shell-worktree-retention-restore.md`。
- 2026-11-21 进展：core 快照、绑定与 pin store 套件共 167 项通过；受影响 CLI 路由套件共 380 项通过；archive 生命周期共 123 项通过；DaemonClient SDK 579 项通过；SessionOverviewPanel 共 182 项通过。筛选的 lifecycle 用例另有 71 项通过。修复 live/cache 生命周期投影后，扩展的 preview 套件为 10/10，原有 session-list 套件为 64/64。primary＋secondary 的真实 HTTP 与浏览器验证也已完成；这不是根据包测试或更早基线推断的结论。
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

计数按从已验证的来源根及 `getUserWorktreesDir()` 解析出的规范托管根限定，不依据任意路径前缀或仅依据仓库名称。每个归属独立的管理根分别执行保留清扫。

若多个 runtime 声称同一个规范管理根，或其有效设置冲突，则停止该根的自动清扫并输出诊断。workspace 的 ownership 未知、不受信任、runtime 正在 drain，或其根不可读时，同样停止。这里不做跨 runtime 聚合计数，也不回退到 primary runtime。这是已选择的保守边界，不另外发明分布式锁或隐式的配置优先级赢家。

清扫前会针对全部合规 siblings runtime 建立归属图。任何一个 root、环境或 settings 不可读时，自动清扫都会暂停，直到相关归属证据恢复；否则无法排除这个无法验证的 runtime 与其它 runtime 共享候选管理根。各 workspace 的 settings、storage 与上限仍独立适用，但「独立」不意味着在归属图不完整时也能继续删除。这是有意选择的保守暂停，不是借此静默忽略 secondary workspace。

仅符合条件且通过 ownership 校验的记录计入 `N`。活跃及置顶 chat 受到额外保护，且不占用可删除配额：最近 `N` 个合规记录和这些受保护记录均存活。若某会话在当前或候选 runtime base 中的 runtime 状态记录指向另一个进程中的存活 owner（例如在 TUI 中恢复了该会话），则视为活跃并保留；记录存在但本进程无法核验（损坏、不可读、更高 schema 版本、另一 PID 命名空间，或共享 runtime base 的另一主机）时同样保留。包含任何已注册 daemon workspace 的 checkout 同样保留。daemon 创建的会话通常没有 runtime 记录，把缺失也当作活跃会让保留清扫完全失效。保留最新 `N` 个合规记录后，对更旧的合规记录优先清扫。chat 记录及 sidecar 存活，只有合规 checkout 被回收。

最后活动时间采用已有持久化 session/transcript 时间戳；如已有 live 活动时间，取较新的值。若无法读取 session 时间戳但已确认 sidecar 的 ownership，则使用经校验的 sidecar/快照时间戳作为已定义的 fallback。目录 mtime 不是活动时间；不可读或非法时间戳不能静默变成「最旧、最该删除」的候选。

### 2. 保留孤儿归档，不猜测 ownership

没有可验证的存活记录与 sidecar 时，不因数量、龄期或恢复探测而自动删除归档。本阶段不新增 TTL 设置，也不新增自动「孤儿清理」。

同理，孤儿归档不能催生新的 live chat，也不能从文件名猜测仓库。快照头只有捕获元数据，不是完整的 repository/workspace ownership 证明。在失去有效 owner 时的恢复，仍是需要另行决定的政策问题。此决定既不删除归档，也不断言它对人工恢复毫无价值。

### 3. 每次保留清扫移除前都必须捕获快照

保留清扫删除任何合规 checkout 前，都要先捕获该 checkout。即使现有会话删除规则允许对只含原始搬运覆盖层的 checkout 裸回收，也不适用此例外。来源在清扫后仍可能变化，保留的 chat 必须有可用于日后恢复的归档。

其它生命周期路径原有的 U3 裸回收结果保持不变。U3 计算出的 `needsSnapshot`、`worktreeHasWork`、前后内容摘要、隐藏索引位检查、暂停操作检查、搬运来源复核、populated-gitlink 检查和 `checkoutMatchesCapture`，继续作为共享安全逻辑。不可读或快照不能忠实表示的状态一律保留 checkout，不放宽这些不变量。

移除被拒绝或保留时，本轮清扫可能已经生成了一对归档。只有在重新验证 ownership、marker、liveness、runtime 状态、隐藏索引位、暂停 Git 操作、populated-gitlink，以及当前 checkout 的实际内容后，才可以删除**该次尝试所选中的这一对**文件。当前 checkout 完整一致，足以证明这份冗余副本不再需要。捕获期间新 pin 的会话始终保留其 checkout；但在完整 checkout 已经验证后，新的 pin 不要求每轮清扫继续积累相同的、未绑定的归档对。归属不明、状态发生变化或部分/不匹配的 checkout 一律保留这对归档。已有或其它 session/orphan 归档不会被提升归属或被这份有界、同次清理删除；这里没有 TTL 或通用孤儿清扫，也不把多次文件 unlink 宣称为更大范围的原子事务。

### 4. 明确定义移除状态及其归档对键

建议在保持旧字段兼容的前提下，新增以下可选 sidecar 状态：

```text
worktreeRemoved?: { archiveKey: string }
```

`archiveKey` 只能是经过校验的 tar 基本文件名，不得包含目录分量、路径穿越或平台分隔符替换。对应 JSON 头文件使用同基名的 `.json`。稳定的键使 archive/unarchive 可以同步搬移归档对，而不会记录随目录变更而失效的绝对路径。

对符合条件的保留清扫，在真正调用破坏性移除之前，先校验本次选取的归档对，写入并回读仍存活的 sidecar 及其恢复绑定。绑定持久化失败时不得执行移除。因此该绑定既可以表示已完成的移除，也可以表示正在进行的移除；普通 load 不能仅因 checkout 仍存在就自行把该绑定恢复成普通活跃 worktree。快照已创建、HTTP 返回 `removed`，或仅凭 `removeUserWorktree().success`，仍不足以证明物理移除。`branchPreserved`、`keptBranch` 与部分移除的诊断必须继续区分，并决定后续分支策略；`removeUserWorktree` 的未合并提交和 ref ownership 保护不变。

后续拒绝移除或确认未移除时，只有在实际未尝试删除，或 checkout 仍与该快照的字节、tracked 删除项、HEAD/分支及 marker 严格匹配时，才清除本次尝试的恢复绑定。已尝试部分删除或内容不匹配的 checkout 必须同时保留绑定和归档对以供恢复，不能把它当作完整的活跃 checkout，也不能静默丢弃其归档。某个会话活动时间读取失败时仍采取保守暂停，不因此删除其它正常 checkout。

sidecar 的 64 KiB 上限继续有效。既有 `fitSidecarToReadCap` 可以丢弃 `carriedEntries` 来保住绑定，但必须保留移除记录。移除记录畸形时，sidecar 视为损坏，而不是「干净」。严格读取继续沿用现有 `readWorktreeSessionStrict` 契约，不以宽松解析接受新状态。

不得改写 `originalCwd`、`workspaceCwd`、`originalHeadCommit` 与 `worktreeBase` 等创建来源，使后续历史看起来像首次创建。恢复采用捕获时的 `headCommit` 和 `branch`；可变的 `worktreeBranch` 反映重建后的实际 checkout，因此 detached 恢复不会意外获得旧 slug 派生 ref 的 ownership。既有 carry 元数据在仍有效时保留，但恢复不能编造新的搬运豁免。

被接受的捕获结果还必须通过恢复时使用的同一组有界解压与可读性校验。如果生成的归档无法在这些限制下读取，必须在发布给恢复选择器之前失败，不能先删除 checkout 再留下无法使用的恢复对。可读取的大文件仍通过真实解档与逐字节检查验证其恢复能力；没有放宽归档或解压限制。

捕获、比较和归档检查都会拒绝包含 U+FFFD 的 symlink target。文件系统/tar 的字符串桥梁无法区分非法 UTF-8 原始字节与字面替代字符；将其重新编码再称为逐字节恢复会制造错误证明。因此这里采取保守边界，字面 U+FFFD target 也被拒绝。其它合法 UTF-8 symlink target 保持既有行为。

### 5. 归档对必须随 archive/unarchive 搬移，并使失败可见

archive/unarchive 必须让全部归属明确的同名归档对随 transcript 和 sidecar 一起在 `chats/` 与 `chats/archive/` 间移动。配对身份由 `sessionId`、`slug`、基本文件名、头文件对应关系和移除记录共同校验；不能仅凭前缀相同就把文件提升为受信任的归档。对仍有效的现有 checkout 做普通 archive，仍是非破坏性的，也不额外创建快照。

搬移不完整、归档对不可读、目标重复/冲突或 active/archived 位置含义不明时，必须明确失败并保留可恢复产物。不能让读取方静默选用另一个目录中的无关旧副本。读取使用当前已验证 archive 状态对应的归档对。选择器不得跟随目录级或文件级 symlink 逃出所属位置。

缺失或不可读的 legacy sidecar 不构成任何归档对的 ownership 证据或搬移授权：它本身和其它未关联文件均保持不变。在尚无移除绑定时，只允许协调物理 checkout 已移除后的历史窗口：必须通过 runtime ownership、托管坐标校验，并在 active 与 archived 两个目录之间选中一份合法的同 session/slug 归档对。同一目录内存在多代合法归档时，仍沿用既有 selector 选择最新有效配对的规则，不要求全目录只有一对。两侧目录都有有效候选即归属不明，不得提升或覆盖。既有严格有效移除绑定的处理保持不变。若调用方无法确认旧 tombstone 的 owner 是否仍活跃，该 owner 仍然阻止协调。真实 mutation 与 alreadyArchived/alreadyActive 都执行同样的协调。记录 mutation 提交后，归档搬移与定时任务维护分别尝试，前者的失败不得跳过、改写或吞掉后者；两类失败汇总报告，但不得抹去 mutation 已应用的历史。

搬移时，在 `link()` 成功后立即按路径及 `(dev, ino)` 登记本次调用新建的目标链接，再进行随后的身份读取。暂时性 probe 失败因此可在复读成功后使用同一套身份检查回滚；无法继续确认身份时保留残余并报告错误，不能将其当成无归属或既有文件删除。失败时只回滚这些证明属于本次调用的目标：源仍为同一实体时，只删除重复目标别名；源已 unlink 且目标实体仍可确认时，先用不覆盖的 `link()` 恢复源别名，再删除目标别名。实体被替换或目标原先就存在冲突时不得覆盖。回滚错误与原始失败一起汇总报告。这是对这些已知链接的可恢复重放，不承诺任意进程崩溃或两个目录合并的原子性。搬移完成后，必须检查选择器的返回值与两个预期目标路径一致。缺失或不匹配的 pair 都明确表示搬移失败，不能把它作为成功搬移并留下一个指向不完整归档的恢复绑定。

恢复 worktree 的会话在 archive 操作中仍须与恢复协调。沿用既有 archive coordination 与串行化顺序；在没有该协调时，不得于选择或解档期间搬移其快照。

### 6. 目录缺失本身不是恢复许可

必须在通用的 missing-directory 清理之前处理 `worktreeRemoved`，使已识别的移除状态不会被当作陈旧状态删除。下文的物理移除后 sidecar 写入失败，还可以根据严格匹配的历史归档对协调缺失绑定。其它没有合规归档对的旧非 daemon 情形仍保留原行为，除非另行评审；通用 CLI/agent worktree 不被拉入本功能。

具有有效移除绑定的记录不会在 TUI 中显示为活跃 worktree。普通清除先把现有记录移到所属父目录下的私有暂存目录。遇到 retained 记录时，通过不覆盖的 `fs.link` 恢复后再以 `WorktreeRestoreRefusedError` 拒绝；恢复失败时保留暂存文件和/或恢复后的原文件，不丢弃唯一的 owner 指针。重命名后才发布的绑定不属于暂存项，不会被本操作 unlink。目录错误保持既有行为，不宣称任意多进程操作的原子性。durable 版本使用同一保护方式。过滤掉活跃展示后，resume 通过既有 `onWarn` 给出恢复提示。

TUI 还会在 watcher 安装后重新读取，以免第一次读取与 watcher 注册之间写入的绑定一直作为陈旧的 active 指示残留。较早的异步读取也不能覆盖较新的 retained 状态。

物理移除成功、但 sidecar 写入失败，可能留下旧 sidecar 和新归档。只有在以下各项同时成立时才允许识别为可恢复候选：记录属于当前选定的 runtime、ownership 有效、预期位置不再是一个经验证的 live checkout，并且完整归档对确实匹配同一个 session/slug。它可以提供恢复，但不能被描述为一次原子历史移除的证明。快照生成与 sidecar 修改不是原子事务。

只有目录缺失、陈旧的 `.git` 指针、前缀碰巧匹配的任意快照，或一句「not found」错误，都不足以成为证据。既有 load/reset 路径必须区分认可的恢复候选与无法辨认的陈旧状态。仅做只读枚举不能静默改写状态；受认可的写入属于经过所有权控制的 retention 协调或恢复操作。

## 共享捕获/移除执行器

在既有清理实现内做窄提取，不另建第二条删除流水线：

- 保留 `worktree-orphan-cleanup.ts` 中现有检查顺序和条件。
- 提取一个内部执行接缝，返回结构化的 `removed`/`preserved` 结果、快照信息和真实分支/移除结果。
- `executeWorktreeCleanup` 保持为兼容 wrapper，对旧调用方丢弃结果。
- 为保留清扫提供明确的 `requireSnapshot` 选项及可选的保护回调。有绑定回调时，完整防护会在写入绑定前和绑定持久化后各执行一次；每轮先重新读取 scope、pin、live 和 cron 状态，再复核内容摘要、隐藏索引位、搬运来源、gitlink 和精确归档对。pending-Git 检查位于这些读取 Git 的检查之后，是最后一项检查，因此在归档验证后才开始的 bisect 不能因未改变文件字节而漏过。
- 使用所选 runtime 的存储和 bridge，复用既有 checkout 的 `preclassifyWorktreeCleanup`/`verifyWorktreeCleanupOwnership`。不得调用会删除存活 chat 或其附件的会话删除入口。

这里不需要抽象的「清理算法仓库」。只有两个调用点，共享同一条安全关键的执行路径，不能削弱 U3 已验证的条件。

## U4：限定 runtime 的保留清扫编排

在既有 worktree 清理代码旁增加职责单一的 daemon 模块及其同目录测试，不把调度器放进 ACP bridge 的 idle-turn reaper。仅对符合条件的受信任 workspace runtime 启动，并使用现有 scheduled work 的 runtime 生命周期停止。枚举 registry 中每一个 active、受信任、non-internal runtime，而不是仅枚举 primary。动态加入、drain/cancel、移除及 generation 变化也适用同一覆盖范围：closed、blocked、removed、untrusted runtime 均不得接受新的破坏性保留操作。尤其是 scope 缺失时，不能借 `resolveWorkspaceCwd(undefined)` 将 owner 不明的请求回退到 primary。

可接入的位置包括 `server.ts` 中 per-runtime start/stop map 与 `scheduledActivity`、`run-qwen-serve.ts` 的 workspace add/drain 钩子，以及在 ownership 证明或破坏性变更前调用的 `captureRuntimeGenerationAssertion`。确认属于普通非 Git 工作区时，它不存在托管 worktree 根，不应阻断无关仓库的清扫；判断前必须确认 runtime 目录及所有祖先都没有 `.git`，且元数据读取没有失败。如果存在 `.git` 却无法发现 root，或目录不可读，则仍属未知根，受影响根必须暂停，不能把这种 workspace 过滤掉。兄弟 workspace 的设置不可读也须保留为未知证据：它只阻断已证明共享的 management root，不阻断无关仓库，绝不能被转换成缺省配额。仅凭 `.worktree.json` 文件名不能在 active 和 archived 状态之间选择要清理的一份：应使用既有 maintainable-location 分类；如果位置冲突或与正在扫描的 sidecar 不一致，或另一归档状态也存在同 session 的 sidecar，必须保留 checkout，不得按目录顺序选一份删除。清理归属检查会扫描 active 与 archived 两个目录中所有指向同一规范 checkout 的 sidecar，而不只扫描当前会话所在目录。当前文件按完整路径排除，不会因另一归档状态存在同名文件而跳过。任一状态中的非 tombstone 竞争记录或不可读记录都必须使 checkout 保留。直接 reset tombstone 继续沿用已有例外；更旧的 tombstone 仍需既有的 live 证明。

只有受信任的 runtime 才是自动清扫的目标。活跃但不受信任的兄弟 runtime 不由本次调用删除其记录，但也不能从冲突证明中剔除：已证实共享的 management root 仍必须拒绝自动清扫，因为所选 runtime 的 storage 并未检查另一 runtime 所拥有的记录。调度器必须：

1. 读取当前 runtime 的配置，而不是进程级 primary profile；
2. 严格读取该 runtime 自身的 active/archived 会话 sidecar；
3. 仅分类唯一归属的根和合规候选，避免同一根的重复清扫；
4. 按 canonical-path/raw-fallback 键规则取得 `acquireWorktreeOwnershipOp`，并保持既有 ownership-lock → archive-coordinator 顺序；
5. 在破坏性操作前重新校验 ownership、严格 live/pin 状态以及全部 U3 条件；
6. 捕获，校验并原子保存、回读快照绑定，然后移除并确认文件系统结果；
7. 把在途工作纳入停止/drain 等待，不能在 Git 或元数据写入中途强杀任务。

许可在候选之间取消。Git/元数据变更开始后，沿用 `removeUserWorktree` 的完成并保护语义，不得强杀写入方。重启后按上述 ownership 规则恢复，不盲从旧的内存快照继续执行。

workspace 级停止还会把当前在途 promise 交给 runtime-removal disposer。workspace removal 和 trust reconfiguration 必须在 bridge shutdown 前等待它；daemon 全局关闭仍使用独立的聚合 drain 并保留停止错误。既有清理日志和逻辑上的强制移除收敛保持不变，但完成信号不能赶在真实 retention Git/文件系统操作之前发出。

live 判断中，只有明确 not-found 且不在 closing 的会话才算消失；查询能力缺失、查询失败或 closing 状态均按保护处理。启用且绑定会话的 durable 定时任务即使其 bridge 会话尚未重新水化，也受与 keepalive 相同的绑定语义保护。仅从所选 runtime 自己的 cron 存储读取绑定，并在 capture 后、实际移除前复核；capture 期间新启用的任务必须否决删除。disabled 或未绑定 task 不产生保护，其它 runtime 的任务文件不能作为替代。任务文件不可读或损坏是未知状态，必须暂停清扫，不能解释为没有任务。pin 检查增加一个小的 strict getter，复用 `readStoreDocument()`、同一存储和 store-lock 语义，区分真正没有 pin 记录与 store 不可读/损坏。不得改变普通 UI 的 pin 降级展示语义。实际移除提交后再发生 pin 变化时，仍须让归档和保留 chat 可恢复，不可将其表述为移除前就已受保护。本阶段不宣称跨进程分布式 pin 或任务绑定事务。

## U5：确定性的归档选择

在 `worktree-snapshot-service.ts` 中增加小型会话选择器，复用现有头部读取方及 root/package 导出面，不新增归档格式。

对当前已验证归档目录中的每个合规归档对，选择器必须：

- 只枚举精确 session 前缀的快照名与头文件对；
- 当基本文件名违反「不含目录分量」键规则，或显式绑定的 JSON 头指向其它 session/slug 时拒绝；
- 未显式指定 key 时，只考虑 JSON 头与请求 session 和 slug 都匹配的完整归档对；其它 slug 不会被提升为候选，其它 session、不可读元数据或不安全成员仍然拒绝；
- 要求受支持的 schema version 2、完整同基名归档对和完整有效的头部内容，其中 `createdAt` 必须是非负、安全的整数，单位为 epoch milliseconds；
- 要求普通文件及已有 no-symlink/link ownership 输入约束；以及
- 依次比较头部 `createdAt`、归档 `mtimeNs`、完整归档路径的确定性顺序，绝不依赖目录枚举顺序。文件系统的 `mtimeNs` 必须作为 `bigint` 比较，不得转成 `Number`；如需写进 JSON 证据，应序列化为十进制字符串。

竞争头部不可读或畸形、版本未知或目录不可读时，拒绝选择；不能静默回退到一个看似有效的旧归档。无关文件不得被臆造为会话快照。显式绑定的 `archiveKey` 只对对应的精确 pair 做查找和验证；其它文件或归档对既不能阻断这个有效目标，也不能被提升成备选。未显式指定 key 的最新选择会忽略已被完整可读头部证明属于其它 slug 的配对，但不会仅凭前缀转移归属。其它 session、不可读或畸形头部、未知版本、不完整配对及文件系统错误仍按失败关闭处理，不能据此接受一个任意归档。

既有 `checkoutMatchesCapture` 是捕获时结果，而不是写入归档的持久认证。选择不代表归档有签名，也不证明过去的删除一定已提交。它只为后续受保护恢复建立结构、归属绑定和确定性选择。

## U5：受保护的恢复编排

在 `packages/cli/src/serve/routes/session.ts` 的既有 worktree 流程旁增加恢复操作，不把 reset 改造成另一种 ownership 转移功能。路由形状可采用 `POST /session/:id/worktree-restore`，复用 reset 的 runtime resolver/owner-activity 模型。调用方不得提供原始目标目录或任意归档路径；归档选择由服务端拥有并重新校验。

操作顺序如下：

非 primary/linked workspace 的调用方必须显式提供该会话所属 runtime 的已注册 workspace `cwd`，不能因为请求中省略 `cwd` 就采用 resolver 默认给出的 primary。这个要求由真正的恢复操作根据调用方是否实际提供了 owner 范围来校验，不依赖仅对 resolver 结果的 `runtime.primary` 检查。只有确实由 primary 拥有的状态可以使用缺省 primary 规范化。此 `cwd` 必须与 sidecar 注册的 owner、marker 及 live-owner resolution 一致。缺失、非规范、runtime 不符、不受信任、歧义或不匹配的 owner 证据都应拒绝，不得重定向到 primary。既有 primary 缺省规范化行为只保留给确实由 primary 拥有的流程。

1. 通过 `resolveRuntimeForSessionRestore`、`createWorkspaceRuntimeSessionService` 与 stored-id resolver，确定选定 runtime 及真实保存的 session id。具体的 workspace-qualified scope 必须与 sidecar 的 `workspaceCwd` 一致，scope 缺失或不明确时不得回退 primary workspace。
2. 严格读取 worktree 记录，校验当前 runtime 的 root/source/slug containment。为缺失 checkout 提供所有权解析的变体：所属管理根下的目标缺失，不应套用现有 reset 的 `realpathSync` 规则而直接失败，也绝不能把请求转到 primary workspace。
3. 按既定顺序取得 worktree ownership lock 与 archive coordination。在同一 coordination 下发现 archived 记录时，必须要求用户先显式 unarchive，再允许重试；不得先重建 checkout、解档或清除 removal binding，再让普通 load 因 archived 失败。锁内重读 sidecar，区分认可的恢复候选与陈旧状态，再确认其类别未发生变化。创建缺失目标前，严格检查所选 runtime 自有 storage 中 active 与 archived sidecar。允许直接指向本会话的 reset tombstone；其它 tombstone 必须确认其旧 owner 确实不活跃。非 tombstone 的竞争记录或不可读记录必须阻止重建，不得因为目录缺失就制造一个新的唯一 owner。
4. 选择最新的有效归档对。要求 `headCommit` 是仓库实际对象格式对应的完整十六进制对象 id（SHA-1 为 40 位，SHA-256 为 64 位），不得为空、形似选项，或仅以 ref fallback 代替。再确认该精确 commit object 存在于**同一来源仓库**。对象缺失时，在创建或解档任何内容之前失败；归档不含 Git object database，也不承诺通过 remote fetch 恢复。
5. 对捕获时记录的命名分支，仅当目标 ref 仍解析到捕获 head，且不是不安全/越界引用时，才附着该分支。ref 缺失、已前进或含义不明时，改为在 `headCommit` 上 detached 恢复，报告命名 ref 未被修改，并将当前分支字段更新为真实值。`createUserWorktree(..., { detached: true })` 是不重写 ref 的路径；绝不能以 reset/rebase 强制把用户分支退到旧位置。
6. 要求目标 fresh 且归属明确。只调用 `mkdir` 或 restore 并不是完整重建：必须使用 `createUserWorktree` 和 `getUserWorktreePath`，保持 checkout、Git 管理登记与托管根一致。已有、意外非空或外部目录一律拒绝，不得清空或覆盖。
7. 使用所选头部调用 `restoreWorktreeSnapshot`，随后通过 `createWorktreeSessionMarkerExclusive` 为实际 stored session id 创建 marker。`.git` 和 marker 不属于快照内容。
8. 将恢复内容与所选归档比较：原始字节、属主可执行位、真实链接目标、记录的删除、期望 commit，以及不安全或非常规的迟到条目，再校验按上述分支决策产生的当前分支状态（有意 detached 时为空）。不能仅因合法的 detached 回退与捕获时分支名不同，就拒绝这次恢复。复用 snapshot 区域已有的比较职责，不以文件是否存在作为弱校验。必要时，在解档后及最终 sidecar 修改前分别比较。ignored 的可再生输出继续遵循 U1 的排除契约。对于被强制加入且被 ignore 规则覆盖的文件，归档成员资格优先：重建 checkout 的索引后它可能再次表现为 ignored，但校验仍须比对归档中的字节并发现迟到改动，不能把它从当前文件集合中漏掉。目录成员几何也参与比较，包括空目录：已捕获的空目录被删除，或 capture 后出现空目录，都会破坏完整性证明。既有 disposable ignored 输出的排除规则保持不变。目录不得被当成普通文件的硬链接目标。
9. 原子更新存活 sidecar，清除移除状态，并写入当前真实分支、路径与 carry identity；再次确认 marker 与 checkout 仍然有效。只有此时才允许普通 `restoreSessionCore` 迁移/打开该会话的 checkout，并向客户端提供已恢复状态。

归档中名称以 `/` 结尾的 symlink 或 hardlink 并不是目录。目录身份来自成员类型及真实祖先目录；文件和链接在比较逻辑身份时去掉这种后缀。两个成员若会隐藏同一个逻辑路径，包括用目录别名隐藏链接，都会破坏比较结果。真正的 `Directory` 成员与匹配的空目录仍然有效。只按路径后缀比较会把损坏归档中的错误对象误认证为完整。

完成两次内容比较和 runtime generation 校验后，再次确认 marker 归属，才写入普通 active sidecar。marker 被移走、缺失、属于其它 owner 或不可读时，不得清除恢复绑定，目标目录及所选归档对继续保留。不能因为文件字节匹配就把 checkout 认证为完整。

worktree ownership lease 在 archive exclusive 结束后延续到 ordinary load。必须先结束 archive exclusive，再让 ordinary load 进入 archive shared coordination。ordinary load 验证 handoff key 与当前 sidecar 的 checkout 一致，再执行正常的 bridge 注册。这样，在已恢复但尚未注册为 live 的交接期间，保留清扫无法取得该 worktree 的 ownership lock，也不能撤销刚刚完成的注册。handoff 仅是进程内部交接，不通过 HTTP 字段绕过保护，也不伪造 pin；幂等的 finally 在完成、异常、取消或 bridge 失败时释放它。

重建 HEAD 还可能把已删除 tracked 文件的父目录带回来。在文件与链接恢复后，按最长后代优先检查删除链：只删除“归档中不存在且当前为空”的父目录。归档中显式捕获的空目录、仍含其它内容的父目录和非目录条目必须保留。清理期间若出现新内容，目录移除必须失败，不能强删其中的内容。

### 失败与重试行为

不承诺 Git 与文件系统的全域原子事务。失败时保留归档及既有工作，返回明确失败状态，不得声称成功。若解档或 marker 创建失败，或 runtime generation 在创建 marker 前关闭，而目标恰由本次恢复调用新建，错误收尾时必须经严格 reader 确认 marker 仍缺失，才允许清理这个本次新建目标并 prune 其 Git 登记。已提交或属于其它 session 的 marker，以及 invalid 或不可读的 marker，均必须保留整个目标，不能递归删除。真正始终无 marker 的新目标仍可按界限清理，从而让下一次重试可以从干净状态开始；这不等于允许清除既有或部分恢复目录。归档和移除绑定继续保留，修复归档后允许重新重建并完成会话绑定。原始解档失败仍须与清理失败区分，不能被误报成 marker 错误。

- 归档畸形、恶意成员、commit 缺失、目标异常或 marker 失败会阻止继续恢复，并保留既有或用户拥有的文件；只有本次调用新建的失败目标才按上述约定清理。
- 解档/marker 创建后、sidecar 翻转前失败时，保留保守的移除记录。后续重试只有在 owned marker、目标位置及内容都证明与所选归档匹配时，才可作为绑定收尾；否则拒绝，不能在该目录上盲目重新解档。
- 迟到的用户改动、损坏或部分快照、未知额外文件及目标漂移，不能为了得到看似成功的结果而被清除。归档与明确失败原因必须保留。
- 归档元数据非法、来源不可读或竞争头部不可读时，不得回退到其它归档或其它仓库。

普通 load 的后续步骤继续按现有 `session-restore.ts` 验证 realpath containment、marker owner 及真实目标。只有这些证明完成后才返回成功的 2xx，不能在读取归档或创建目录后就宣告完成。在 ownership lock 下严格读取到 `worktreeRemoved` 时，普通 load/resume 必须在 bridge restore 前返回类型化 409（`worktree_restore_unavailable`），并指向 `/session/:id/worktree-restore`；没有同 session/slug 合规归档对的旧式 checkout 缺失仍沿用既有校验和错误边界。严格匹配的历史候选只提供显式恢复，不授权普通 load 重新打开已经缺失的目录；retention 可以在所有权检查后单独写回缺失的绑定。ignored/可再生输出和 index 状态的限制保持不变：不恢复 staged 与 unstaged 的索引区别。此前失败关闭的状态仍应保留，不能借保留清扫之名变成可删除。

## 设置、SDK、API 与 UI

### 设置

只使用 `worktree.maxRetained` 作为数量设置，缺省 15，`0` 禁用保留清扫。基于现有设置机制增加非负的安全整数校验：负数、小数、非有限值及错误类型均拒绝，不得静默变成 0 或 15。`0` 必须在枚举前生效，不能被 truthiness 检查吞掉。它只禁用自动清扫，不影响经 ownership 校验的显式人工恢复。

保留清扫的实际设置读取路径必须使用现有 `LoadSettingsOptions` 的 `preserveInvalidWorkspaceSettings: true`，或等价的严格错误传播。workspace 配置损坏时，不得把它改写为空对象或缺省配置后再据此授权删除。在根级每轮之间刷新有效设置，并在每轮持有一份校验后的设置快照；热更新从下一轮生效，不反向重新解释已经在执行的删除。其它设置和无关的 daemon UI 继续保持现有降级与兼容行为。

补齐全部现有边界，而不是绕过它们：

- 不把保留配额转发进静态的 worktree 创建 Config：配额由受限 runtime 的严格设置读取方负责，core 的 worktree 创建设置仅保留既有 symlink-directory 选项；
- `packages/cli/src/config/settings.ts` 已提供的优先级（System Defaults → User → Workspace → System）；
- `WEB_SHELL_SETTINGS` 及其 public settings alias、类型与漂移测试；
- 生成的 VS Code settings schema；
- schema 说明及适用的 Web Shell settings 文案；只有在消费方与恢复界面同时具备后，才能移除「尚未应用」。

`showInDialog`/allowlist 行为必须沿用现有 number-row 模式，不另造数字编辑器。说明必须包含缺省值、active/pinned 保护、`0` 退出自动清扫，以及唯一托管根/ownership 限制，不能承诺跨无关 workspace 的全局 N。

### 会话元数据与恢复 API

通过 `packages/cli/src/serve/server/session-list.ts` 的现有 session-summary/worktree 投影，以及 `packages/sdk-typescript/src/daemon/types.ts` 暴露语义化恢复状态，不暴露本地归档路径，也不向客户端开放任意 archive key。仅在有真实移除/恢复状态时才新增字段；旧记录保持原有形状。不得把缺席字段默认为「可恢复」。

可恢复记录在 `deriveSessionCards` 中继续保留 branch/slug 绑定，不因物理目录或旧 marker 消失而被丢弃。沿用现有 request/workspace scope 模式扩展 `DaemonClient`/`DaemonSessionClient`，并使用当前 helper 编码 session id；补充相应 SDK 方法及兼容性、非法 scope 测试。恢复客户端必须等待服务端最终完成后，才能调用普通 reopen/load 路径。`RestoreWorktreeSessionRequest` 同时从 TypeScript SDK 根入口和 daemon 子入口导出。总览通过现有 action 层及 `DaemonSessionClient.restoreWorktree` 获得包含 replay、epoch、history flags、artifacts 和 owner context 的已水合 client，再把同一 client 经 `PendingSessionLoad` 交给 provider。provider 直接消费这个 client，而不是再次发出 `/session/load`，使服务端注册保持在同一个生命周期内，并保留初始 replay 语义。被取代、超时及未接管时卸载的恢复操作，仅解绑尚待接管的 client。接管之后沿用既有 replay 与清理规则，不制造第二个注册，也不减少其它活跃 attach 引用。

次级/linked 调用中，浏览器和 SDK 必须从当前 runtime/discovery 上下文获得**选定的、已注册的 owner workspace `cwd`**，不能盲目复用 transcript cwd；后者可能是子 worktree使用中的目录，而非已注册 workspace 根。省略 scope 或替换为未经校验的 scope 必须拒绝，不能回退到 primary。

如果将恢复接口提升为受支持的公开 REST integration surface，必须同步更新全部 `GUIDE_OPERATIONS`、`SDK_METHOD_BY_OPERATION`、`docs/developers/daemon-rest-api.openapi.json`、现有 operation ID/type 及 integration guide 表格，并执行 `rest-integration-docs-contract.test.ts`，不能只更新一层。选择该公开兼容面是明确决定；保留为内部或 capability-gated 的接口，不能宣称扩大了稳定的公开集成契约。`check-contract-version.js` 适用于 **Managed Agent public API contract**，不自动适用于此 daemon REST 文档。

### Web Shell

使用 `SessionOverviewPanel.tsx` 及其现有 busy/error/open 模型和 workspace-scoped 客户端调用。入口放在 Session Overview，不向仅枚举真实 Git worktree 的 `GitWorktreesDialog` 添加不存在的 worktree 行。

- 对具有有效记录的已移除 checkout，展示恢复入口，并区分加载、进行中、不可用和读取失败。
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

持久化 worktree sidecar 与其同 session/slug 的精确归档对共同作为 `worktreeRemoved.archiveKey` 与 `canRestore` 的权威依据。只有 ownership 和坐标校验通过后，才能从历史归档对协调缺失绑定；任意缺失的 legacy 记录不会因此变得可恢复。当 live 摘要仍携带旧的 checkout 状态时，不得让其完整 worktree 对象覆盖较新的移除状态，也不得在成功恢复后把该移除状态复活。其它 live worktree 字段继续保持原有合并行为。PR/artifact 元数据的并发读取去重不得冻结这些生命周期字段：每个 catalog 视图都要验证当前 sidecar，并在适用时验证与其精确绑定的快照对。预览统一使用恢复操作的 ownership、originalCwd 及 supersession 分类，而不是只信任 `workspaceCwd`。无法确证的重新读取不得把移除绑定变成普通活跃 checkout，也不能确认可恢复性：可以保留已有的移除信息，但在当前记录重新有效之前必须令 `canRestore` 为 `false`。

预览必须区分真正缺失与损坏。同一次带 identity 校验的宽限读取通过 `onInvalid` 标记存在但不可用的 sidecar：此时保留已有移除绑定，但令 `canRestore=false`；真正 `ENOENT` 的记录继续沿用原有缺失状态行为。其它读取失败也不能授权把 checkout 当作普通活跃目录重新打开。每次 enrichment 调用在有合规候选时，对所选 runtime 的根及 Git 来源根至多做一次归属验证和共享，不再为每个保留行单独 spawn Git。静默预览只抑制删除动作的 advisory 日志，不省略 workspace、来源与 supersession 检查。预览只是 availability hint：真正的恢复路由仍重新校验 ownership、管理根和精确归档对。

## 验收与验证

实现必须满足 `.qwen/e2e-tests/2026-11-21-web-shell-worktree-retention-restore.md` 中场景，至少包括：

1. 真实 Git/tar/文件系统归档覆盖 dirty tracked/untracked 内容、tracked 删除、文件与目录互换、可执行位、链接及可再生输出排除。
2. 保留清扫恰好保留最近 N 个合规 worktree；`0` 禁用；active/pinned 独立保护。非法设置、pin store 状态未知、根冲突及 ownership 未知均保留。
3. 保留清扫后 chat/transcript/sidecar 仍存活；文件系统确认 checkout 已移除；每个接受的移除都有可定位的归档对。普通 archive/unarchive 仍保留已有 checkout 内容与绑定。
4. 恢复按捕获 HEAD 重建托管目标，保留真实 dirty/deleted/mode/link 内容。不得覆盖已有非空目标，也不得强制回退已前进的命名分支。
5. 对象缺失、头部畸形、归档对不完整、恶意归档成员或陈旧、错误的 workspace 均失败关闭，不转移 ownership、不丢弃归档。
6. 移除后 sidecar 写入失败要通过严格 ownership 与有效归档对修复；恢复后、绑定前失败只能通过严格匹配的验证完成，不能盲目重新解档。
7. scheduled activity 防止 shutdown 遗留未完成工作；retention、archive、reset 和 restore 的 ownership 关键区段均串行。
8. 既有响应保持兼容；SDK 方法实际调用正确的 scoped 路由；Session Overview 的真实恢复点击触发实际 HTTP 恢复，并能成功 load。

Linux/Node 26 下完成的隔离运行使用真实的 primary、secondary runtime HOME、存储、Git 仓库与文件系统，模型提供方为 mock，浏览器为真实 Chromium。两个保留目标都通过各自注册的 owner `cwd` 恢复，并验证了内容、删除项、`0755`、detached HEAD、owner marker 与归档。随后一次 primary 移除产生了存储与 owner-scoped preview 一致的新绑定。破坏选中的 tar 后，UI 显示可见错误，实际响应为 `TAR_BAD_ARCHIVE`/500；owner marker 没有重新产生，绑定归档和移除状态均未被覆盖。证据位于 `/tmp/qwen-u45-baseline3-B2sRuw/evidence/`（`report.json`、`ui-done.json`、`overview-after-restore.png`、`restore-failure-visible.png`）。这是该环境下的集成结果，不表示所有 CI 车道或其它平台均已通过。

## 范围外与剩余限制

- P7 自定义根语义，及与之相关的 `worktree.root`、根迁移或 shell-guard 政策调整。
- 删除孤儿归档、TTL、跨 runtime 聚合全局计数、新增分布式锁层，或生产 debug sweep/remove 端点。
- 将孤儿归档恢复到猜测的 workspace、允许任意选择归档目录，或仅因路径缺失就恢复无关的手动 `git worktree remove`。
- 涵盖 Git 对象库、外部进程崩溃、归档/头文件成对写入及任意原始文件系统并发修改的逐字节事务保证。本阶段保证仅限上述 selected-runtime 防护与部分状态修复。
- 检测没有写 runtime 状态记录、却仍持有 checkout 的存活子进程（例如 daemon 被强杀后遗留的 ACP 子进程）；清扫只能看到跨进程 liveness oracle 可发现的 owner。
- 为让新功能测试更容易而改变归档 `jobs: 1`、sparse/index 规则、分支 ownership 守卫、已接受的旧 Git 兼容路径或广泛的生命周期约定。
