# Hosted Workspace 项目上下文

[English](2026-10-01-hosted-workspace-context.md) | [简体中文](2026-10-01-hosted-workspace-context.zh-CN.md)

状态：已实现。部分解决 #13057。叠加在 #13166 之上。

## 问题与范围

Hosted 模型回合以 `safeMode: true` 运行，`refreshHierarchicalMemory` 在发现
之前就返回，因此回合开始时没有 Workspace 的 `QWEN.md` / `AGENTS.md`。
safe mode 是一个不可分割的捆绑（hooks、extensions、skills、MCP、工具列
表），必须保持开启；回合的 `cwd` 是 Harness 自己绑定的工作区，而设计禁止
模型依赖它。因此项目说明需要一条来自 Workspace 的路径，而不是解除一道
保护。

本切片交付这条路径：Hosted Workspace 回合第一次获取 Runtime 时，Harness
经 `workspace-context` Runtime 控制操作读取 Session 工作目录的说明文件（`QWEN.md`、
`AGENTS.md`），并把拼装好的文本保存在已接入的 Session 上。Harness 通过 `Config.setUserMemory` 注入取回的文本，并在下一个模型请求前
调用 `refreshSystemInstruction` 刷新缓存的系统指令——Session 已持有上下文
时在 `initialize()` 之后注入，首个请求即可带上；回合进行中取回时，在两个
模型轮次之间注入。

不在范围内：项目 settings、skills、rules 目录（safe mode 有意保持关闭）；
Session 工作目录之外的嵌套或层级发现；为注入的文件触发 `InstructionsLoaded` hook 事件（safe mode 跳过了 core 唯一的触发点，Hosted hook 分发器也不会补发）；已取回上下文的持久记录。持久化需要
新增 Session 域，而这是一个跨语言的契约变更（Java 存储侧镜像了封闭的域名
空间），因此延后：冷加载的 Session 在下一个普通工具回合重新读取。恢复已运行中的工具回合
在同一条「每个 attachment 只读一次」的闩锁下读取：已持有文本的 attachment
绝不重读，而冷加载的 attachment（跨进程接管会构造一个全新的）在其恢复回合
重新获取 Runtime 时读取一次，因此写出用户可见回答的那个回合不会在 slot
静默为空的情况下运行。本切片覆盖原生 files/shell
profile；MCP 回合跳过此读取。

## 时机与 Stage A 不变量

第一个模型请求从不等待 Runtime：读取搭载在第一个工具批次已有的获取动作
上。不调用工具的回合不读取，也不付出任何代价。Stage A 标准——Runtime 延
迟时模型输出仍然先返回——不受影响，因为首个请求路径上的任何环节都没有
变化。

由此带来的明确取舍：Session 的第一个回合在第一个请求时没有项目说明。读取
在该回合的第一次工具派发之前完成，成功读取后，同一回合的后续请求以及该 attachment 上之后的
回合都有项目说明。

## 失败语义

这次读取是 Runtime 控制操作，不是工具执行：它不在执行账本中预留任何记录，
不写 `qwen_tool_execution`，也没有需要取消或恢复的东西，因此故障门禁断言的
执行计数和 Broker 操作序列都不变。Runtime 从 Session 目录读取文件，跳过真实
路径离开 Workspace 的文件（植入的符号链接不能把宿主文件提升进系统指令），
并把每个文件截断到 64 Ki 字符，使回复保持在 1 MiB 控制上限之内。

读取是 best-effort 的。文件不存在、传输失败或 Broker 拒绝都会让 Session 保持
无上下文状态，回合不受影响；失败记录在 Harness 的 stderr。取消会立即停止等待读取，也不会锁定 slot，即使底层请求稍后才完成。
slot 会记录一次已完成的读取——包括「Workspace 没有说明文件」——因此每个
已接入的 Session 只读取一次，直到 Harness 能看到的操作改动了说明文件：原生
`write_file`/`edit` 批次指向 `QWEN.md` 或 `AGENTS.md`（在执行前失效，无论
结果如何），或文件 rewind 的 `filesChanged` 包含其中之一。两者都会把 slot
重置为 undefined，下一个原生工具回合重新读取（#13564）。

## 拼装

每个读回非空内容的文件贡献一节，格式与本地层级记忆一致：
`--- Context from: <name> ---`、去掉首尾空白的文件正文与结束标记。节与节之间空一行。文件名保持 Session 工作目录的相对形式；Runtime 宿主的物理
路径从不出现。

## 实现边界

- CLI 工具回合：获取后读取，每个已接入 Session 一次，与它搭载的回合做失
  败隔离。
- CLI 模型回合：按请求注入的入口；safe mode 不变。
- CLI 会话：已接入的 Session 在其生命周期内保存取回的文本。
- CLI Runtime worker：`workspace-context` provider 控制操作，由 executor 在执行
  账本之外应答。
- Java Runtime Broker：在 provider 控制形状上接纳 `workspace-context`，并像原始
  文件历史一样不先获取 provider Session 直接转发。
- Core：不变。

## 验证与验收

回合级测试钉住：读取发生在第一次获取时，不预留执行，同一 Session 不再重复；
文件缺失时不产生内容；被中止的回合不设置 slot；传输失败既不阻塞也不使回合
失败。worker 级测试钉住符号链接约束与单文件上限；协议测试在两种语言中钉住
封闭的结果形状。模型级测试钉住注入顺
序——预先取回的上下文在首个请求之前注入，回合进行中取回的在下一个请求
之前注入。会话级测试保持既有的恢复与不重复派发保证，并在断言派发计数的
地方显式点名上下文读取。

## 部署与升级顺序

先升级 Broker 与 worker bundle，再升级 Hosted Harness。旧版 Broker 会以
`400 runtime_control_operation_invalid` 拒绝 `workspace-context` 控制操作，
旧版 worker 也会按自身封闭的操作联合拒绝它。由于读取是尽力而为的，这种版本
错配对 API 和模型都不可见：没有任何 Session 能拿到 `QWEN.md` 或
`AGENTS.md`，slot 永远不会锁定，每一轮都会重新读取。可观测信号是 Harness
stderr 上反复出现的 `qwen serve: Hosted Workspace context read failed` 日志。

## 风险与未决问题

上下文是否应持久固定（并经
ContextBinding 契约带上 revision）由维护者决定；本切片建立的注入点在两种
答案下都不改变。

锁存对目录无感：已提交的 `POST /v1/agents/sessions/{id}/cwd` 在不涉及
Harness 与 worker 的情况下结算，因此该接入会继续注入上一个目录的规则，而它
的工具已经在新目录中运行，新目录的指令文件永远不会被读取。用 shell 命令写
说明文件同样不可见：Harness 不知道一次 shell 调用改了哪些文件。要让这些情形失效，需要
把解析后的目录或 ContextBinding 的 `contextRevision` 放到
`workspace-context` 结果上，而该结果的 shape 是封闭的——与上面是同一个
revision 问题，不是本地可完成的修补。
