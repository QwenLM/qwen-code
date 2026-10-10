# Daemon UserPromptSubmit 来源信息

[English](daemon-user-prompt-submit-provenance.md) | [简体中文](daemon-user-prompt-submit-provenance.zh-CN.md)

## 问题与证据

main `1919ff97f5` 上的普通 daemon 提问会执行已配置的 UserPromptSubmit hook，但不携带 `submitted_prompt`，因此 Mem0 Auto Recall 返回 `{}` 而不检索。首轮修复从全新非 channel ACP 回合的请求文本推断来源。针对 `2b4f46a` 的评审和失败的 Session/Hook 探针证实，定时任务、子会话派生和 Live task 派发也满足该条件。这些机器组合文本不能默认获得提交来源。

## 范围与归属

保留所属会话的配置、消息总线、cwd、注册信息与环境。在现有客户端、daemon 准入、bridge 与 ACP 子进程边界之间显式传递提交文本。已声明提交复用现有 Channel 录制投影；旧 hook 调用策略、provider 配置、凭证、默认扩展注册和托管记忆召回保持不变。

REST prompt 准入属于 live-session-owner 范围，使用已解析的 owner bridge 和 runtime。ACP HTTP/WebSocket 准入使用已绑定的会话与 bridge。不增加路由，也不引入 primary-runtime 回退。

## 设计

受支持的客户端通过 `_meta["qwen.submittedPrompt"]` 声明原始提交文本。Web Shell 在宿主 `prepareSubmit`、斜杠命令改写及附件展开之前捕获输入框文本。普通队列独立保存原始声明与准备后的 payload。通用 action、定时任务手动运行、重试及服务端恢复的队列不会生成声明。用户从输入框重新提交恢复内容属于新的 Web Shell 提交；本次不增加 core TUI 式编辑器来源跟踪。既有 core TUI 生产方保持不变。Web Shell 普通提交与排队提交均保留既有准入行为。客户端必须在机器生成输入上省略声明。这是逐请求的显式契约，不证明由人撰写，不是身份认证或 DLP。

REST 与 ACP 传输路由读取声明，通过 bridge context 的 `submittedPrompt` 传递。REST channel-worker 请求不会通过该路由获得来源，包括 worker 授权已失效的请求。bridge 从请求中删除公开与私有提交键，仅将 context 中声明的文本重新注入为 `qwen.daemon.submittedPrompt`；具有 worker 分类的 channel 回合和提升为普通回合的 mid-turn 派发省略该字段。内部定时任务、子会话、Live task 及其他自动派发不提供声明。实时语音委派同样省略声明：其请求文本来自模型生成的工具参数，而非独立核实的用户转写。

`sourceType: "channel"` 会话在请求包含文本块、当前回合没有 channel-worker 分类、也没有 worker 显示投影时，可把 context 中声明的非空白 `submittedPrompt` 用作显示投影。有效声明保留原始空白；空白声明与纯附件请求继续从内容取得显示文本。bridge 将原始声明用于排队文本和实时用户回显，并通过既有私有显示文本字段交给持久录制与重放，同时向模型转发完整 prompt。来源标签与声明不授予 worker 权限：不会设置 `qwen.channel.prompt`、绕过循环检测或采信调用方自报的私有显示元数据。REST 请求只要携带 worker 分类、授权或显示键，仍不能回退到提交声明。普通会话的显示行为保持不变。

在 ACP 进程准入处，可信父进程可以提供私有键；直接 ACP 客户端可以通过公开声明逐请求启用，但不能伪造私有键。公开键在准入处消费，不继续传入 Session。可信父进程缺少私有声明时，不能回退到公开键。

Session 仅在全新非 channel 回合且声明为非空白字符串时发出 `submitted_prompt`。缺失、非法、空串或纯空白值均省略字段，不回退到请求文本或 `promptDisplayText`。保留声明中的原始空白。显示投影保留已有录制消费方，但不再建立提交来源。channel 标记同时覆盖自动事件与人工消息，本版本继续排除二者。

保持 `isFreshUserTurn` 和托管记忆召回不变。retry 仍可调用旧 hook，但省略提交来源；continue、恢复提问和 runtime-goal 保留既有 hook 排除条件。工具结果和其他内部重入循环不会创建声明。在模型执行前返回的纯本地 slash command 仍不经过该 hook 路径。

ACP 初始 `prompt` 仍为请求展开前的文本块拼接，并非完整展开后的模型输入。TUI 专属的 Vim、粘贴、历史、撤销与回退规则不会自动适用于 ACP 客户端；各客户端负责所声明文本的来源。

## 消费方与兼容性

hook 管道补充 session/cwd 元数据时保留 `submitted_prompt`。Auto Recall 将其作为查询文本，每个已配置 hook 都可能收到它。默认 Mem0 扩展仍仅提供 MCP，Auto Recall 仍需显式 v3 配置和注册。

Web Shell 为用户提交提供声明。其他 ACP 和 daemon SDK 客户端必须在符合条件的请求上逐次显式启用；没有声明的现有客户端继续调用旧 hook，但不会触发依赖来源的检索。不得在 SDK 传输层或自动派发器中全局添加声明。旧版 daemon 可能忽略这个可选元数据，因此消费方必须继续将缺失视为正常状态。此处调整的是此前未合并实现的资格规则，不改变已发布的默认 MCP 行为。

新获得资格的 ACP/daemon payload 包含 `submitted_prompt`。如果管理员的 hook 会拒绝未知字段，例如使用 `additionalProperties: false`，必须在上线前用新 payload 测试已部署 hook，因为拒绝可能导致失败放行或失败关闭。当前语义见 [UserPromptSubmit](../users/features/hooks.md#userpromptsubmit)；仅为严格解码器说明引用前序设计的 [Compatibility and migration](submitted-prompt-provenance.md#compatibility-and-migration)。其生产方表早于 headless 与 ACP 支持，不是当前资格清单。

Direct Profile 的托管启动器仍仅支持 TTY；字段生产方扩展不会扩大该部署契约。Mem0 v3 profile 仍绑定一个规范化仓库根和 scope。其他 workspace 跳过检索，不增加按 workspace 路由 profile 的功能。清洗、有限超时、失败放行输出和不可信上下文包装保持不变。

## 验证与验收

- 修改前复现无声明非 channel 回合的问题，保留失败断言。
- 在 Session 测试显式、缺失、非法、空串、纯空白、retry、channel 与模型专用输入；移除新的声明判定后，确认省略用例失败。
- 测试准入处对伪造私有键和公开显式启用的处理；确认没有可信 context 的 bridge 请求不能获得来源。附件展开须保留原始文本；模型专用内容不得替换声明。
- 测试已声明 Channel 文本在排队项、实时回显与 ACP 录制元数据中的显示投影，保留完整模型 prompt 且不附加 worker 分类。缺失、非法、空串及纯空白声明、纯附件请求、仅存在于调用方元数据的字段、已分类 worker 回合和普通会话维持原有显示行为；显式 worker 显示投影优先，包括空投影与非空白声明同时存在的情况。
- 使用真实本地 daemon、观察 hook 和受控模型。显式普通提交必须发布声明文本；无标记的机器提交不得发布。验证重新构建的 bundle，不使用旧安装版作为修复证据。
- 执行相关包测试、构建、打包、类型检查、格式检查、lint 和两轮完整自审。在 `.qwen/e2e-tests/` 记录证据，不保存凭证。

## 状态

本次仅涉及显示投影的修正已在 macOS、Node 22.23.1 上通过 ACP Bridge 包全部 2,639 项测试、仓库类型检查、改动文件 lint 与格式检查、构建及打包。独立验证通过十项 bridge 场景，以及十九项真实本地 daemon 断言，覆盖实时展示、持久用户与回合结果记录、冷进程 `/load` 与 transcript 重放、完整准备后的模型输入及循环检测。隔离执行的 `??` 改为 `||` 变异会使空 worker 投影控制用例失败。daemon 使用合成消息、隔离运行状态及模拟模型；这些结果不代表外部网关或已部署服务验收。证据保留在 `.qwen/e2e-tests/pr-13748-*` 与 `.qwen/issues/pr-13748-review.md`。

原实现 `4fb7d2f0a9` 通过了 869 项 Session 测试，以及本地与真实 Holo 各四项场景。这些结果早于显式声明修正，不能用作该修正的验证证据。两条合成 Holo 记录均已删除。记录直接通过 Holo 创建和删除，模型由本地控制，workspace B 验证的是排除而非第二个 profile。评审修正的复现与验证单独记录在 `.qwen/issues/pr-11455-provenance.md`。
