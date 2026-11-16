# Mod 兼容基线

[English](2026-10-23-mod-compatibility-baseline.md) | [简体中文](2026-10-23-mod-compatibility-baseline.zh-CN.md)

状态：提案。本文描述 `main`（`3d65e23cf6`）上已实现的实验性 Mod 运行时，以及把 Claude Code 兼容基线从 2.1.296 移到 2.1.308 的三项改动。改动 1 与 2 正在 #15273 和 #15306 中评审。跟踪 issue：#13749。

## 问题与当前行为

Qwen Code 运行 Claude Code Mod API 的一个子集。插件的 hooks 模块导出 `register(on, options)`；每次 `on(event, matcher?, handler)` 调用向中间件链添加一个注册，处理器接收 `($, e, next)`。开启 `experimental.mods` 且工作区受信任时，该子集在 headless 会话以及 Ink、OpenTUI 终端中运行。

每个会话有一个 worker 线程，每个插件运行在独立的 QuickJS 环境中，不能访问 Node、文件系统或网络。插件按"消费者先于依赖提供者"排序；插件内部按注册顺序组成链，Qwen Code 自身行为是最内层处理器。hook 能收到 `session.start`、`session.end`、`command.run`、`tool.call` 和 `tool.check`。`$` 提供 `command.register` 与 `ui.log`，它们作为 API 事件经过同一条链。失败的 hook 会被跳过，除非它的 `.catch` 给出答复；如果派发无法把输入交给 hook，或无法取回 hook 的答复，就拒绝该工具调用，或扣下已经产生的结果。每次普通 `tool.call` 续调都是一次全新的原生尝试，照常经过校验、classic hooks、权限和审批。`tool.check` 只能收紧 Qwen Code 自己的权限决定。

钉住 2.1.296 后的两周内，Claude Code 发布了 2.1.299 至 2.1.308。其 Mod API 新增一个事件（`prompt.change`）和三个 `$` 方法，并改了若干语义。由此产生三个缺口：

- 只要注册了支持列表之外的任何事件，初始化就会失败。因此为 Claude Code 写的 Mod 无法在 Qwen Code 中加载，即使是本运行时已支持的部分也用不了。Claude Code 自己只拒绝它没有定义的名字。
- Mod 在 `tool.check` 返回的 `ask` 与其他 ask 一样交给审批模式处理：YOLO 会自动批准，AUTO 由分类器决定，对话框还提供"总是允许"。在 Claude Code 2.1.308 中，hook 发出的 ask 交给人来回答，没人能回答时直接拒绝，事件里还带有 `isReadOnly` 和 `approver`。
- 兼容契约只写在用户指南里，钉在 2.1.296，也没有说明如何对比更新的版本。

## 目标与非目标

目标：

- 加载为更新的 Claude Code 版本编写的 Mod，同时只运行已支持的子集。
- 在"谁可以批准调用"这一点上，让 `tool.check` 与 2.1.308 对齐。
- 记录兼容契约，以及它如何迁移到新版本。

非目标：`session.version` 以外的新事件或新 `$` 方法；渲染、状态、流式事件、热重载与 ACP 入口。它们按 #13749 跟踪的阶段推进。

## 兼容契约

公开 API 即 Claude Code 的编写契约。Qwen Code 实现其中一个带版本的子集：

- 每项文档化的行为都注明所依据的 Claude Code 版本。完成下文的改动后，可识别的事件名取自同一个版本 2.1.308：它的引擎事件、`$` API 事件与 `classic.*` settings hook 事件，共 144 个名字。
- 有意的差异继续写在用户指南中：每个插件一个 QuickJS 环境；`tool.check` 只能收紧原生决定；PermissionRequest hook 不能批准 Mod 自己的 ask；工作区设置不能修改插件设置；依赖失败时拒绝启动；与内置命令冲突时，插件的命令会被改名。
- 迁移到新版本时：提取该版本的插件 API 声明，与当前基线对比事件、`$` 方法和变化的语义，更新事件列表和测试，并在用户指南中写明该版本。Claude Code 每加载一个 Mod，都会把这些声明写到 Mod 旁边的 `.claude-plugin/types/claude-code/index.d.ts`。它们的优先级高于 CHANGELOG，后者只是对声明的摘要。

## 改动方案

### 1. 跳过 Qwen Code 尚未运行的事件的 hook

如果注册的名字是 Claude Code 定义的事件，或前缀（如 `prompt.*`）属于它的某个命名空间，那么即使它匹配不到任何已支持的事件，也照常加载，只是永远不会运行。重复注册、matcher 和容量规则对它仍然生效。Claude Code 没有定义的名字（例如 `tool.calls`）仍会导致初始化失败。

启动时，每个插件只报告一次被跳过的 pattern，输出位置与 transcript 日志相同：终端里是一条提示信息，文本模式写到 stderr，JSON 模式输出 `system/ui_log`。内容为 `Hooks for unsupported events will not run: prompt.submit, ui.render`。

被跳过的守卫（包括它的 `.catch`）不会提供任何保护。插件的 `unsupportedEvents` 设置可以把它设为 `"reject"`，恢复原来的拒绝行为；该设置和 `toolDialect` 一样从用户或系统设置读取，默认值为 `"skip"`。

`$.session.version()` 让 Mod 可以自行适配。它解析为 `{ version, qwen: { claudeCode, events, methods } }`：

- `version` 是 Qwen Code 的版本；
- `claudeCode` 是可识别事件名所依据的版本；
- `events` 列出 hook 能收到的事件，`methods` 列出 `$` 提供的方法。

与其他 `$` 方法一样，它作为 API 事件经过中间件链，其他插件可以观察、代答或拒绝。

### 2. 让 `tool.check` 对齐 2.1.308

事件新增两项由引擎设置、hook 不能修改的字段，两者都声明在 2.1.308 的 `ToolCheckInput` 上：

- `isReadOnly: true`：工具报告该调用为只读时设置。包括读取、搜索和抓取类工具，服务端标记为只读的 MCP 工具，以及通过只读检查的 shell 命令。字段缺失时，hook 应把调用当作可能写入。
- `approver`：能弹对话框问用户时为 `person`，由 stream-json 宿主回答权限请求时为 `host`，没人能回答时不设置。

Mod 自己的 ask 交给人来决定，与 PreToolUse hook 的 ask 现有行为一致。"自己的 ask"指 Mod 新发出或改写过的 ask，而不是把 Qwen Code 的 ask 原样上传。具体表现为：

- YOLO、AUTO_EDIT 和 AUTO 分类器都不能批准它；
- 对话框显示 Mod 的理由和插件名，并隐藏"总是允许"；
- 批准同批的其他调用不会连带批准它；
- 没人能回答的会话会用 Mod 的理由拒绝它。

与 PreToolUse 的 ask 一样，PermissionRequest hook 可以拒绝该调用，但不能代替人批准。这比 Claude Code 更严格：Claude Code 允许这类 hook 批准。

2.1.308 的声明把这些表达为由引擎设置的数据：引擎在 hook 答复的 ask 上标出插件名（`ToolCheckResult.plugin`），并说明谁能回答（`ToolCheckInput.approver`）。2.1.304 的 CHANGELOG 描述的则是 hook 答复上的 `decider: "person"` 字段。到 2.1.308 时这个字段已被移除：引擎对答复的校验不再接受它，hook 发出的每个 ask 都是要人回答的 ask。Qwen Code 以 2.1.308 为准。

合并规则仍然只收紧：Mod 依旧不能把原生的 ask 或 deny 改成 allow。

### 3. 把契约钉到 2.1.308

测试覆盖 Claude Code 2.1.299 收紧的取值边界：深层嵌套的值、自有的 `__proto__` 键，以及会抛错的 getter。测试也覆盖派发无法把输入交给 hook、或无法取回 hook 答复的情况。完成后，用户指南把基线改为 2.1.308。

## 后续阶段

跟踪 issue #13749 中的各阶段从本基线继续，每项单独提交改动、自带测试：

- 编写闭环：静态校验、生成类型声明、开发期重载。
- 宿主 API：先做会话信息、时钟、状态与存储，再做文件、进程、HTTP 和模型，每类都有各自的权限边界。
- 提示与回合事件，以及对应 Qwen Code settings hooks 的 `classic.*` 事件。
- 工具注册、子代理与 ACP 入口。
- Ink 与 OpenTUI 中的终端渲染，之后是 Web Shell 投影。
- 托管分层。

Claude Code 公开的示例作为里程碑：Token Weather 需要会话信息、回合事件和提示框上方区域；Replay Theater 与 Blast Radius 还需要文件与进程访问、按钮和面板。

## 验证与验收

- 用真实 QuickJS worker 测试以下内容：
  - 被跳过的注册，包括前缀、取反、matcher 和 `.catch`；
  - 拼错的名字、未知命名空间和未知 classic 事件仍被拒绝；
  - `unsupportedEvents` 设置及其优先级；
  - `$.session.version()` 经过中间件链，包括其他插件代答和拒绝。
- 调度器测试覆盖 Mod ask 在 default、AUTO_EDIT、AUTO、YOLO 和 PLAN 模式下的表现，分别在终端、headless 和 stream-json 中，检查对话框理由、隐藏"总是允许"、连带批准，以及无人回答时的拒绝。Mod 原样上传的 Qwen Code ask 保持原生行为。
- 构建后的 CLI 在 headless 文本与 JSON 输出、Ink 和 OpenTUI 终端中检查以下场景：
  - 钩住了未支持事件的 Mod 能够加载，只报告一次，并能运行它的命令；
  - 设置 `unsupportedEvents: "reject"` 时拒绝加载该 Mod；
  - YOLO 模式下的终端会话里，Mod 的 ask 会弹出对话框；YOLO 模式下的 headless 运行中会被拒绝。

## 风险与待定问题

- 被跳过的守卫会让对应调用失去保护。缓解办法是启动提示行和 `"reject"` 设置。插件不能在自己的 manifest 中声明这一策略，因为 Claude Code 没有定义这样的字段。
- YOLO 与 AUTO 用户会看到以前不会出现的 Mod ask 对话框。这是有意为之：Mod 要求由人来确认。
- 新增了事件的 Claude Code 版本，在事件列表迁移之前会被拒绝；Claude Code 自己同样拒绝它不认识的名字。
