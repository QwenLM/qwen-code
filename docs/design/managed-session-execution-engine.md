# daemon 会话执行引擎选择与持久化

## 目标与当前缺口

本项完整范围见[默认替换总方案](managed-agent-daemon-default.md)，优先级遵循[首阶段计划](../plans/2026-09-09-managed-daemon-default.md)。用户要求先完成[Session / Harness / Runtime 全局设计](managed-agent-session-harness-runtime.md)；后续先实现 Session 独立权威、完整 Harness 接入与持久恢复，再完成本文件尚未接通的四处普通 factory。固定引擎和共享 Bridge 成果保留，完整媒体展示、Skills、后台任务和历史迁移延期实施，详细设计已在文末全量专项中补齐。

本文件已验收的物理 writer 当前位于 ACP host，未来移交 Session 服务是单独的 R2.S2 切片，须排空、封存、校验再接管，不能把现有 writer 保护描述为已经完成三层拆分。下文第 3 片仍定义配置和路由的局部顺序，不覆盖新增 R2.S1～R2.S3 的全局前置。

历史调查基线 `bbeaf24bdb` 的 Bridge 只有一个可复用 channel，创建来源在取得 channel 后才传入，不能仅替换 factory 保留旧会话和 Channel 路径。2026-09-10 复核 `a836081466`：配对 Bridge 已实现双通道；普通三处 workspace factory 加直接嵌入入口，共四处，仍使用原启动路径，尚未配置共同 selector 和 executionEngines。

当前 `sourceType` 表示创建来源；`managed-gateway` 专用于禁止 Prompt 的 Tool-only Session；工作区 `runtime-owner.json` 表示进程所有权；writer lease 表示写入资格。这些字段都不能兼作会话执行引擎。普通 Prompt 和 Cancel 已使用 SessionEntry 的 connection，可以复用其队列和事件契约。

2026-09-09 已实现并验收下表第 1、2 片：持久 owner、严格恢复证明、初始化保护、实际 ACP 回执，以及同一 Bridge 的双通道和归属绑定。有效配置兼容选择及普通默认入口切换仍待实现。

## 第 1 片实现与验收

完整物理 transcript 在过滤、UUID 合并和历史分支选择之前累计执行归属，full load、严格 owner 预读和 selective projection 保留同一文件快照证明。完整旧历史解释为 legacy，损坏、非法或冲突归属不能用于执行恢复；可读历史仍供只读展示。当前 Managed fork 明确拒绝，legacy fork 保留源的物理 owner。

Config 构造、CLI 配置加载和运行中 resume 在改变旧会话前检查归属。真实 ACP 创建/恢复在 writer lease 内重读权威历史，严格写入或验证 owner，然后才进入会话执行初始化；预加载 projection 的 Goal 迁移也延后到此处。预读后历史追加、改属或删除均拒绝，失败自动释放 writer。Managed host 实际开启 lease，用户关闭录制时明确拒绝；ACP new/load/resume 返回实际 Config 的引擎，第 2 片在配对 Bridge 中使用该回执核验归属。

macOS 隔离真实进程验收共 7 组通过：显式 lease 新建、默认设置新建、同引擎冷恢复、leased legacy ACP 拒绝接管、nonleased ACP 拒绝接管、原生 bundle CLI 拒绝接管、Managed 关闭录制拒绝。创建回执交给 Bridge 前已存在唯一 managed owner；正向路径经过真实 Runtime Read 和模型 HTTP。三种拒绝恢复没有新增模型请求、标记文件读取或 JSONL 写入，源与副本历史字节保持不变。所有测试自有进程、14 个端口、7 个目录和锁正常清理；4170 预览及用户数据未用作夹具。

build、typecheck、bundle、相关 core/CLI 定向测试与审查已通过；单测另覆盖冲突/非法物理记录、读取快照变化、严格写失败、projection 变化及 UI 切换前拒绝。7 组 E2E 不包含这些全部故障的真实进程复现，也不证明完整 Hooks、fork/rewind 或默认替换完成。测试使用可控 localhost 模型响应，工具和持久化走真实实现。运行期间冻结源码与构建，115 项定向源码/包 dist/入口指纹一致；分块 bundle 另有测试后摘要，不能将它称为全部分块的测试前后指纹证明。原始验收与边界记录在本地 `.qwen/issues/managed-session-engine-verification.md`。

## 第 2 片实现与验收

同一个 Bridge 现可按服务端选择使用 legacy 或 Managed 通道，共享会话、ID 和资源准入；通过实际 ACP 引擎回执核验后绑定 Session。后续发送、取消、通知和关闭均校验实际通道，冷恢复按持久 owner 选择。工作区控制仍归 legacy，未启用配对配置的旧调用者保持原行为。

build、typecheck、bundle、相关 lint 与六个 ACP Bridge 测试文件的 885 项测试通过。独立审查发现的不可寻址成功回执早释放、branch 超时后 host admission 早释放均已复现并修复，修订后审查未发现新增阻塞问题。定向测试覆盖选择期间的 ID/限额占用、错误回执清理、跨通道事件归属与关闭账本。

macOS 两组隔离真实 host 验收通过：同一工作区两种引擎共存、双向模型流取消、普通关闭后实际通道退出并冷恢复，以及仍有活会话时 host shutdown 的 writer 交接。合计 10 次原生 Read/final、22 次 localhost 模型 HTTP 和 2 次取消；Managed 的原生读取在独立 Tool Runtime 内执行，Gateway 负责模型调用。主任务另行回读了持久 owner、完整 transcript、实际 wire/generation、取消 ACK 和物理退出证据。

两组测试自有进程、端口和目录全部清理，无兜底终止信号。普通关闭后没有 writer lock；交接关闭留下的两份 sealed 凭据均与实际 transcript 字节数和 SHA 匹配，不将锁路径存在误判为泄漏。源码/产物/夹具的 1137 项定向指纹前后一致，包括根 dist 中全部 482 个 chunks；该清单不等于全 node_modules 依赖闭包。首次 fixed 运行因夹具只匹配 `session/cancel` 而失败，产品实际已通过 `craft/cancelPendingPrompt` 完成取消；保留原始失败，校准观察断言后两组通过，期间未改生产代码。

本片使用实际配对 host test-script，尚未覆盖普通 daemon 默认入口、所有配置兼容组合、容量压力、权限对话或取消扩展 fallback。普通四处 factory 还未接线，不能将双通道验收等同默认替换完成。原始证据及范围见本地 `.qwen/issues/managed-engine-dual-channel-verification.md`，主任务独立回读摘要在 `.qwen/e2e-tests/managed-engine-dual-channel-root-audit.json`。4170 预览与用户数据未作为夹具。

## 第 3 片的配置读取基础

新增严格 settings 读取，复用原有四层合并、环境变量替换、trust 和版本迁移规则；迁移只在内存完成，损坏 JSON 不备份或重置文件。Managed channel、实际 host bootstrap 与后续 new/load/resume 都使用这个入口。项目 MCP 合并在实际 Managed Config 构造前拒绝读取或解析错误，避免把不完整配置当成空集合。普通 legacy settings 保留既有恢复语义，MCP 的 legacy 合并仍警告并保留有效条目。

settings 与项目 MCP 共用严格文件读取：只有确认路径缺失才返回缺省；非普通文件、悬空文件或祖先目录软链接、读取失败和读取期间检测到的变化均报错。非普通文件在读取前拒绝，JSON 错误不包含配置内容。独立审查发现的祖先软链接误判已通过真实 loader 基线复现并修复。

build、typecheck、bundle、相关 lint、自审和独立复审通过。最终读取及调用链的八个测试文件共 659 项通过，ACP 的 604 项回归也通过。macOS 最终产物验证包含五种 settings 输入、四种悬空路径，以及实际 Managed host 的四次启动拒绝和同一活 host 的十二次 new/load/resume 拒绝；拒绝前后配置和历史原字节不变，没有新增模型请求或工具执行。修复测试配置后，原 managed owner 保持，load 后再次完成真实 Runtime Read 和持久 final；两轮 Read 共四次模型 HTTP。

三组自有进程、端口、writer 锁和目录均完成清理；1168 项定向源码/产物/夹具指纹包含全部 482 个根 bundle chunks，悬空路径组另含自己的脚本，不代表完整外部依赖闭包。主任务重新核对原始配置、ACP 请求/错误回执、工具输出和持久历史；实际 RPC 错误保留输入路径于 data.details，普通 Web Shell 的错误展示仍待普通入口验收。原始证据见本地 `.qwen/issues/managed-engine-strict-config-verification.md`，4170 与用户数据未用作夹具。

这是每次配置读取的基础保护，尚不构成 selector 与执行端共享的跨来源原子快照。全局 settings 文件位置仍沿用现有 Storage/system path getter，显式 runtimeEnvironment 绑定变量替换；不同 QWEN_HOME/system path 的来源隔离还需随实际 Config/extension 输入一起处理。返回的 LoadedSettings 也仍保留管理写方法，不能将其称为不可变对象。extension 状态、动态 MCP/Hooks、共同兼容策略和四处普通 factory 接线继续按下述第 3 片设计实施。

## 不变量

1. 同一 Session ID 的执行引擎不可变。创建、冷恢复决定连接，后续发送、取消、审批、模型设置和关闭沿既有连接执行。
2. 新建仅在用途和有效配置明确兼容时选择 Managed。Channel、延期能力依赖和兼容性未知选择 legacy。已有 Managed 恢复遇到不兼容配置应失败，不能改选 legacy。
3. Managed 失败后不调用 legacy factory 重试。响应丢失、初始化超时或关闭未收敛，不代表工具未执行或原所有者已退出。
4. 旧会话必须有完整可读的无引擎记录证据才能解释为 legacy。未知版本、非法值、冲突、读取失败不能被默认值掩盖。
5. 面向客户端仍使用普通 Session、Prompt ACK、事件和 transcript。完整 Managed Agent 不冒用 Tool-only 的来源或独立实验会话协议。
6. 保留同一 Bridge 的 Session 总量、ID reservation、事件和 workspace owner index；引入两个执行通道不能翻倍既有会话限额或进程预算。

## 持久化与恢复

在普通 transcript 中新增不可变 system 记录 `session_execution_engine`，payload 为版本 1 和 `legacy` / `managed` 枚举。Session ID、cwd 和项目存储域由 transcript envelope 与 SessionService 验证，不保存进程 ID、模型凭据或整个配置。相同记录可以幂等；不同值不能 last-wins。引擎属于整个会话，不能在压缩或选择另一条历史分支时消失。

SessionService 提供严格读取。读取应覆盖所有物理引擎记录，而不是只查尾部或当前有效模型分支；区分不存在的会话、完整旧会话、有效所有者和不可判定状态。历史展示仍允许原有容错读取；执行恢复不能用容错读取中的字段缺失推断 legacy。应复用现有文件快照、JSONL 完整性和项目归属能力，避免另造第二份 owner 文件。

创建与恢复按以下顺序执行：

1. 保留既有 workspace/generation、Session ID reservation、来源及数量准入。CLI 的 Bridge 回调根据真实用途、配置或严格历史预读选择引擎。
2. 取得该引擎的 channel。expected engine 来自服务端实际 host 配置，不接受外部 `_meta` 授权；响应中返回实际引擎，Bridge 核对后绑定 entry。
3. 新建 Managed 必须启用持久记录与 writer lease。获取 lease 后重新读取权威历史，核验预读选择；新建严格落盘 owner 后才能进入会话初始化的 Hooks、MCP、模型及工具副作用。写失败沿已有清理流程拒绝发布 Session，不能像来源记录一样返回 `persisted:false` 后继续。
4. 恢复前的配置加载也必须检查 owner。当前 nonleased recorder 在构造时就可写，且 Goal 恢复可能早于 `Config.initialize`；因此只在 `activateChatRecording` 的 leased 分支校验不够。`loadCliConfig` 的 resume/continue/fork 以及运行中切换入口必须保留引擎证明或拒绝不支持的接管，不能让原生 CLI 或非 leased ACP 绕过保护。
5. writer lease 内的第二次检查防止预读到取得 lease 之间历史变化。完整恢复与 selective projection 都携带相同 owner；不能以 recent replay 没有 owner 为依据改选。

实现读取时，在 `SessionTranscriptReader` 的物理行解析阶段累计完整性和引擎记录，早于结构过滤、UUID 去重和活跃分支筛选。复用 JSONL 已有完整性解析器及文件快照前后校验；解析器能完整恢复的拼接对象可接受，部分恢复不能证明没有 owner。只读索引保留错误诊断，执行加载显式要求有效证明；证明绑定同一个 Session 和文件快照，不能把另一轮读取的 owner 拼接到较旧的恢复数据。

Managed 的 writer lease 是必要条件，但 `experimentalZedIntegration` 和实际录制状态也影响它是否生效。验收要检查最终 Config 和 ACP host 冻结的协议值。用户关闭录制时，创建选择应保留 legacy，直接 Managed 创建则明确拒绝，不能静默打开录制；恢复已记录 Managed 时不能借关闭录制绕过归属检查。真正的只读 replay 由内部调用用途明确指定，不能用用户配置推断。

保持只读 transcript/list 可用。完整 Managed fork/rewind 等迁移尚未验收时，执行入口准确拒绝，不能复制出一个无 owner 的 Session 再交给 legacy。`SessionService.forkSession` 在截取历史和选择分支前检查源的完整物理 owner；当前拒绝 Managed 源，legacy 源的新记录由归属证明生成，不能从被截取的消息猜测。archive/unarchive 的既有物理移动应保留记录并做回归。

## 同一 Bridge 的两种通道

保留原 spawn factory 为 legacy，另提供 Managed factory。只把可复用 channel、在途创建和对应 idle 状态按引擎分槽；继续使用一个 `byId`、一个总量 admission 和 `aliveChannels`。同一种引擎并发创建合并，不同引擎独立创建。dying、初始化失败、晚到响应和 shutdown 仍须等实际所属资源退出，不能因新槽可用而遗忘旧通道。

第二片已实现显式配对配置 `executionEngines`，包含 `legacy`、`managed` 两个 factory 与服务端 `select` 回调；与旧 `channelFactory` 同时传入时拒绝歧义。未启用配对配置的调用者保留通用单通道语义：旧注入接口也用于 Managed host，不能自动把它记为已核实 legacy。配对模式严格要求实际 new/load/resume 引擎回执。普通 daemon 工厂尚未传入此配置；本片的真实验证使用同一工作区、同一配对 Bridge 和真实双引擎工厂。

选择回调接收经校验和快照化的既有 spawn 或 load/resume 请求及内部确认的 standalone 用途，保留 canonical workspace、来源、父会话、worktree/branch、模型与权限信息。同步总量和 ID 占用后，先登记在途操作，再异步选择，避免选择期间穿过限额或被 shutdown 遗漏。热 attach/恢复继续已有 entry；后续兼容判定还须在 attach 副作用前拒绝不支持的用途，不能只保护新建。某引擎的 quarantine 只阻断其自身新会话，全局进程与会话预算继续生效。

channel slot 保存 factory、可复用 channel、在途创建和启动清理失败；idle timer 属于实际 ChannelInfo，旧 generation 的晚到清理不能取消新 generation 或另一引擎的 timer。工作区控制和 preheat 显式使用 legacy 控制通道；整体 channelLive 表示任一可用通道，legacy 子进程 RSS 仍按物理进程计数。关闭汇总所有槽与 aliveChannels，不能只等最后创建的通道。

收到成功 ACP 响应但引擎回执缺失、非法或不匹配时，实际 Session 可能已经存在。必须复用原通道的未注册会话 close/drain/quarantine 路径，保留 ID 和总量占用直至确认释放；不能直接抛错后遗忘资源。branch 恢复失败清理也必须持有实际恢复通道。退出、权限和通知路由除 Session ID 外还校验 channel identity；pending replay 和生成事件分别核对已绑定的 restore channel 与 request connection。

配对新建还拒绝空或不可寻址的成功回执、错误的指定 ID、已注册 ID 以及被其他在途操作占用的 ID。若无法安全按 ID 关闭（没有可寻址 ID，或可能碰到同通道上的另一个会话），隔离实际响应通道，等待已有工作排空及物理退出，保留总量与 ID 占用；不能覆盖原 entry 或关闭另一引擎的同名会话。回执错误但严格关闭成功的空通道恢复原有 idle 策略。

分支先为新会话占用 host admission，仅在进入冷恢复后把 reservation 移交给 restore。选择失败、初始化失败、错误回执和恢复超时均由同一恢复生命周期收尾；公开超时响应不释放仍在执行的恢复名额，必须等严格 close 或物理退出。进入冷恢复前的校验失败或热 attach 仍由分支外层释放，避免重复释放或遗漏。

| 操作                                  | 分派依据                                                            |
| ------------------------------------- | ------------------------------------------------------------------- |
| 普通新建、手动内部新建                | 服务端用途和有效配置，只选一次                                      |
| `single` attach、热恢复               | 已有 entry，不能按当前默认值改变引擎；来源/用途冲突保留既有准入限制 |
| 冷 load/resume                        | 严格持久 owner；缺少有效记录的完整旧会话固定 legacy                 |
| Prompt、Cancel、权限、模型、cwd、关闭 | live Session 的 connection / channel；不重选                        |
| transcript/list/工作区文件等只读控制  | 明确的工作区控制通道；不启动另一模型执行者                          |
| 延期的 MCP/Hooks/Skills 工作区控制    | legacy 控制通道；不能声称已同步到 Managed                           |
| fork/branch/运行中历史切换            | 已验证的源所有者契约；Managed 未支持时明确拒绝                      |
| shutdown、强制退出、idle/reap         | 所有存活通道及在途创建，保持既有资源与失败语义                      |

会话通知必须校验它来自 entry 的实际 channel；双通道不能只凭 sessionId 让另一个 channel 对已有 Session 发通知。没有 Session ID 的控制消息必须有明确工作区归属，不能挑任意 channel。

## 首阶段兼容选择

不要为探测兼容性启动 Hooks 或 MCP。先使用现有无执行副作用的配置加载；未能确定扩展有效状态即视为未知，选择 legacy。有效 MCP 包括 settings、`.mcp.json`、CLI、Session 注入、extension、runtime overlay 及 allow/exclude/safe/bare 的共同结果。Hooks 包括用户、可信项目和活动 extension，并受禁用设置影响。

服务端需传入创建用途，不能把缺省 source 或字符串 `default` 当作完整支持证明。例如手动定时运行目前使用 `default` 加 `scheduled_task_run:`，子会话有父关联，Channel 有可信来源；这些均须进入共同选择入口。当前不能绑定的 worktree/cwd/context、模型/权限或延期能力组合选择 legacy。

实际 Managed host 初始化前复核必要配置。如果选择后配置变化，不在初始化副作用开始后改投 legacy。已 Managed Session 的后续配置变更只能在已验证范围内应用，超出范围准确失败。有限默认启用必须有正向可达的普通创建范围；不能以所有请求都选 legacy 通过测试来宣称替换成功。

### 第 3 片接线设计

当前普通创建的四处入口分别为 `runQwenServe` 的 primary、secondary、dynamic/replacement，以及 `createServeApp` 未注入 Bridge 的默认入口。四处使用共同的 CLI 内部工厂组合：保留各自既有 legacy factory、有效环境、工作区目录、generation guard、共享准入和诊断，再配置 Managed factory 与服务端 selector。注入 Bridge/registry 的嵌入者保留自有生命周期，Tool-only worker 继续原路径，不能递归创建完整 Managed Agent。普通 Managed 执行资源独立于实验展示页是否启用；不以实验页开关决定普通会话的执行引擎。

兼容输入必须来自实际 workspace runtime，包含用途、canonical cwd、可信状态、有效环境、真实 argv、settings 各层、MCP 各来源及动态注入状态。MCP 除 settings 和 `.mcp.json`，还包含 CLI/session top-tier、active extensions、`mcp.serverCommand`、bootstrap/session runtime map 与 client MCP。Hooks 除 settings/active extension，还包括 session/Skill/agent 动态注册。创建时结果分为兼容、延期依赖、不确定；仅兼容选择 Managed，另两者选择 legacy。恢复先读严格持久 owner，Managed owner 必须通过同一兼容检查；热 attach 不重选，只在副作用前检查用途和配置变更是否受支持。

现有 `loadSettings` 会迁移/修复文件，extension store 的读取会加锁、恢复并落盘，部分 loader 又把读取错误变为空集合。因此需要严格、无修复写入的配置快照入口，复用既有解析、合并、scope 和环境替换规则；明确区分 ENOENT、读取失败、损坏内容和未知版本。迁移计算可在内存完成，不能在选择过程中规范化或重置原文件。`.mcp.json` 的解析/读取诊断不能在合并时丢弃。extension cache 只有完整且仍对应所读源时才可证明空集合，部分或陈旧 cache 不能作为正向选择依据。明确仍有延期能力声明而仅因 pending/disabled 尚未连接，不以零 toolCount 认定已完成迁移。

selector 和实际 Managed bootstrap/new/load/resume 使用同一兼容规则和可核对的输入快照。后者在 Hooks/MCP/模型/工具初始化前核对实际将使用的数据与动态注入；避免第一次选择后又从容错 loader 得到另一份配置。配置变化导致不兼容时准确拒绝并沿所属通道清理。后续 runtime/client MCP add、Hook/extension reload 等变更必须检查现有 Managed owner，不能绕过创建限制向其注入延期能力；legacy 上仍保留原有行为。快照不包含持久凭据副本，日志只记录来源类别与原因。

普通资源接线还必须覆盖 shutdown、workspace drain/revoke、generation 失效和环境重载。现有本地 Runtime activator 自带进程 registry，接入共享资源管理时要区分释放自身资源与关闭整个 daemon registry；不能让一个工作区释放掉另一个引擎的进程。legacy 子进程、worker 进程树、驻留 Config 和会话数按实际口径计数；现有 child heap 观测不是硬内存限额，不能在状态中宣称新增硬限制。四处工厂统一沿现有 CLI 选项转换，当前应保留 LSP 与恢复提问开关，不重新解析宿主 argv。

第 3 片先验证严格配置输入和普通 legacy 基线，再实施共同兼容策略与实际 host 保护，随后接四处工厂和变更入口。验收必须包含普通无延期依赖配置真正选中 Managed、有效/未知依赖保留 legacy、两种 owner 冷恢复、选择后配置变化、热 attach 与动态注入边界，以及同工作区两种引擎和多工作区隔离。该节是待实现设计，第二片的两组 host 验收不能用作这里的完成证据。

### 2026-09-10 补充：空扩展输入与实际消费

以下为已核对源码及空 store 基线后的实施设计，尚未实现。现有 `ExtensionStore.readConsistent` 会加锁并进入初始化/恢复；`ExtensionManager.refreshCacheWithSnapshot` 使用它加载并替换 cache。不得将现有刷新当作 selector 的无副作用探测。实际基线首次刷新产生 state、基础 lock、空 staging/rollback/transactions 和 enablement；第二次刷新仍改变元数据。普通 `lock` 文件不表示正在持锁，真实标记是 `lock.lock` 目录。

第一片只接受已证明安装集合为空的输入，包含全新无目录与正常初始化空 store；已安装但 disabled 的扩展暂不做完整 activation/manifest 推导，新建仍走 legacy。后续需要支持该组合时另扩展有效配置算法，不伪造空 cache。

| 输入                       | 只读判定要求                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| extensions 目录            | 完整列举，目录或指向目录的链接是安装候选；普通文件不直接视为扩展，已知 enablement/preferences/marketplaces 控制文件保留来源检查；坏链接、特殊文件、I/O 错误或无法解释布局不可放行 |
| store 元数据               | 接受有效空 state、普通基础 lock 和空事务目录；当前 state 有效时 previous 备份可存在；只有 previous 无 state、真实持锁、非空事务、异常类型均为 unknown，不执行恢复                 |
| state 与 legacy projection | 复用现有 schema/parser/hash；extensions、旧启停策略及 remainder 必须为空，projectionHash 一致；损坏/未知版本或需 reconciliation 不改写修复                                        |
| 读取一致性                 | 严格区分真正缺省与悬空文件/祖先链接；读前后检查路径/身份/清单、已读内容与事务状态，变化即 unknown；此为保守乐观读取，不声称跨文件原子事务                                         |
| 数据残留                   | store 下 plugin-data 不能单独证明安装了扩展，但不能用它掩盖 state/安装候选/事务；不加载其内容或创建新的 plugin data                                                               |

建议在 Store 内提供只读 empty-snapshot 结果，复用原验证器；Config 内部参数真实传给同一个 ExtensionManager，绑定来源路径及空状态。该 manager 的两次初始化 refresh、source/status revalidation、显式 refresh 和 refreshTools 共用复核；绑定后禁止管理 mutation，并覆盖 install/commit 的内部非 emitMutation 路径，防止直接填 cache。未绑定的 legacy Manager 仍使用原流程。具体 API 名称以实现为准，本节不声明已存在可用接口。

CLI 实际 Managed 配置加载必须取得并传入该证明，覆盖 channel bootstrap、host bootstrap 与 new/load/resume；Core 初始化在 Hook/extension 消费前再检查，safe/bare 跳过普通刷新时也不遗漏验证。selector 与实际 host 读同一类来源并用同一规则；默认选择未知时可选 legacy，已经选择 Managed 后复核失败只能准确拒绝，不能失败后切引擎。

最少真实验收包括正常初始化空 store 的正向、探测前后字节与元数据不写、坏 state/锁/事务/链接的拒绝、绑定后外部安装和刷新拒绝、无 MCP/Hook/plugin-data 副作用、原 legacy 加载/管理行为保留。已有 `63217 / exit 0` 仅为空 store 读取有写入的基线；新 reader 与绑定 fixed 验收待实现。

### 2026-09-10 补充：四处 factory 与资源生命周期

| 入口                | 基线源码位置                                | 必须继承                                                                            |
| ------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| primary             | run-qwen-serve factory 5238 / Bridge 5680   | primary cwd/runtime base/env/trust/generation，原进程 registry、child policy 与诊断 |
| 启动时 secondary    | 同文件 6130 / 6242                          | secondary 自有有效配置与 guard，同一个 daemon 预算                                  |
| dynamic/replacement | 同文件 7100 / 7234                          | 新 runtime 对象/guard；不能按同 cwd 复用旧代 factory                                |
| 自有嵌入入口        | server 默认 Bridge 1109 / 条件 factory 1139 | 无注入 Bridge/registry 才接管；原默认隐式 spawn 也改为显式配对，注入者保留自有责任  |

行号只锚定 `a836081466`。共同 CLI 内部协调器返回 legacy/managed/select 配对；原 Bridge 的 owner index、权限、文件 guard、sub-session/schedule 回调和 admission 留在既有位置。普通资源不依赖 experimentalManagedAgents/experimentalManagedRuntimeAutoLocal 展示配置；Tool-only worker 标记与 ownedManagedRuntime 必须排除递归。实验远端 provider 不被普通本地接线擅自替换。

registry 在 Bridge 之后形成（run 的约 6450、server 的约 1296）；协调器构造无进程副作用，通过 getter 在第一次 channel start 延迟绑定唯一 provider。尚未绑定时明确失败，不能回退 primary 或另造 registry。保留每代同一个 Managed factory 的 previousTeardown；新启动采实际最新有效环境时也不能重建 factory 丢失前驱失败屏障。

共享 ProcessRegistry 时，activator 的 close/killAllSync 只清理自有 children；daemon 唯一 owner 最后关闭共享 registry。worker root 与 legacy ACP root 可共用资源记账，但 worker 后代不自动计作多个根，Config/Session 数亦不能混用。保留现有 reserve/attach 与 child heap 观测，不新增未实现的硬内存保证。

ManagedToolSession.close 还需要活 provider 完成 cancel/status 到 settled、history 同步和 terminal release。普通关闭必须先 seal 新 admission，await 所属 Bridge/host，再 revoke worker 并等待实际退出，最后 dispose provider/共享 registry。当前实验清理路径中提前 shutdown registry、dispose provider 或 revoke-before-Bridge 的顺序必须在普通接线时调整；启动失败、移除、撤信任、replacement、信号及嵌入 app drain 都需遵守唯一清理所有权，失败保留错误并执行 containment。

workspace reload 当前只发送 legacy 控制命令，Managed factory 当前冻结构造时环境。实现须暂停本代新启动、等待在途/活 host 安全退役后停止 worker，成功发布新环境后解封；失败保持暂停。不能让活 Managed host 继续用旧快照而声称全量刷新，也不能先停 provider 使其无从清理。首片若尚无 host retirement，可准确拒绝活 Managed reload；这仅是阶段限制，完整替换还需补齐。相同 cwd 的旧代晚到结果不能绑定新代。

验收须同时证明：无实验 flag 的四入口正向、绑定前零启动、并发只建一个对应 provider/worker、一个 workspace 清理不杀另一引擎/工作区、实际工具与 writer/history 先清理再物理退出、reload 后新环境且失败不解封。旧双 host test-script 不能替代这些普通资源组合。

### 2026-09-15 拓扑答案（R2.3 接线）

四处普通入口现注入同一 `executionEngines` 配对；injected Bridge/registry 与 Tool-only worker 不接管。以下四条与实现一致，不能事后改口径：

1. **堆预算。** 现有 `childHeapPolicy` 只挂在 legacy spawn factory 上。`limits.memory.enforced` 仍是字面 `false`（观测，不是硬强制）。Managed in-process host 没有 ACP child，不对不存在的 child 报 enforced。injected `deps.bridge` 仍不建这份 policy。
2. **processRegistry。** 只登记 spawn children。Managed in-process host 不造假 PID。Tool Runtime 的 `managed-gateway` 会话必须选 legacy spawn，那些 child 才进 registry。
3. **崩溃半径。** in-process Agent host 可带走 daemon 进程；不声称与 legacy ACP child 同等的进程隔离。工具 worker 仍是子进程。
4. **并发预算。** 双 slot 共用 Bridge 的 `maxSessions` / `freshSessionAdmission` / session owner index，不因两个 factory 翻倍。`activeAcpChildren` 只数 live spawn channel，不含 in-process host。

选择器正向路径：普通 `default`/缺省/`api`、trusted、无 MCP/Hooks、已证明空扩展 → `managed`。Channel / cron / `managed-gateway` / standalone / 子会话 / worktree / 未知来源 / 未信任工作区 / 未证明空扩展（含扩展目录或 store 中的额外文件） → `legacy`。冷恢复读严格 owner；Managed 不兼容（含工作区已不再信任）则失败，不改选 legacy。本记录不是 R3/R4 完成证据。

## 实施与验收顺序

| 次序 | 实现范围                                                    | 必须证明                                                                                               |
| ---- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1    | 严格 owner 读取、落盘、真实配置加载/初始化保护及恢复传播    | 真实 Managed 新建有 durable owner；旧引擎及非 leased/CLI 恢复不能接管；未知/冲突/写失败不进入执行      |
| 2    | 双 channel、共同创建/恢复选择、实际 owner 回执与 entry 绑定 | 同工作区 Managed/legacy 共存；发送/取消/关闭固定归属；限额和关闭不回归                                 |
| 3    | 有效配置、用途兼容判定和所有普通 factory 接线               | primary/secondary/replacement/嵌入入口一致，REST 与 ACP HTTP/SDK 路由一致；延期来源仍原路径            |
| 4    | 普通 Web Shell/SDK 及必要故障验收后有限默认启用             | 普通 create/prompt/events/transcript/cancel、冷重启、权限和故障实际经过 Managed；legacy 不发生隐式重跑 |

主要涉及 core 的 SessionService、transcript reader、ChatRecordingService、Config，CLI 的配置加载、ACP Session 创建/恢复与 managed channel，ACP Bridge 的通道生命周期和 Session 类型，以及 daemon 四处入口。新增 system subtype 同时进入共享 transcript schema，避免被结构校验记作未知类型。按上述顺序交付，避免只增加未被实际调用的字段。

测试先用全局 CLI 与当前 bundle 建立隔离基线，再验证本地构建。重点覆盖创建回执丢失、写失败、预读与 lease 之间变化、非 leased ACP/CLI 接管、压缩后 recent replay、同工作区两种引擎并发、单引擎故障和 shutdown。当前 4170 预览、用户配置和用户历史不作为夹具。

## 全量能力与来源绑定设计

[全量覆盖表](managed-agent-full-design.md)为 C01～C18 给出专项设计；[配置与扩展](managed-agent-config-extensions.md)固定 RootSnapshot 和有效配置/目录 revision，显式贯通原 settings、env、argv、extension、Skills、MCP、Hooks 的真实消费者。当前空扩展正向只读证明和用途 gate 仍是首阶段前置，不能用全量文档替代 capability 的实际实现。后置项已有接口、状态、失败和迁移设计，实施顺序见 F1～F8；未支持或未知配置的新会话仍选择 legacy，已有 owner 不变。
