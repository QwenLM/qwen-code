# 受门禁保护的 Hosted Workspace 工具回合

[English](2026-09-27-hosted-workspace-tool-turn.md) | [简体中文](2026-09-27-hosted-workspace-tool-turn.zh-CN.md)

状态：已在私有门禁后实现，基于 main `daaac2223`。属于 proposal #12380，承接 Hosted 无工具路径和 W0c-3。这是私有集成切片，不是公开能力启用。

> 审批更新（2026-09-30）：Hosted Workspace 工具回合现在可以在 Session 的审批模式不预批准的调用之前请求审批，因此下文“不实现交互式审批”一句描述的是之前的切片。详见 [Actions](2026-09-30-managed-agent-actions.zh-CN.md)。

> 文件历史更新（2026-09-30）：Write/Edit 备份结算及私有仅文件撤销已在 [Hosted Workspace 文件历史](2026-09-30-hosted-file-history.zh-CN.md)中实现，涵盖持久化、reload、冲突检测与失败边界。下文对文件备份的排除描述的是之前的切片。

## 问题与现状

Hosted Harness 已有持久化的无工具文本回合。W0c-3 独立支持通过持久化 Workspace 绑定执行工具，并持有 SQL 存储所有权。目前没有代码把模型的函数调用接到这条路径。变更前，通用 TypeScript Broker provider 依赖生产 Broker 尚未实现的 control、prepare 和 start 操作。本片补齐 prepare/start，但明确不实现该 provider 的通用 control 契约。

当前即时执行 API 在创建 Broker 执行记录时就开始副作用，还把工具输入存进 reference。Hosted 接续需要相反的顺序：预留原始执行，提交 Session 意图和等待检查点，然后派发。模型继续必须依赖已提交的结果，不能只依赖成功的 HTTP 响应。

O1c #12821 提供本地前台 Shell 捕获和同进程发布器，尚不提供生产 Broker 选择或独立进程结果发布。此边界存在前，Hosted Shell 不能宣称完整捕获，也不能使用 Tool v3 ACK。

## 范围与门禁

普通 Hosted 会话继续走现有无工具路径。工具模式要求配置现有的部署侧 Broker URL/token 对，并在私有 Session create/load 请求中显式选择 `toolProfile: "hosted-workspace-files/1"`。所选 profile 随 Session 定义持久化，load 时拒绝更改。公开 Workspace Turn 门禁和能力广播继续关闭。

使用现有固定、可信、预批准的 Workspace 配置。本片不实现交互式审批、任意配置、MCP、Hooks、后台 Shell、文件撤销快照或跨宿主恢复。工具消息和结果持久保留；这与文件备份历史不同。Runtime 工具沿用 W0c 的部署信任边界，不因此成为文件系统沙箱。

首个可独立验证的 profile 接纳 Read/Write/Edit。前台 Shell 仍受完整捕获契约约束：设计保留与 O1c 的接入，但缺少所需发布器/回执能力时不得回退到 v2。独立进程桥接留待后续，本片保持 Shell 关闭。

## 所有权与配置

私有 Hosted 路由归属当前 Session owner。其 Managed Store 的 tenant、Workspace 和 Session key 不可变。Broker 通过现有 W0c resolver 读取原始持久化 Session，验证冻结的 Workspace 绑定、当前授权、存储身份和配置。Harness 启动目录只用于本地配置与临时工作，绝不选择工具位置。

Broker 路由归属持久化 Session 与选定 Runtime。acquire 返回解析得到的 tenant/Workspace 和固定能力身份；Harness 在预留调用前验证。未知、撤权、不匹配或不可用的绑定不得使用全局目录或 Legacy 引擎。

模型工具声明是已接纳 profile 的固定快照，在 Runtime 就绪前即可使用。Harness 不保留可执行的本地工具，且本地调用 guard 继续关闭。文件参数使用 Workspace 相对路径，仅在 worker 已安装的上下文内解析。模型不需要知道 Harness 宿主的物理目录。

## Broker 两阶段派发

实现已有保留路径 `executions:prepare` 和 `executions/{id}:start`。prepare 写入四字段调用引用和内部 `dispatchMode: "deferred"` 标记，返回持久化执行身份，不派发。start 提供一个有界的 `payloadJson` 字符串，包含工具名和输入。引用摘要是这些精确 UTF-8 字节的 SHA-256。Java 在解析前验证字节，重放时也验证，不尝试重现 JavaScript 的规范 JSON。

Harness 在持久化参数资源中保留精确 payload 字节。Broker 只在原始派发调用栈中携带解析后的输入，绝不存进 `reference_json`。不同字节的重复 start 冲突；匹配的重复 start 只观察原始执行，不重跑 SETTLED 或 UNKNOWN 工作。原即时接口不能成为启动无 payload 延迟预留的旁路。

取消 PREPARED 执行时不调用 Runtime，直接结算。派发器在 transport 副作用前持久化 EXECUTING。过期的 EXECUTING 所有权转为 UNKNOWN，保留原有不重放规则。只有匹配的显式 start 能推进尚未被领取的预留，重启不隐式重放。

## 回合时序

1. 使用现有 Session 权威持久接纳 prompt，独立启动 Runtime 预热和模型推理。无工具回答可在环境仍准备中时完成。
2. 验证完整模型响应，在副作用之前拒绝 profile 外的工具。在获取所有权前，按精确序列化字节检查每个参数资源及完整 assistant 记录是否满足 Store 内联限制，包括 UTF-8 编码、JSON 转义和记录元数据。
3. 第一批工具到来时，获取一个 Runtime Session 及其 Workspace 存储所有权。提交完整模型响应，逐个发布精确参数资源、预留调用，并通过 `tool.intent` 事件关联每个输入和 schema，然后在任何 start 之前提交一个 `await_runtime` 检查点。
4. 在该所有权下顺序执行调用。通过原始 execution identity 查询状态和取消，不为恢复丢失响应而创建替代调用。
5. 持久化每个执行结果和模型函数响应，再把现有 Harness 检查点推进到 `results_ready`。只向下一次模型请求发送这些已提交响应，在该请求完成后记录消费，并在多批工具间保留顺序。
6. 提交最终 assistant 消息并结算已消费的接续，仅在结果/历史持久结算后释放原 Runtime Session；release 先关闭 worker 门禁，再清除 Workspace 所有权。之后才提交回合终态记录。因此，release 响应丢失时冷 load 仍会看到未结算输入。

工具模式历史保留完整的函数调用/函数响应组。无工具路径用于移除未回答文本 prompt 的历史过滤器不能复用于这里。事件回放只暴露已提交记录。所有含工具调用的 assistant 消息均回放完整记录，包括文字与工具混合的消息；不能退化为空文本块或仅文本块。

## 失败与取消

回合工具执行中遇到明确返回 HTTP 409 `workspace_busy` 的 acquire 拒绝不再直接结束回合：这表示另一 Session 的工具回合持有挂卷，本回合等待持有者释放——以短轮询重试 acquire，仅受回合取消与截止时限约束——然后取得所有权并继续，因此同一 Workspace 上的第二个 Session 排队而不是丢失回合。`workspace_unavailable` 拒绝，以及恢复路径上的明确拒绝，仍以普通错误结束回合，Session 可重试或 reload。占用存储后的 acquire 失败统一使用 `runtime_session_acquire_failed`，包括后续权限复检失败，仍要求恢复。acquire 响应丢失也保持阻塞。

派发前的准入或参数资源失败不会产生工具副作用。start 响应丢失后只查询原始执行。无法观察的结果、lease 丢失、结果提交失败或未验证取消会把 Session 阻塞在持久等待点。调用方可观察 recovery-required 状态。Harness 不发出正常 completed/cancelled 安全边界，也不允许新 prompt 忘记这些工作。

Read/Write/Edit 的无效 `file_path` 在该批次获取 Workspace 或派发工具之前成为模型可纠正的拒绝。共用的 Workspace 相对路径校验器保持不变；Hosted 文件工具层将其路径错误以及缺失或非字符串参数转为指出 `file_path`、但不回显取值的函数错误。整批模型调用均被拒绝，每个同批调用得到明确的“未执行”响应。必须先提交完整 assistant 调用及全部拒绝响应，模型才能继续；提交失败或结果不确定时保持恢复阻断。模型在同一回合改用正确的相对路径后可以执行，不会重放已拒绝批次。

取消会中止推理，并按原始身份请求取消每个已预留或已启动调用。取消请求不等于停止证据；只有 Runtime 终态结果允许结算和释放。无法观察出结果时保留所有权并阻塞。释放失败也阻塞后续工具，不在本地清除所有权。结果未知时仍持有 Workspace 存储，因此同一 Workspace 的其它 Session 会收到可恢复的 busy 错误，直到 W0e 恢复清除原持有者。

私有循环最多运行 16 轮模型请求。Broker payload 上限为 256 KiB，但每个参数、结果和历史资源也必须满足现有 Session Store 的 64 KiB 内联限制。过大的参数和 assistant 记录在获取所有权前拒绝。对已知终态执行，同时检查序列化 outcome 和完整 tool_result 记录，包括 UTF-8、JSON 转义和元数据；任一超限时，持久化保留原 executionStatus、标记 outputOmitted=true 的小型函数错误，替代原输出，read_file 响应提示模型缩小 offset/limit 范围。这份回执不表示工具未执行。仍须提交并消费回执后才能正常结算和释放；未知结果和持久化失败仍要求恢复并保持阻塞。每个 Broker HTTP 请求超时为 30 秒，执行观察最多两分钟加上当前请求。这些是私有 profile 内部限制，不是新用户设置。

冷 load 保留现有对未结算输入的拒绝。进程丢失后的自动接续、孤儿 worker 接管与旧代执行对账属于 W0e/#12766/#12670。本片记录后续所需的原始身份，但不宣称完成这些能力。

## 组件与消费者

影响 Hosted profile 校验器、Session/模型运行器、窄范围 Workspace Broker 客户端与回合协调器、Runtime Broker prepare/start 服务与 HTTP 路由和 transport 输入分离，以及 worker 的 profile 相对文件参数处理。普通 daemon/ACP 模型循环与通用 Managed provider 仍是独立消费者。

Java 产品 coordinator 和公开 Workspace 准入继续受门禁约束。私有集成测试创建实际持久化 Workspace Session，并运行同一生产 Broker/worker，不使用虚构 manifest 或 start 行为的 transport。O1c 留在独立分支，不复制其本地发布器代码。

## 验证与验收

- 对全局 CLI 做基线验证，记录其私有 profile 是否可达。区分全局入口不可用和源码无工具门禁的证据。
- 故意延迟 Runtime 就绪，证明第一次模型请求更早开始；无工具回答不等待环境就绪即可完成。
- 在两个 Workspace 目录中通过真实 worker 执行 Read/Write/Edit。在 Harness 启动目录放置诱饵文件，证明没有读写它。
- 将绝对路径或越界的 `file_path` 与有效写入放进同一批次。验证两个调用都有按序持久化的错误、该批次不获取 Workspace 且无文件副作用；同一回合修正路径后恰好写入一次。重新加载后核对完整历史，并验证同一 Workspace 的后续 Session 可用。
- 执行至少两轮模型/工具循环和后续 prompt；断言模型请求与持久回放中的调用/结果一一对应。
- 验证 busy/unavailable 拒绝后可继续 prompt 和 reload，而 acquire 响应丢失及占用存储后的失败仍阻塞。在获取所有权前拒绝过大的输入和完整 assistant 记录，包括 UTF-8 和嵌套 JSON 转义。
- 读取密集 CJK 文本，另行覆盖 outcome 合规但完整记录超限的边界。验证有界省略回执保留执行终态、进入模型与持久历史、允许后续缩小范围读取并释放 Workspace 所有权。覆盖 JSON 转义膨胀和错误输出，保持未知结果与持久化失败时的阻塞。
- 在 start 前注入参数/意图持久化失败，观察零文件副作用。丢弃 start 响应，证明只查询原执行且不产生第二次副作用。
- 验证 start 前取消、执行中取消和状态不可读时取消。仅物理已结算工作可产生回合终态；未知结果阻止后续 prompt 和 reload。
- 验证结算前后的 prepare/start payload 冲突、存储引用不含 payload、prepare/cancel 竞态和原接口兼容性。
- 维持默认无工具进程测试通过。在完整捕获/回执能力可用前，Shell 必须在副作用前拒绝。
- 运行构建、类型检查、打包、定向 TypeScript/Java 测试、独立进程验证与连续两轮干净自审。分别报告 fixture、真实进程和真实数据库证据。

## 尚未完成的边界

独立进程 O1c 发布器/回执桥接、完整 Shell 输出、文件备份/撤销结算、公开 actor 准入、产品 UI 启用、W0e 恢复及更广泛 G/H 工作，都不能由私有工具回合测试认证。worker 结果目前仍携带原生绝对路径；将其转换为面向模型的 Workspace 相对路径仍待后续处理。扩围时必须先同步两种语言的设计与验收测试，再启用相应能力。
