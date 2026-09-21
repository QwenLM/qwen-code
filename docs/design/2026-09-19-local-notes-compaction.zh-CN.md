# 本地 notes 压缩与会话历史恢复

[English](2026-09-19-local-notes-compaction.md) | [简体中文](2026-09-19-local-notes-compaction.zh-CN.md)

状态：已在本地实现，通过策略开关显式启用；验证记录见第 8 节。
日期：2026-09-19。
源码基线：Qwen Code `42f9d13cdae0a7d462019487646bf7fb4995bf24`；
Codex `5b1d6560181680f95cde95c14ed042acc02248ed`。

## 1. 问题与建议

长任务既需要一份简洁的当前工作状态，也需要找回笔记中未保留的细节。
Qwen Code 目前在压缩对话时生成新摘要。反复摘要可能遗漏早先的约束、
已经失败的方案或工具结果原文。原始会话记录通常仍保存在本地，
但模型没有专门的工具来检索它们。

增加显式启用的 `notes` 压缩策略。执行任务的主模型在工作过程中维护一份
有长度上限的 Markdown checkpoint。在安全边界，运行时用这份 checkpoint、
最后一条真实用户请求和必要的运行时上下文替换当前模型历史。
只读 history 工具从现有本地 session log 中取回更早的记录。
成功的 notes 换窗口不调用摘要模型。

现有 summary 策略继续作为默认方案和兼容回退。
本地存储与检索不依赖 Codex 账号，也不需要新增 memory 后端。
正常推理仍使用已配置的模型 provider；检索结果和注入的 notes 会进入该 provider
的模型输入。

## 2. 已核实的基线

### 2.1 借鉴 Codex 的哪些能力

所检查的源码将机制拆成四项能力：

| 能力                    | 已确认的行为                                                                                                                                         | Qwen Code 的适配                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `get_context_remaining` | 返回运行时计算的剩余 token，也可能返回未知。                                                                                                         | 复用 Qwen Code 按 chat、按 route 的 prompt 计数和阈值计算。                |
| `new_context`           | 设置待处理请求，由运行时安装新窗口，不生成摘要；它不会写入或验证 notes。                                                                             | 要求有效分支上最新持久化的 notes revision；单独校验 reset 的当前观察状态。 |
| `notes.*`               | Notes 在普通进展和跨窗口后仍可复用，不检查 source-leaf 新鲜度。专用工具调用 `alpha/notes/v2/*`，路径是虚拟路径；扩展要求相应的 provider 和后端认证。 | 通过一个小型内建工具维护本地、当前会话范围的 notes。                       |
| `history.*`             | 专用工具查询后端规范化历史。                                                                                                                         | 沿已验证的当前有效分支查询本地 session transcript。                        |

Codex 仍保留预算提醒和强制换窗口阈值。它的 notes hint 上限为 4,000 bytes，
提供笔记入口，不会自动加载全部笔记。只开启底层 token-budget 功能，
并不会获得本地 notes/history 实现，也不会自动恢复 summary 回退。
这些是源码事实，不代表所有已部署的 Codex session 都启用了该模式。

Qwen Code 借鉴“工作状态与可回查历史分开”的设计，同时作两项调整：
先验证完整能力再允许换窗口，并直接注入小型 checkpoint。
一般的工具调用模型不应先发现并读取一份笔记，才能知道自己要继续什么任务。

源码依据：

- [Codex 预算计算](https://github.com/openai/codex/blob/5b1d6560181680f95cde95c14ed042acc02248ed/codex-rs/core/src/session/context_window.rs#L57)、
  [提醒逻辑](https://github.com/openai/codex/blob/5b1d6560181680f95cde95c14ed042acc02248ed/codex-rs/core/src/session/token_budget.rs#L161)。
- [待处理的窗口请求](https://github.com/openai/codex/blob/5b1d6560181680f95cde95c14ed042acc02248ed/codex-rs/core/src/tools/handlers/new_context_window.rs#L27)、
  [窗口替换](https://github.com/openai/codex/blob/5b1d6560181680f95cde95c14ed042acc02248ed/codex-rs/core/src/session/mod.rs#L4385)。
- [Notes/history 工具与接口](https://github.com/openai/codex/blob/5b1d6560181680f95cde95c14ed042acc02248ed/codex-rs/ext/history-notes/src/tools.rs#L24)、
  [扩展启用条件及 hint](https://github.com/openai/codex/blob/5b1d6560181680f95cde95c14ed042acc02248ed/codex-rs/ext/history-notes/src/extension.rs#L45)。
- [Token-budget 压缩分支](https://github.com/openai/codex/blob/5b1d6560181680f95cde95c14ed042acc02248ed/codex-rs/core/src/session/turn.rs#L1408)。

### 2.2 Qwen Code 已有的基础

| 现有组件                  | 相关行为与影响                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChatCompressionService`  | 对完整 curated history 做摘要，再重建摘要、确认消息、最近文件/图片附件和运行时提醒。没有可直接复用的普通 recent-turn tail。                                                                                                                         |
| `LlmChat` 和 `LlmClient`  | 管理自动/手动压缩、发送准入、token 计数、缓存失效和压缩事件。Notes 换窗口需要接入这些链路。                                                                                                                                                         |
| `ChatRecordingService`    | 追加包含 UUID/parent UUID 的记录。已有 `system/chat_compression` 将 `compressedHistory: Content[]` 保存下来供恢复。                                                                                                                                 |
| Recorder 严格写入         | `recordChatCompression()` 当前是 fire-and-forget；inactive recorder 可能静默忽略普通 append。`appendRecordStrict()` 会拒绝不可用 writer，并等待实际写入。普通 writer 已对每条 JSONL append 执行 fsync；lease 模式额外提供所有权围栏和文件身份校验。 |
| `SessionTranscriptReader` | 已提供有界读取、冻结快照、有效分支解析和选择性恢复。可以作为 history 检索基础，无需另建 transcript 存储。                                                                                                                                           |
| 会话搜索和引用            | 选择器搜索扫描物理日志，不保证当前分支过滤；`@session` 引用省略工具结果正文。二者都不是这里需要的 history 工具。                                                                                                                                    |
| 子 agent                  | 其 `LlmChat` 不使用主会话 recorder，而有独立 agent transcript。共享父会话 notes 会破坏隔离。                                                                                                                                                        |

Session log 保存的是录制下来的 canonical conversation，不保证包含全部原始
provider 或工具输出。大结果可能已被截断，只留下临时 artifact 指针；
推理和媒体还需要单独处理。History 检索必须标明这些限制，不能宣称无损恢复。

Qwen 基线中的关键位置：

- [摘要构建](../../packages/core/src/services/chatCompressionService.ts)，
  `compress()` 约 535、1095 行；
  [历史安装](../../packages/core/src/core/llm-chat.ts)，约 2733 行。
- [记录协议和严格 append](../../packages/core/src/services/chatRecordingService.ts)，
  约 259、518、1453、2518 行；
  [checkpoint 回放](../../packages/core/src/services/session-api-history.ts)，约 191 行。
- [Transcript reader](../../packages/core/src/services/session-transcript-reader.ts)，
  `readPage()` 与选择性恢复；
  [会话生命周期](../../packages/core/src/services/sessionService.ts)，搜索及 fork。

## 3. 目标与首版范围

首版覆盖拥有可写、可恢复本地 transcript 的主对话：交互式 CLI、
headless CLI/SDK，以及满足该条件的 ACP 会话。
支持模型主动换窗口、预算触发的自动换窗口、`/compress`、resume，
以及现有已经支持的 fork/rewind 边界。

每个 session 只维护一份 checkpoint，并提供字面历史检索。
多文件 notes、跨会话或跨 agent 查询、embedding、新数据库和 notes 编辑 UI
留待后续。Auto Memory、`QWEN.md`、`/remember`、`/dream` 和外部 memory provider
继续作为生命周期不同的独立能力。首版中的子 agent、继承历史的 side-task replay，
以及没有合适 recorder 的 chat，继续使用现有压缩行为。

## 4. 方案设计

### 4.1 启用条件与所有权

在现有 compression 对象下增加一个设置：

```json
{
  "model": {
    "chatCompression": {
      "strategy": "notes"
    }
  }
}
```

允许值为 `summary` 和 `notes`，默认 `summary`。
`/settings` 提供“上下文压缩方式”，可选“摘要”和“笔记与历史”，
与 `settings.json` 使用同一属性。修改后需要重启 Qwen Code；
同一进程内恢复会话不会重新加载此设置，也不会即时改写正在使用的历史。

只有当前 chat 拥有 active recorder、能够严格持久化、history 能解析有效分支，
且四个必要工具都能通过最终的工具/权限策略时，才启用 notes 换窗口。
否则报告一次具体原因，并使用 summary 压缩。
在 resume、模型/工具策略变更以及每次换窗口前重新检查就绪状态。
不能用 provider 名称或订阅资格决定是否支持。

保留 recorder 已有的两种写入模式。普通 CLI/headless 沿用当前单 writer 假设，
等待严格 append，底层 `jsonl.writeLine()` 使用 `appendFile({ flush: true })`。
启用 lease 的 ACP 会话还保留所有权和文件身份检查。
不能把仅适用于 lease 的 `hasWriteOwnership()` 当作统一 readiness 判断。
本功能不扩展跨进程 writer 协议；多个普通 CLI 同时写同一 transcript 不在首版保证范围，
检测到完整性冲突时必须停止切换。

Controller 和工具绑定到真正拥有它们的 chat 与 recorder。
存储从该 session 所属 runtime 和项目解析，包括远端 runtime。
这里的“本地”指运行 Qwen Code 的 runtime 所在机器。
不得回退到父会话或 daemon 的 primary runtime。本提案不增加 daemon route。

### 4.2 权威 notes 与 Markdown 物化文件

复用 transcript 所在目录：

```text
<Storage.getProjectDir()>/chats/<session-id>.jsonl
<Storage.getProjectDir()>/chats/<session-id>.notes.md
```

当前默认路径在所配置 runtime base 的 `projects` 树下；
不要照搬过期注释中的 `~/.qwen/tmp/...` 作为存储协议。

JSONL 是回放时的权威来源。每次写 notes，追加一条 `system/session_notes`，
payload 包含 `version: 1`、`windowId`、`sourceLeafUuid` 和完整 checkpoint `text`。
使用记录自身已有的 UUID 作为 notes revision。
宿主从产生该 notes 调用的模型请求实际包含的实质性 transcript 边界捕获
`sourceLeafUuid`，并将这份观察信息传递到工具执行阶段。
不能在写入时直接标记最新磁盘 leaf：用户输入和普通工具结果可能已被录制，
但生成这次响应的模型还没有看到。
在串行 append 操作内部验证已观察边界仍与当前边界一致；过期时拒绝写入，
不能偷偷升级其覆盖范围。Notes 与普通工具混合调用时，不论完成顺序如何都视为过期。
CLI 在接受排队的 steering 之后、执行工具之前，观察原始请求；
OpenTUI 的 delivery 边界补充延后写入的记录。ACP 将持久化用户记录 UUID
绑定到展开后的实际输入 parts，兼容图片、hook 和命令展开。
取消或本地处理的输入会释放其待交付标记，但不会追溯扩大旧 notes 的覆盖范围。
ACP 的内置 `/compress` 使用现有 slash-command 元信息记录，不作为新的模型用户输入。
引用使用相对的 record 标识；payload 不保存父 session ID 或绝对 notes 路径。

当前 `windowId` 从有效链上最近的 compression checkpoint UUID 推导，
第一次压缩前使用该链的首条实质性记录 UUID；创建元信息可能在 fork 时替换，
因此不作为初始窗口身份。新窗口使用本次已提交压缩记录的 UUID。
这样 resume 和 fork 可以保留身份，无需另建 window ledger。
有效分支上最新保存的 notes 在普通进展和跨窗口后仍可用于换窗口。
笔记原始 window 和 covered leaf 保持不变；它们描述覆盖位置，不作为失效条件。

先通过 recorder 的严格方法写入权威记录，再用同目录临时文件和 rename
原子生成 Markdown sidecar。两步都成功后工具才返回成功。
物化失败时可以留下可恢复的 canonical revision，但它不能授权换窗口。
Resume 从当前有效链重新生成 sidecar。直接编辑这个生成文件不会自动导入；
未来可以增加显式 import，以免形成两份权威状态。

Checkpoint 正文同时受 16 KiB UTF-8 和
`min(2048, floor(contextWindowSize * 0.1))` 估算 token 上限约束。
对超限或空笔记返回清楚的错误，不静默截断。
这些是初始内部限制，不增加配置项。
提示词建议记录目标、用户约束、决策、已完成工作、失败方案、下一步和精确历史引用，
但不强制固定的 Markdown schema。

读取已持久化的笔记时保留固定的 16 KiB 和 2,048 token 上限。
切到窗口更小的模型后，旧笔记仍可读出供缩短。
写入和换窗资格还要满足当前模型窗口的 10% 预算；
能读到旧的超限笔记，不代表它能授权 reset。

### 4.3 模型工具

使用普通内建 function tools，使所有支持工具调用的 provider 共享同一协议。
工具只能操作当前 session。

| 工具                    | 初始协议                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_notes`         | `action: read \| write`；`write` 接收完整 `text`，返回已持久化 revision 和覆盖位置；不接受调用方提供的路径。`read` 返回最新有效笔记与 revision。                                            |
| `session_history`       | `action: list \| search \| read`；list/search 返回不透明的记录引用和有长度上限的预览；read 接收已有引用和文本范围。搜索采用区分大小写的字面匹配，可选 role 过滤。适用的操作均支持有界分页。 |
| `get_context_remaining` | 无参数。返回当前窗口 ID、估算输入用量、距自动压缩的剩余 token、距 hard limit 的余量以及估算来源；未知值明确标注。                                                                           |
| `new_context`           | 必须传入成功写 notes 后得到的 `notes_revision`；检查资格后排队一个请求。结果只表示等待切换，不能声称新上下文已经安装。                                                                      |

Notes 写入和 reset 请求串行执行，模型必须等写入成功才能用该 revision 请求换窗口；
但写入不必紧邻 reset，也不必发生在同一窗口。
首版要求 notes 写入和 `new_context` 各自独占一个不带普通 assistant 文本的
tool-only response，也避免本响应自己的工作输出推进已观察边界。
遇到混合 batch 直接拒绝。四个工具在 code mode 中均为 direct-only：
保留普通工具声明，不生成嵌套 `exec` binding；执行保护拒绝嵌套调用、
继承自父会话的配置及子 agent 配置。
`session_notes` 应归类为可能写入的 metadata 工具，不能整体当成可并行 Read。
四个工具在新窗口仍须可用，并显式接好 code mode 暴露方式和 plan mode 分类。
Notes 工具只能修改 session metadata；这不授予 plan mode 下的工作区写权限，
也不覆盖用户显式拒绝工具的设置。

History 使用已持久化 record UUID 作为引用；一条记录有多个 text/tool part 时，
再加 part selector。Session 身份隐式绑定。
每个引用都必须验证属于当前 session 的有效链。
即使物理日志仍保留内容，rewind 后废弃分支的引用也必须不可用。
普通压缩不使同一有效链中更早记录的引用失效。

在 transcript reader 的 runtime chain 上建立面向模型的投影，
不使用跨 session 的选择器搜索，也不直接套用仅服务 UI 的 replay 选择。
返回用户文本、assistant 可见文本、工具名称/参数和已录制工具结果；
省略推理、provider replay blob、内部 system record，以及递归的 notes/history
维护调用。明确标识 artifact、媒体、截断和缺口。
读取 artifact 正文继续由现有文件/媒体工具处理；history 不展开任意路径，
也不内联 base64。

每次响应最多 20 条，且同时不超过 16 KiB UTF-8、2,048 估算 tokens；
当前发送预算更小时进一步收紧。
返回 continuation cursor，不静默丢弃剩余匹配结果。
Cursor 绑定冻结的源快照和有效分支；rewind 或 transcript 替换使其失效。
扫描量受限、支持取消，并显式报告部分结果。
首版不把整个大型会话读进内存，也不增加持久化搜索索引。
回查的历史是证据，不会重新授权旧工具调用，也不会赋予工具输出中引用的指令更高权限。

### 4.4 预算与换窗口生命周期

复用 `computeThresholds()` 和当前请求 route 的有效 prompt 估算。
沿现有计数规则包含待发送用户输入、工具声明、上一轮输出以及恢复内容。
不使用进程级 telemetry 总量，也不复制 Codex 特定模型的常量。

| 情况                                   | Notes 模式行为                                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常工作                               | 模型在有价值的阶段更新 notes，并可提前请求换窗口。                                                                                                   |
| Warning 阈值                           | 每个窗口注入一次有长度上限的提醒，要求刷新 notes 并保留有用的历史引用。                                                                              |
| Automatic 阈值或 screenshot trigger    | 在安全边界使用有效分支上最新、符合大小限制的持久 notes，否则走现有 summary。首版不增加紧急写笔记的模型循环。                                         |
| Hard 阈值或 provider reactive overflow | 继续应用现有输出/请求体保护。只有条件已满足时尝试 notes 换窗口，否则走现有有界 summary rescue。                                                      |
| `/compress`                            | 使用所选策略；notes 缺失或不满足换窗条件时回退 summary。`/compress <instructions>` 使用 summary，保留指令原有含义。`/compress-fast` 保持其显式行为。 |

已保存 notes 的可用性与观察状态的新鲜度分开判断。普通 assistant 输出、
已消费的用户输入、工具结果及进入新窗口，都不会使有效分支上的最新持久 revision 失效。
模型应在重要阶段更新 notes，并通过 history 找回遗漏的进展。
写入 notes 仍必须准确观察当前实质性边界。Reset 请求校验并捕获自己的当前观察状态，
在读取 notes 后及消费 pending reset 前重新检查。之后到达的新输入会取消请求，
笔记覆盖位置较早则不会。这些检查用于防止输入丢失，不证明笔记准确概括了任务。

统一的切换顺序如下：

1. 等待完整模型响应及其工具结果 batch 结束。不截断流式响应，
   不拆开 tool call/result，不 reset 尚未完成的前台工具操作。
   新用户输入通过现有 send lock 排队。
2. 检查 notes revision、有效分支、recorder 状态、待处理输入和请求 route。
   一次只消费一个 pending reset。沿现有 trigger 语义运行 `PreCompact`，
   保留其返回上下文，再检查状态。
3. 构建候选历史，确认其比原历史小、低于 automatic 目标且有可用输出空间，
   并符合 provider 消息顺序。所有可能拒绝候选的大小/协议检查都在写 checkpoint 前完成。
4. 严格追加一条 `system/chat_compression`，保存完整 `compressedHistory`、
   既有 completion metadata，以及新增 notes metadata：`strategy: notes`、
   新/旧窗口 ID、notes revision 和已覆盖 leaf。
   旧窗口指本次实际替换的窗口；covered leaf 仍为笔记原始覆盖位置。
   再次检查本次尝试的边界和有效分支上的最新 revision，确认所有未观察输入
   都包含在候选末尾实际追加的 pending message 中。预检查不将输入标记为已消费。
   必须确认本次具体 append；`recordChatCompression(); await flush()` 不足以证明成功，
   因为 inactive recorder 可能静默跳过 append。
5. Durable commit 完成后安装这份完全一致的历史，更新 per-chat token 估算，
   使普通压缩会清理的缓存失效，并只发送一次 completion event 和 `PostCompact`。
   崩溃后恢复使用同一份 checkpoint。Durable commit 后的 abort 不回滚已持久化状态。

一次压缩尝试统一拥有 hooks，包括 notes 失败后回退 summary 的情况。
回退时复用已经拿到的 `PreCompact` 上下文，避免重复执行有副作用的 hook。
Notes 会话内的 summary fallback 也使用同一 durable commit 边界。
未提交的候选不发送 completion 或 `PostCompact`。

模型主动调用 `new_context` 使用现有 `auto` hook trigger；slash command 使用 `manual`。
Notes 换窗口时，`PostCompact.compact_summary` 传递已提交的 checkpoint 正文。
Notes/fallback 的 post-hook 通知必须从提交前的 summary 构建过程移出；
仅在外层再包一次 hook 会造成重复触发。

Commit 必须处于现有 session 串行操作边界内。
不能在 recorder 队列自己的 callback 内，再向同一队尾排 strict write 并等待它。
Strict append 被接受前到达的新输入或 abort 取消 pending reset，下一次尝试重新捕获状态。
Append 开始后不能取消或回滚该写入；I/O 期间到达的输入/abort 在 commit 边界后处理，
若 append 失败则进入写入失败处理。
缺失、被新版本替代或属于废弃分支的 notes 对应的 `new_context` 返回可操作的错误，保留原历史。

### 4.5 新窗口的内容

重建既有 system instructions、有效工具、权限和环境。
替换后的对话包含：

- 可被现有逻辑识别的 compression/restoration wrapper，其中包含有界 checkpoint
  正文、笔记写入时的窗口 ID、covered leaf、notes revision 和历史检索入口说明。
  提示明确指出 notes 可能未包含之后的进展。新窗口 ID 是已提交
  compression record 的 UUID，可通过 `get_context_remaining` 获取。
- 从记录 provenance 确认的最后一条真实用户请求，包括 mid-turn steering。
  若已被旧窗口消费，在 synthetic restoration prefix 中原文保留并附 source UUID；
  若仍待发送，只在末尾追加一次的 pending input 中保留，不能在 restoration prefix 中重复。
  更早的请求可通过 history 寻址，
  其中仍然有效的要求必须由模型写进 notes。
- 现有必要的 runtime reminders、active plan/goal 状态、工具发现状态，
  以及按当前策略、有上限地恢复最近文件/图片。

采用合法的 `Content[]` role 交替，并使用可识别的 compression prefix。
不能让 rewind 或 UI history mapping 把 notes 算成人类新增的 user turn。
更早的消息仅从当前模型输入中移除，canonical transcript 保留。
新 context window 不创建新 session，不重置用量预算，也不取消后台任务。

Pending input 的 exactly-once 必须同时适用于持久化 checkpoint、实时 history 和冷回放。
待发送用户消息或普通工具结果可能已录制在 checkpoint 前，但尚未发给模型。
若这类输入在主动 reset 请求后到达，会使该请求失效。自动 notes handoff 可以继续，
前提是所有未观察输入都包含在实际 pending message 中；其他排队输入仍会阻止交接。
Notes 和 summary 候选都必须包含该 pending 内容一次，为待发送工具结果保留匹配的调用，
并告知调用方已经包含，避免再次追加。
只在 commit 后追加到内存会使 resume 丢失输入；
把它当成旧窗口最后用户请求保留，则会造成重复。

先刷新恢复附件，再计数；不能假设图片能从纯文本 history 中恢复。
必要内容无法装入时拒绝 notes 候选，并执行下面的失败语义。
不能为报告换窗口成功而静默截掉用户约束或笔记。

### 4.6 失败、恢复、fork 和清理

| 条件                                                   | 必须得到的结果                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Notes 缺失、被替代、属于废弃分支、超限，或物化修复失败 | 显式 reset 失败且不改变历史；recorder 健康时，自动/手动压缩走 summary。                                                                                |
| Session 启动时关闭了 recording                         | 使用现有 summary，不绕过用户设置创建 notes/history 存储。                                                                                              |
| Notes 模式启动后 writer 丢失、inactive 或失败          | 保留当前历史，沿既有 session 写入失败语义停止切换；不能用 summary reset 绕过坏掉的 writer。                                                            |
| Notes 和 summary 都无法构造可发送的请求                | 报告既有可恢复 compression failure，保留历史和 notes；不回退到空窗口，也不无限重试。                                                                   |
| Commit 或 Markdown rename 期间进程退出                 | 回放最后完整有效的 canonical record，修复物化文件，并沿用既有 partial-tail/integrity 处理；不能优先采用更新的孤立 sidecar。                            |
| Resume                                                 | 恢复压缩历史、窗口 metadata，以及有效分支上最新的有效 notes。ACP/daemon 的选择性冷恢复也必须读取 notes，不能只改全文件 loader。                        |
| Fork                                                   | 沿既有规则复制 canonical records，保留稳定引用，在目标 session 物化独立 sidecar；写入不能影响父会话。                                                  |
| Rewind                                                 | 使用现有支持的 target，清空 pending reset，使 cursor 失效，并从结果分支重新生成 notes；不能复活 target 之后的笔记，也不放宽现有 compressed-turn 限制。 |
| Archive/delete/retention                               | 通过既有 session maintenance 所有权，与 transcript 一起移动或删除 Markdown sidecar，清理内存 cursor/cache；可重建文件不另设一套 retention 系统。       |

旧 transcript 不含 notes metadata，继续按现有方式回放。
新增 checkpoint 仍包含普通 `Content[]`，较旧 reader 即使不提供 notes 工具，
也能恢复已安装的对话。但不承诺完整的降级兼容：
新 validator 必须认识新 subtype，旧二进制可能报告 diagnostic。

## 5. 集成位置与消费者

| 区域                                                                                                   | 实现要求                                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `config/config.ts`、CLI settings 加载/schema                                                           | 增加并校验 `model.chatCompression.strategy`；把 readiness 绑定到实际 chat，遵循最终工具策略。                            |
| 新增 `services/session-notes-service.ts`、`services/session-history-service.ts`                        | 管理有界 notes 物化和面向模型的有效链查询；复用 recorder/reader，不接 provider 专属后端。                                |
| 新增 `tools/session-context.ts`、`services/session-notes-state.ts`                                     | 添加 schema、注册、code-mode 暴露和 session-bound 执行；核对 tool-name inventory、权限及 plan-mode 消费者。              |
| `core/llm-chat.ts`、`core/client.ts`、`services/chatCompressionService.ts`                             | 主动、自动、手动、hard-limit、reactive-overflow 入口使用一处策略判断和提交路径；保留 reset callback 及 hook 所有权。     |
| `services/chatRecordingService.ts`、`session-writer-lease.ts`                                          | 增加 notes 记录和可等待的 compression commit，复用严格写入、所有权检查和 lease 实现。                                    |
| `transcript-records.ts`、`session-api-history.ts`、`session-transcript-reader.ts`、`sessionService.ts` | 识别 payload，在选择性投影中恢复 notes，验证引用，并覆盖 fork/rewind/archive/delete。                                    |
| Prompt assembly、`core/environmentContext.ts`                                                          | 只在工具可用时提供 notes guidance；识别恢复 prefix，保留 cache/skill/memory 失效语义。                                   |
| CLI Ink/OpenTUI history mapping 和压缩展示                                                             | Synthetic notes 不计入用户 turn；将 notes 换窗口与生成摘要区分展示。                                                     |
| ACP `Session.ts` / `acpAgent.ts`、SDK stream consumers、daemon/Web Shell                               | 消费同一个压缩结果；避免 ACP 先做 summary，随后 `LlmChat` 又做 notes reset；按需通过现有事件传递新增 strategy metadata。 |
| `agents/runtime/agent-core.ts` 和 agent transcript                                                     | 首版明确保留 summary，验证共享配置不能导致访问父 recorder/notes。                                                        |

Strategy 字段缺失时沿用已有 summary/fast marker 行为，
不能把所有旧 `/compress-fast` marker 重新归类为 summary。
不需要重写 provider wire format，也不新增公开 daemon API。
仅供 runtime 使用的 metadata 不进入模型可见的 JSONL 检索结果。

工具注册存在普通、bare-mode 和 execution-environment 三条路径，后两条会提前返回。
每条路径都必须为符合条件的主 chat 安装完整工具组，或者明确保持 summary。
只在普通路径注册工具的实现不满足本协议。

## 6. 决策与取舍

| 决策                                     | 原因                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| 已保存笔记在进展和跨窗口后继续可用       | 覆盖位置记录模型当时所见，之后的工作通过 history 恢复，无需每轮重写 notes。 |
| 单份有界 checkpoint                      | 足以存放目标、状态、下一步和历史引用，避免另做文件管理产品。                |
| Canonical log 加生成的 Markdown          | 既可查看，又能以一个回放权威来源完成分支正确的恢复。                        |
| Reset 时直接注入 checkpoint 正文         | 减少一次恢复工具往返，降低对模型主动读取笔记的依赖。                        |
| 专用且限制作用域的工具                   | 在托管、sandbox 和只读工作区中可用，无需放开任意文件访问。                  |
| 成功 notes 换窗口不再调用最终 summarizer | 由主模型增量维护状态，不必重复摘要完整历史。                                |
| Summary 默认及回退                       | 更改默认前必须测量各模型的 notes 质量与检索行为。                           |
| 初期复用现有阈值                         | 在评估新交接机制时保留已经建立的安全余量。                                  |

## 7. 约束与风险

- 已保存笔记可能遗漏 covered leaf 之后的进展，即使刚写入的笔记也可能写错。Transcript 和精确引用让遗漏有机会被找回，
  但不能保证模型一定会回查。
- 写 notes、查询历史和增加工具 schema 都消耗 tokens。
  仅仅去掉摘要调用，不足以证明总成本或延迟更优。
- 极大的新消息可能直接跳过 warning 区间，因此仍需要 summary rescue。
  不能在上下文已不足以安全发起调用时，还强制模型再写一次笔记。
- Session log 可能包含敏感的用户/工具文本。复用现有本地存储保护，
  将 sidecar 放在 runtime 数据目录并采用受限文件权限。
  不把 notes/history 内容新增到普通 telemetry；已有显式 prompt logging 仍由其设置控制。
- 工具拒绝、模型切换或 writer 丢失会使完整机制不可用。
  必须重新验证工具组，并在失败时保留待处理工作。
- 此功能横跨 core recording、replay 和 tools。
  后续代码应拆成可评审阶段，并遵守仓库的 core maintainer 评审规则。

## 8. 验证与验收标准

E2E 计划和结果位于 `.qwen/e2e-tests/local-notes-compaction.md`，
notes 复用回归计划见 `.qwen/e2e-tests/notes-reuse-after-progress.md`；
确定性的本地模型测试脚本位于 `.qwen/scripts/local-notes-compaction-e2e.mjs`。
实现前已验证全局 CLI 基线；实现后使用本地构建、定向 package 测试、
build 和 typecheck 验证协议与持久化。这些检查不代表模型质量或总成本有改善。

本地检查覆盖连续多次不调用 summarizer 的 notes 换窗口、历史回查、
重启与物化修复、无效 revision 和混合工具响应、设置切换、分支生命周期、
CJK 内容上限、checkpoint 延迟/失败写入，以及失去 lease 后的物化文件保护。
ACP 测试覆盖展开后的输入绑定、命令取消和内置/自定义 `/compress`；
OpenTUI 测试覆盖交付后的 steering 记录与观察。
完整 ACP/Web Shell 会话、其他 provider 协议、进程崩溃注入，以及真实模型的
成对质量/成本评估仍待扩大启用前补齐。下面的证据列表定义这一更广的验收目标。

必须提供以下证据：

1. **不依赖 summarizer 的交接：** 长任务连续跨越至少三个窗口，保留目标和 steering；
   通过 `session_history` 找回刻意未写入 notes 的 identifier/工具结果。
   统计模型请求，证明成功 notes 换窗口不发出 compression side-query。
2. **持久化：** 在 notes/checkpoint 写入与物化 rename 前后注入 inactive writer、
   sync failure、disk-full、partial-tail 和 crash。
   确认未提交候选不会替换当前上下文，重启选择已提交的分支状态。
3. **并发与拓扑：** 普通进展、多次换窗口及冷回放后复用同一 revision。
   验证 pending input 恰好保留一次，预检查不将它标记为已消费。
   覆盖 notes 写入后到达用户 steering、混合并行工具 batch、abort、
   rewind、fork 和 session rotation。拒绝被替代或属于废弃分支的 revision，以及分支失效 cursor；
   父子会话 notes 必须独立。
4. **有界检索：** 覆盖长日志、CJK 密集日志、tool-call/result 配对、大型截断输出、
   不可用媒体/artifact、部分扫描及分页。验证 byte/token 上限，且无废弃分支结果。
5. **协议与界面：** 覆盖 CLI、headless SDK、ACP 和 Web Shell；
   OpenAI-compatible 及其他支持的 provider converter；plan/code mode；
   hooks、手动压缩、自动 trigger、hard/HTTP-overflow rescue、压缩事件和 synthetic-turn
   rewind mapping。子 agent 在现有策略下保持隔离。
6. **兼容：** Summary 默认、recording 关闭、旧 transcript、
   `/compress <instructions>`、`/compress-fast`、managed memory、skills、goals、
   file cache 和截图恢复都保持所声明的行为。
7. **扩大启用前的评估：** 对相同长任务成对比较 summary 模式和新模式的完成率、
   精确约束保留、恢复成功率、总 tokens、耗时、摘要调用数与回退频率。
   记录 notes 质量失败，不能从 tokens 减少直接推断质量提升。

验收要求前六组通过；扩大实验启用范围前必须报告第七组结果。
实现决策变化时，两种语言文档同步更新。

## 9. 交付阶段与开放问题

1. 在 strategy 设置后落地 canonical notes record、严格 checkpoint commit、
   有界 history 读取及分支恢复测试。
2. 接通四个工具、prompt guidance、候选构建、阈值、回退及既有压缩消费者，
   形成一套完整可用、显式启用的功能。
3. 运行成对评估，调整提示词与内部预算；以结果决定是否扩大启用范围。

待评估问题：初始 2,048-token checkpoint 对各模型家族是否足够？
模型以多高频率更新，才能平衡开销与新鲜度？真实 session 规模下，
有界 transcript reader 是否需要可重建的本地搜索缓存？
下一步应优先多文件 notes，还是带独立录制能力的子 agent？
这些问题均不阻塞首版设计。

## 10. 相关 issue 与替代方案

2026-09-19 已搜索 open/closed issues，关键词包括 `compaction`、`notes`、
`compression memory`、`new_context`、`notes context` 和 `笔记 压缩`，
尚未发现覆盖这套完整本地 notes 换窗口方案的 issue。

| Issue                                                                                           | 关系                                                                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [#7021 — Better Context & Memory](https://github.com/QwenLM/qwen-code/issues/7021)              | 上下文与记忆可靠性的总跟踪。                                                          |
| [#10151 — Structured Auto Memory](https://github.com/QwenLM/qwen-code/issues/10151)             | 跨会话知识召回，生命周期与迁移范围不同于当前 session 的工作 notes。                   |
| [#4592 — Summary plus restoration attachments](https://github.com/QwenLM/qwen-code/issues/4592) | 已关闭的前序方案，描述当前压缩组合方式，继续作为回退。                                |
| [#5760 — llama.cpp slot save/restore](https://github.com/QwenLM/qwen-code/issues/5760)          | 特定后端的模型状态复用；本地 notes/history 在跨 provider 的对话层工作。               |
| [#621 — Context management system](https://github.com/QwenLM/qwen-code/issues/621)              | 早期、范围较大的语义裁剪与向量 memory 设想，没有本提案的具体交接协议。                |
| [#8356 — Recording after abort](https://github.com/QwenLM/qwen-code/issues/8356)                | 相关失败报告；readiness 必须由 active writer 和本次实际 append 证明，不能仅依赖配置。 |
