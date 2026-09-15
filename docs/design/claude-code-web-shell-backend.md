# Claude Code 作为 Qwen 委派子 agent

状态：选定产品设计；实现与验证仍在进行。

本文定义目标契约与验收条件，不是测试报告。接口、分派与执行器正在修订，
代码中存在某个字段或事件不代表端到端行为已经满足契约。

## 1. 产品范围

Qwen 保持父会话与任务编排者的身份，通过 Agent 工具把任务委派给 Claude Code。
Claude 通过本机 ACP adapter 运行；父会话接收任务结果，用户观察子任务并可停止它。
Web Shell 使用子 agent 展示入口，权限决策仍在父会话中完成。

本设计不增加可直接聊天的 Claude 对等后端，不增加独立 Claude workspace runtime，
不改变 workspace 的身份键或 HTTP 路由，也不替换 daemon 的 Qwen ACP 子进程。
**既有 daemon external-tool guard 及其强制握手保持不变。**
Claude 子进程不因此自动获得 Qwen 内部工具策略的保护；两者的安全边界必须区分。

支持目标是普通前台、后台委派及同一存活执行器上的后续输入。
不承诺 Claude 独立会话恢复、跨进程重启续跑、fork、Agent Team / teammate、
其他厂商执行器或 `qwen/control/*` 扩展的替代实现。
子任务面板不是独立聊天入口；查看已记录内容不等同于恢复外部执行器。

## 2. 定义与启动

agent 定义通过独立的 `executor` 字段选择执行器，不能把 `model` 当作后端选择器。
示例放在 `.qwen/agents/claude-worker.md`；先由用户安装并固定所需 adapter 版本，
确认其可执行文件 `claude-agent-acp` 位于 PATH，并按 adapter 要求完成 Claude 认证：

```markdown
---
name: claude-worker
description: Delegate a bounded task to Claude Code
executor:
  kind: acp
  command: claude-agent-acp
  args: []
permissionMode: default
---

Complete the delegated task and report the result and any limitations.
```

`command` 是实际启动的 ACP adapter 可执行文件，不是假定存在的 `claude --acp`。
运行时不得静默通过 `npx` 下载 latest，也不得替用户安装或升级 adapter。
命令缺失、认证失败、握手失败或宿主未注入执行器都必须明确报错。
无效的显式 `executor` 定义必须拒绝，不能丢弃该字段后转用 Qwen。
同样不得在重试、后台续跑或其他分派路径中静默替换后端。

## 3. 分层与接口

实现边界对应以下文件；这些是代码位置，不是完成状态或测试证据：

- `packages/core/src/agents/runtime/subagent-executor.ts`：执行器与工厂契约。
- `packages/core/src/subagents/subagent-manager.ts`：定义解析、运行配置与分派入口。
- `packages/cli/src/external-agents/acp-subagent-executor.ts`：子进程、ACP 与事件翻译。

core 定义 `SubagentExecutor`，CLI 注入 `ExternalAgentExecutor`；core 不承担 ACP transport。
分派必须在创建 Qwen provider、工具注册表或执行定义 hooks 等副作用之前识别外部定义，
完成可信度与约束校验，再把派生的工作目录、提示、权限意图和运行配置传给 CLI。
未声明外部执行器的定义继续使用 `AgentHeadless`。

执行器公共面包括 `execute`、`executeExternalInputs`、结果文本、终止原因、统计摘要、
窄化的 `getCore` 视图、外部消息 provider，以及可选等待回调和资源释放方法。
`getCore` 只提供事件 emitter、模型标签及可选运行视图，不伪造完整 `AgentCore`。
模型标签必须标明外部执行器，不能把执行归到父 Qwen 模型。
管理器返回的 `dispose` 必须组合执行器与宿主资源的清理责任。

提示模板由宿主渲染后与任务文本交给 adapter；通过 ACP 文本提交的指令
不等同于 Claude 原生 system prompt。不能声称其优先级或上下文与 Qwen 完全一致。
Qwen 的工具、skills、MCP、hooks 与模型配置也不会仅因传入接口就被 Claude 执行。

## 4. 信任与权限

外部定义会启动本机代码。项目来源的定义必须在工作区受信任后才能启动，
未受信任时不得先启动 adapter 再拒绝。子进程使用目标工作目录和过滤后的环境，
不继承 daemon bearer token 等 Qwen 内部秘密；环境过滤本身不是进程沙箱。

所有显式配置的限制必须可执行，不能静默忽略。工具白名单、禁用工具、
执行限制、只读要求、MCP、hooks、模型选择及轮数限制等，若没有可靠映射或执行保障，
必须在启动前拒绝并指出不支持的约束；默认内部配置与用户显式要求须区分。
仅在提示中要求“不要写文件”不能兑现只读策略。

权限模式必须由宿主的有效审批策略决定，子定义不能绕过父会话的限制。
不能依赖 Claude 本地设置，也不能把 `session/new` 中的 `_meta.permissionMode`
视为已确认生效的协议契约。**计划修复是建会话后、首个 prompt 前调用原生
`session/set_mode`，确认所需模式可用并设置成功；否则失败关闭。**
未知或不支持的显式模式必须拒绝，不能静默采用更宽松的本地默认值。

Claude 的 `session/request_permission` 转为宿主审批事件，经父 bridge session
路由到用户；不能把仅用于展示的 virtual subagent id 当成权限会话身份。
响应必须选择 adapter 本次实际提供的 optionId；一次授权不得升级为永久授权。
无监听者、无有效选项、未知审批结果、连接断开或取消时一律拒绝或取消，
并释放等待中的请求，不能挂起到无限期，也不能默认批准。

## 5. 生命周期与输入

每个外部执行器拥有自己的子进程、ACP 会话、待决权限与运行状态。
启动、握手和模式设置须有期限，任一步失败都清理已创建资源。
一次只允许一个受管理的活动 turn；并发输入必须序列化或明确拒绝。

已经取消的调用不得发起 prompt。活动取消先发送 ACP cancel，
若 adapter 不响应，须在有限宽限期后终止所拥有的进程及其子进程并等待回收。
进程退出、连接损坏、超时和 dispose 都必须结束待决调用与权限等待。
重复清理应安全，不能误杀其他会话；后台任务只在其管理器持有期间保留执行器。

后续输入必须使用相同的取消、统计、结果重置与终止事件路径。
私有 steering 只有在能力明确支持时才可使用，不能让 adapter 自行启动不可跟踪的 turn。
未支持 mid-turn 输入时不得假装消息已送达；空闲时的后续 prompt 仍须受生命周期管理。
未知 stop reason、拒绝或截断不能无条件映射为成功完成。

## 6. 事件、记录与预算

ACP 更新翻译为 Qwen 的文本流、工具调用、结果、审批及终止事件，
供现有 transcript writer、virtual subagent session 和 Web Shell 消费。
工具结果须保持 callId 与名称关联，重复终态不得重复计数；错误须可见且不崩溃父进程。
每轮成功、失败和取消都必须产生一致终态，后续轮次不能混入上一轮的最终文本。

首期不承诺完整保真：文本和工具状态是基本目标，结构化工具输出、文件 diff、
多模态内容及专用 edit/exec 审批展示只有经过映射与验收后才可宣称支持。
只生成文本事件不代表已拥有完整 transcript；持久化、回放和 Stop 必须逐层验证。

`usage_update` 的上下文占用不是每轮生成 token 数，不能求和或当作 output tokens。
未知 token 使用量必须表达为不可用，**不是免费执行或已知的零消耗**。
若兼容统计结构暂存零，消费者仍须独立识别其不可计量状态。
首期 workflow `agent()` 一律在启动前拒绝外部执行器定义：尚不能兑现 workflow 的
预算、schema 和工具限制。普通 Agent 工具委派不受此门控影响。
仅告警后继续运行不能保护预算；普通委派仍须遵守取消和时间限制。

## 7. 验收条件（待执行，不代表已通过）

- 前台和后台委派确实启动指定 adapter，结果返回父会话，且不创建对等 runtime。
- 无效定义、缺命令、缺注入、未知配置均明确失败；Qwen 替代执行次数为零。
- 未受信任项目与不支持的显式约束在启动前失败，且无 hook、provider 或子进程副作用。
- adapter 使用宽松本地默认时，仍在首个 prompt 前完成宿主要求的原生模式设置。
- 模式不支持或设置失败时无 prompt；allow/deny、缺监听者与取消均按最小授权处理。
- 正常完成、预取消、活动取消、不响应 cancel、子进程退出及重复 dispose 均能有限收敛。
- 后续输入与并发调用不产生脱管 turn；状态、结果、权限等待和工具计数不跨轮污染。
- Web Shell 可观察文本与工具状态、回放记录并停止任务，审批出现在父会话。
- 有或没有 token 上限的 workflow 都在外部启动前拒绝；未知使用量不展示为已知零成本。
- 既有 Qwen 委派、workspace 身份与 daemon guard 行为不变。

验收应结合针对性单测、可控制 ACP 对端的协议与失败路径测试，以及固定 adapter 版本的
真实委派测试；保存可复查结果后再更新实现状态。本文不引用私人运行日志作为完成依据。
