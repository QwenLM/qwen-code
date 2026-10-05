# Managed Hooks 运行时（H2）

[English](2026-09-30-managed-hooks-runtime.md) | [简体中文](2026-09-30-managed-hooks-runtime.zh-CN.md)

状态：已实现并完成本地验证；Linux cgroup 执行验证待完成。本变更在 H1 之后实现
[#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 H2。
依据为[扩展运行时设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md)
第 5 节，以及[配置设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-config-extensions.md)
第 6 节。

## 问题与范围

Hosted Session 禁用环境中的 Hooks。Legacy runner 在内存中保留本地进程、回调和 once
状态，无法证明替换 Harness 后原操作发生了什么。H2 在副作用之前提交计划和执行身份，
遇到不确定结果时向原 owner 对账。后置 Hook 失败不能改变已成功工具的物理回执。

实现扩展现有私有 Hosted Workspace profile，并增加公开只读 Hook catalog。与 H1
相同，生产 AgentBundle 启用另行处理。本变更不启用无关的 H3/H4 能力，也不启动第二套
主 Agent loop。原生 Hook dispatcher 接受全部现有事件；生产者是否可用仍由选定
profile 决定。

## 记录与计划

`hook_registration` 固定部署目录与不可变资源。`hook_execution` 保存 occurrence、
ordinal、registration、plan、有效输入、原 Runtime Session、取消意图、物理状态和
结果引用。两者复用 `ExtensionRun` 校验器和 `domain.committed` 日志，不创建用户任务
条目。TypeScript 与 Java 消费共用正反例，并校验资源闭包、固定版本、唯一 ordinal，
以及在 intent 时原子消费 once key。

这些校验的开销不能随 Session 的 Hook 历史增长。once key、occurrence 与 ordinal、
目录 pin 在记录的各个修订之间不变，因此 Session Store 在记录首次提交时把它们投影到
带索引的列。(Session, once key) 和 (Session, occurrence, ordinal) 上的唯一索引拒绝
重复，包括并发重复。occurrence 绑定与目录摘要只需与同一 key 下的一条已提交记录比较，
因为准入保证同一 key 下的记录彼此一致。Session authority 在内存中维护相同的 key，
重新打开日志时按线性时间回放记录。因此准入不再重读较早的记录，也不再在每次准入时
发现其中某条记录已损坏；所有记录及其资源闭包在 Session 恢复时完整校验。

每个 occurrence 固定目录与计划。Session 内串行准入 occurrence，防止并发事件
同时预订同一个 once Hook；每个计划内部仍保留原生并行/顺序执行行为。同一 ID 携带不同语义输入会被拒绝。顺序执行持久化
每一步有效输入，并复用原生 prompt context 和工具输入累积逻辑；并行结果按计划顺序
聚合。保存结果前应用 fail-open/fail-closed，包括由 status 对账取得的回执。失败或
未知的 once 尝试不会重新获得资格。

目录就绪且没有待恢复操作时，即使取消发生在新 occurrence 建立前，也会保存计划和
取消结果，不派发子 Hook，也不消耗其 once key。PreToolUse 因而可以先持久化拒绝
每个已提交的 assistant 工具调用（包括同批次的后续调用），再以 cancelled 结束
turn。已有未知副作用或 journal 写入失败仍会阻塞该续行。

目录替换是带预期 registration 数量的幂等操作。同一目录命名空间内 revision 递增。
重试旧操作只确认原结果，不恢复旧的有效目录。新 revision 删除 Hook 只影响未来事件。
部署的 Session/agent 条目携带明确 owner；先做 owner 过滤，再复用原生配置去重，避免
一个 agent 继承另一个 agent 的 handler。

## Runtime 所有权

在 Tool Runtime 进程设置 `QWEN_MANAGED_HOOK_CONFIG`，指向部署方持有的 JSON
manifest。版本为 `1`，每个目录含 `tenantId`、`workspaceId`、`catalogId`、
`catalogRevision`、64 位十六进制 `definitionDigest` 和 `hooks`。每项 Hook 声明 ID、
事件、matcher、执行策略与 recipe。Command/HTTP recipe 和可信 function 模块路径
留在 Runtime；Harness 只接收计划元数据与 prompt 定义。Function 模块导出带版本的
对象，包含 `callback` 和可选 `onHookSuccess`。Handler 不可用时准确阻塞，不对序列化
closure 求值。Function context 使用当前 Session 的实时历史，并保存持久化快照供
重放。只有匹配 function 的计划保存 messages；大快照使用不可变的 60 KiB 分片。完整
control envelope 上限为 8 MiB，网络派发前检查，不截断消息，也不把已知未执行误记为
unknown。快照、计划和引用元数据也共用 Session Store 现有的 8 MiB 事务预算。快照准入
为计划、输入、分片 manifest 和记录闭包预留 256 KiB；超限快照在发布前转换为有界停止。
提交包含完整快照引用闭包；Store 在 manifest 或分片缺失时原子拒绝事务。

Manifest 是明确的部署目录，不导入 Harness 主机环境中的 user/project settings 或
任意 client callback。Source 元数据按原生 registry 排序；Session 注册保留原生追加
行为。把 Legacy settings 迁移到部署目录时，必须保留其已经解析的 user/project merged
fallback 与信任决定。

全部 worker Hook 路由属于 **live-session-owner scope**。Broker 转发校验 tenant、
workspace 和 Session，定位已保存的 Runtime，并在新副作用之前检查 workspace generation
和 operation grant。Status/cancel 只查询原执行。Owner 丢失或被替换时保持 unknown；
状态查询不派发替代副作用。
Hook owner ID 在构造时根据已经持久化的 activation ID 与 epoch 固定。每次 load
安装新的 activation，因此不会复用已释放的 Runtime Session ID。即使 acquire 仅用于
目录请求、尚无首条 Hook execution 记录，恢复也能找到 owner。旧随机 owner ID
继续从 execution 记录恢复；旧版本若没有留下任何 execution 记录，则需要运维恢复。
只有 load 的 activation 对应 owner。每次生命周期 Hook 操作会安装一个
`hook_operation` activation，结束时再安装一个恢复 activation，其 ID 由该操作所
替换的 activation 的 ID 派生。日志中总有那个 activation，因此即使
`hook_operation` activation 安装失败，也能识别出恢复。恢复 activation 沿用默认
subject，因此记录格式不变；日志拒绝安装已存在的 activation ID，因此派生 ID 不会
重放之前的安装。两者都不会构造 Hook session，因此释放时跳过两者，其开销不随 Hook
操作次数增长。load 总是安装随机的 activation ID，因此即使它位于失败或未恢复的
Hook 操作之后，也仍视为 owner。同一 Hook session 中并行的 Hook 执行共享同一次
acquire，因此它们只执行一遍释放流程。之后的 load 会再次释放更早的 load owner；
释放是幂等的，重复释放只多一次 Broker 往返。在恢复 ID 改为派生之前记录的恢复
activation 会像 load 一样被释放，Broker 对这次释放返回 404。因此对本次改动之前
写入的日志，之后每次 load 仍要为每次更早的 Hook 操作发送一次 release。
替换后的 Hook owner acquire Workspace 前，会释放所有 Hook 记录已终态的旧 owner，
包括经 status 完成对账的 owner。工具结果 continuation 复用同一 acquire 入口。
共享的物理工作仍在运行时，Broker 继续拒绝释放。仅明确的
`runtime_session_not_found` 可以视为 owner 已不存在。Detach 同样释放已结算的旧
owner。已 attach 的空闲 owner 仍像 MCP 一样保留 Workspace 租约；调整该生命周期
作为独立设计任务处理。

命令复用原生输出、超时和 TERM/KILL 处理。Managed 执行要求 Linux cgroup v2 委派：
将 `QWEN_MANAGED_HOOK_CGROUP_ROOT` 指向可写且提供 `cgroup.kill` 的 domain。干净的
launcher 先进入独立 unit，再启动命令。`setsid` 和 detached 子进程不会脱离该 unit；
只有 `cgroup.events` 确认无剩余进程后才完成。比命令存活更久的后台子进程会让 unit
保持非空：即使命令已输出结果并退出，也会在 Hook 超时到期时以 `timeout` 结算，
随后 unit 被终止，输出不会生效。Hook 命令不得遗留后台进程。取消先发送 TERM，必要时调用
`cgroup.kill`；无法证明排空时保留 owner。这是面向部署方可信 Hook 的生命周期隔离，
不是防止脚本故意篡改 cgroup 控制面的安全沙箱。

隔离能力不可用时（包括 macOS 和 Windows），在命令启动前返回
`managed_hook_command_isolation_unavailable`。日志记录 `not_started_proven` 和
`handler_unavailable`，可通过取消关闭被阻塞的 occurrence。对于 SessionStart、
UserPromptSubmit 和模型执行前的原生 InstructionsLoaded，若准入后没有 model
attempt、tool intent/receipt 或非 user 消息，
且没有未决 Hook，显式取消还会持久化结算 Hook 持久化输入 `prompt_id` 对应的已准入
turn。此前 SessionStart 的取消不能结算后来的 turn。对于被拒绝且显式取消后具有
`not_started_proven` 的 PreToolUse child，恢复还可关闭首个已提交的工具调用批次：
所有模型 attempt 必须已结束，至少一个已提交输出，不得有 tool intent/receipt、
未决审批、文件历史工作或 Hook，且取消 child 的 occurrence 与输入必须匹配唯一
未结算 turn 的原始调用。恢复先为每个缺失的调用持久化匹配的拒绝结果，再将 turn
结算为 cancelled。响应按包含元数据的完整记录实际 UTF-8 大小分批，遵守 64 KiB
inline 上限；每条成功记录作为下一条的 parent。单条响应仍超限时保留恢复屏障，
不截断调用身份。
新批次在提交 assistant 消息前检查每个取消响应的大小，超限调用在工具 acquire
或派发前即被拒绝。
部分批次已提交的响应保持不变；写入失败保留屏障，重试不会重复响应。
恢复与 turn、控制操作准入串行化；Load 同样修复此前已取消的记录。其他模型或
工具 continuation 仍保持阻塞。单个进程组消失不能作为
进程树排空证明。环境继承限于执行必需变量和 recipe 显式条目。Async 准入等待 Runtime
ACK，这不是完成回执。正常已确认的 async 工作可与后续 turn 共存；未知工作阻塞新准入
并保留 Runtime hold。

trusted function Hook 取消或超时时，Runtime 最多等待一秒，确认真实回调 Promise
已结束后再给出终态失败回执；回调从未开始时也可安全结算。回调 resolve 或 reject
是结束证据，仅有 abort signal 不是。超过宽限期仍未结束的回调保留 unknown 结果和
原 Runtime hold，不重放。原生 Legacy function Hook 的取消行为保持不变。

Workspace 的 Write/Edit 备份和显式撤销共用 Session 的 Hook Runtime owner，
快照仍保存真实 prompt 身份。已确认准入的 async Hook 可以与 history bind、prepare
及 snapshot 并行；撤销和释放 owner 仍要求全部 Hook 执行结束。撤销也排除 Hook
目录/模型操作和非 active activation。冷加载时，先用匹配 checkpoint 工具输入中
保存的原 Runtime owner 观察未决文件历史，再释放此前的 Hook owner。缺失或冲突的
owner 证据继续阻塞恢复，不增加新的持久化字段。
Shell 回执恢复确认 capture 投递时，也从已提交的工具输入读取原 Runtime owner；
prompt ID 和接管后的 Hook owner 都不能标识原执行。

HTTP 使用原生 URL/DNS、凭据环境变量与超时策略，拒绝重定向。收到失败响应可以结算；
Runtime URL 白名单与 HTTP 执行器使用相同的允许变量插值，仍限制内部密钥并执行原生
SSRF 检查。
执行器在派发前构造失败时，按保存的失败策略结算；
发送后丢失响应保持 unknown，不自动重试。Managed HTTP Hook 已派发后，用户取消
保留原请求及响应体读取，最多等待配置的 HTTP 超时，用完整响应作为结算证据；
occurrence 仍以 cancelled 结束。派发前取消不发送请求。Runtime 关闭时立即中止
transport；派发后的关闭、超时、断连或不完整响应均保持 unknown。原生 HTTP 的取消
仍立即中止请求。单项回执和聚合输出上限均为 60 KiB。
初始计划（含事件输入、descriptor 和快照引用）超限时，保存有界 blocking 回执及原始
语义输入的摘要。恢复直接返回该拒绝，不派发或消费 once，即使没有匹配 handler 也能
完成结算；同一 occurrence 携带变化后的输入仍会冲突。
单项回执超限时转换为有界失败结果，遵守保存的 fail-open/fail-closed 策略。聚合输出或
下一项顺序输入超限时，则以持久化的 blocking 结果结束 occurrence，保留已完成子项的
真实回执；后续未派发的 Hook 不消费 once key。恢复根据保存的回执得到相同结果，
不重复副作用。合并后的工具 Hook context 还需通过现有历史记录大小检查；若无法容纳，
则保留原工具和 Hook 回执并停止编排，不写入或重试超限历史记录。
Runtime 最多同时运行 16 个操作，每个目录最多 128 项 Hook。
并发额度拒绝保留有界的失败回执，遵守保存的失败策略。Runtime 最多保留 4096 条
操作回执（含这些拒绝），不淘汰或重放。达到上限后，在安装 grant 前返回明确的
blocking 回执，PermissionRequest 始终返回 deny，不受失败策略影响；Harness
持久化该结果。立即返回的已结算拒绝必须先返回，不能被异步准入成功掩盖。这个永久容量上限区别于临时并发拒绝。容量回收需要持久确认协议，
留待后续实现；
未保存的拒绝若丢失响应，查询仍保持 unknown。

H2 明确接受真正 unknown 带来的无期限可用性损失。SessionEnd 或 SessionDelete
结果未知时，DELETE 返回 503，保留已 attach 的 Session 和原 Workspace owner。
重试观察同一个已保存的 occurrence，不重新派发。Detach 也要求全部 Hook 副作用
已结算。保留的 owner 可能阻塞同 Workspace 的其他 Session 的工具执行，不会阻塞
不同 Workspace 的 Runtime worker。未知操作在 worker 生命周期内持续占用 16 个
准入名额之一并保留 hold；包括已结算结果在内的全部已保存回执都计入 4096 条生命周期
上限。超时、用户取消、DELETE 或进程替换都不能证明完成或允许重放。H2 不提供运维
放弃 unknown 的接口；回执对账和有持久化屏障的回收在
[#13133](https://github.com/QwenLM/qwen-code/issues/13133) 跟踪。这是明确接受的恢复
限制，不代表有界恢复或可用性保证，也不表示原评审问题已解决。

## 模型 activation

只有 Harness 执行 prompt Hook。Turn 内 Hook 使用该 turn 的独占模型 scope。
Notification、扩展和关闭事件可以领取 `hook_operation` activation，不创建用户 turn、
任务完成、工具循环或 startup Hook。两种 subject 共用 Session 单调递增的 activation
epoch。即使 provider 忽略超时取消，scope 也会保持占用直到调用实际结束。
释放旧 activation 后若安装 Hook activation 失败，控制器仍会恢复 Session activation。
如果恢复也失败，则在 activation 恢复前拒绝接收新的 prompt。
HTTP journal 提交遇到临时传输失败、429 或 5xx 时，最多尝试三次，间隔 250 ms，
保持事务身份、记录字节、资源和 writer scope 完全相同。重放必须返回匹配的原回执，
本地 authority 才能推进。永久拒绝、回执不匹配或重试耗尽仍会停止写入并要求 journal
恢复；不会清除写入屏障或尝试安装另一个未经确认的 activation。

模型尝试和用量关联原 Hook operation，并在存在时关联原 turn。预算记账沿用 Session
与 turn 的现有语义；Hook operation 不得重置原预算。本变更不增加金额预算策略或独立
Hook token 池。
隔离模型的 Config 清理错误单独记录，不替换已返回的 Hook 结果或原操作错误。

## 事件接线

| 事件                                                        | 生产者与顺序                                                                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| SessionStart、UserPromptSubmit                              | Hosted startup 只发生一次；原始提交与有效模型输入分别保留。前置 Hook 阻断时不派发模型。                                                              |
| UserPromptExpansion、Notification                           | 通过认证的私有 operation 路由使用调用方稳定 occurrence。扩展结果返回调用方，供其提交。                                                               |
| PermissionRequest、PreToolUse                               | 先权限，后 PreToolUse。修改参数后重新校验，策略要求询问时创建新 Action。拒绝执行的调用不伪造物理后置事件。                                           |
| PostToolUse、PostToolUseFailure、PostToolBatch              | 先提交原生回执，按物理 success/error/cancel 选择事件；批次等待全部结果。恢复补充 Hook context，不重复工具或历史。                                    |
| MessageDisplay、Stop、StopFailure                           | 最终显示有独立稳定 occurrence；suppress 同时影响返回 parts。Stop 可要求继续推理；真实模型 API 失败触发 StopFailure。                                 |
| InstructionsLoaded、PreCompact、PostCompact                 | 现有原生生产者委派到持久化 dispatcher。初始化指令事件等待模型认证；压缩路径向上传递 Hook 恢复错误。                                                  |
| PermissionDenied、SubagentStart/Stop、TodoCreated/Completed | 完整原生事件桥保留生产者 payload、owner 身份和 Todo phase。在对应原生能力执行时发出；Hosted file/shell/MCP profile 不伪造 AUTO、child 或 Todo 操作。 |
| SessionEnd、SessionDelete                                   | 显式删除先排空先前操作，再执行生命周期 Hook，最后释放 Runtime/provider/writer。Detach 不发这两个事件。                                               |

Dispatcher 不在 Managed Config 中加载或执行环境中的 Legacy Hooks。Hosted 显式生产者
从原生重复发射中排除。重建 activation 不等于新的 startup 或用户 resume。Stop occurrence
使用持久化 model attempt ID；只有 Stop 阻断后才设置续行标志，普通工具 round 不会
设置。显式 after/batch Hook stop 结束编排，同时保留物理回执和未被模型消费的状态，
Session 仍可开始下一轮。

已加载目录包含 Stop 或 MessageDisplay 时，模型文本在两者完成决策前保持缓冲。
丢弃或隐藏的草稿不会成为持久化 text delta。没有这两类输出策略的 Session 保留增量流式输出。

## 接口与兼容性

Session 创建/加载可提交 `hookCatalog: {catalogId, catalogRevision, definitionDigest}`，
同时需要 Hosted Workspace tool profile 和 Broker。加载时省略初始 pin 会恢复保存值，
显式提供时必须相同；后续已提交 registration 保持权威性。Workspace 冷加载在 attach
前校验 Hook 记录资源及完整 function messages 快照闭包，并保留原 owner 恢复屏障。
打开 authority 时，每条记录及其引用的每个资源只读取一次，无论有多少修订引用它。
Workspace 校验复用该结果，只读取它必须自行检查的内容，例如 plan 及其消息快照；
Session 打开后 authority 不再保留该结果。
相互独立的读取按有界批次并发执行。
Hook scope 标识符兼容现有 Broker 字符语法，包括开头的标点。Hook 操作阻塞 prompt
准入期间，Session status 返回 `recoveryBlocked`，load 返回 `recoveryRequired`。
已保存的操作实际结算后，对账会清除此诊断。

Runtime-only 接管标志仍让 Hook Session 使用现有的 Hook 感知加载与核对路径。
Runtime-only continue/cancel 路由在修改记录或 Runtime owner 前，以
`hosted_hook_recovery_required` 拒绝 Hook Session；不能忽略待结算 Hook 副作用或
模型 scope 来结束回合。

私有 Session/client scope 路由提供 `GET /session/:id/hooks`、注册更新、Notification/
扩展操作和 operation status/cancel。修改操作不能与 turn 或另一控制操作重叠。Hook
操作运行期间被拒的 prompt 返回 409 `hosted_hook_operation_active`。同一 Notification/
扩展 operation ID 携带不同输入时返回 409 `hosted_hook_operation_conflict`，重试无法
解决。公开
tenant/actor scope 的 `GET /v1/agents/sessions/{sessionId}/hook-catalog` 只投影展示
元数据，不暴露 recipe、凭据、模块路径或 handler 引用。未配置 Hook pin 的 Session
保持原有行为。

变更涉及 Core Hook dispatch/activation/record 校验、CLI Hosted 编排与 Runtime 执行、
Java Broker transport 和 Session Store 投影，以及对应同目录测试。Migration V27 将首次
准入的日志序号保存为 `first_sequence`，后续修订保持不变。最新已结算目录按该序号选择，
与原生注册顺序一致；即使旧注册较晚结算，也不受时钟或 UUID 排序影响。
Migration V28 增加准入列与索引；V29 从经过校验的记录体为 V27 写入的记录回填。
记录体缺失或损坏的记录不写入 key，V29 按资源缺失的方式阻塞其所属 Session
（`BLOCKED_RESOURCE`），使后续准入无法复用该记录已消费的 once key。若记录重复了
所属 Session 中已有的 once key 或 occurrence ordinal（只有绕过准入的写入才会留下），
V29 同样阻塞该 Session；其他 Session 不受影响。迁移后不支持再运行早于 V28 的二进制：它写入的 Hook 记录不带这些 key，
Session Store 的检查看不到这些记录，但 Session authority 仍在内存中执行这些约束。

## 验证与验收

被忽略的工作计划为 `.qwen/e2e-tests/12827-h2.md`。基线使用全局 `qwen`；验证使用本地
bundle、确定性模型响应、真实进程与副作用计数。生产 transport 测试连接 Hosted、Java
Session Store、Embedded Broker 与派生的 Tool Runtime。本地 SQL 使用 H2，不代表已经
测试 MySQL 部署。当前验证主机为 macOS，未安装 Linux 容器运行时。Linux cgroup 子进程、
取消及 async 排空测试为条件测试，尚未在本机执行；环境要求记录在
`.qwen/e2e-tests/12827-h2-cgroup-validation.md`。本地 transport E2E 使用可信 function
handler 验证副作用，并单独验证 command 在执行前拒绝，不能据此声称验证了 Linux
command 排空。

验收包含四类 runner、顺序聚合、once 失败、async 准入/取消/排空、参数重新审批、冷恢复、
丢失执行与 HTTP 响应而不重复副作用、目录替换、owner 隔离、prompt activation 和无 Hook
回归。运行 `npm run build`、`npm run typecheck`、`npm run bundle`、包内定向测试与 Java
契约测试。集成验证后进行两轮无新问题的自审及独立评审。未知物理或模型结果保留原证据并
阻塞；仅模拟事件的测试通过，不代表缺少生产者的能力已经受支持。

显式 Runtime 恢复与取消保留原始持久工具输入证明的 owner（包括共用 MCP owner），不默认替换为 prompt ID。所有权证据缺失或冲突时，在任何 Broker 调用之前拒绝恢复。Raw Shell intent 缺少路由证据时，仅在保存定义没有共用 Hook 或 MCP owner 的情况下使用 prompt owner。

Broker 的 execution-unknown 响应仍表示结果未知，与执行记录不存在区分。取消请求之前或之后观察到未知状态时都拒绝结算；不能据此提交 cancelled 结果或释放 owner。被动恢复仍把该结果报告为 unknown。
