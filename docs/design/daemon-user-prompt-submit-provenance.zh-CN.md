# Daemon UserPromptSubmit 提交来源

[English](daemon-user-prompt-submit-provenance.md) | [简体中文](daemon-user-prompt-submit-provenance.zh-CN.md)

## 问题与证据

在 main `1919ff97f5` 上，普通 daemon 提问会执行管理员安装的 UserPromptSubmit hook，但 ACP 输入只有 `prompt`。Mem0 Auto Recall 要求 `submitted_prompt`，所以真实 daemon 探针返回 `{}`，未发出 provider 请求，也未注入记忆。显式 MCP 搜索、写入和删除已通过独立 Holo 回归。

## 范围与归属

本次在 ACP 会话执行路径补充已有的可选 hook 字段。所属会话的配置、消息总线、cwd、hook 注册和环境仍是权威来源。不修改 daemon 路由、线上协议字段、provider 配置、凭证处理或默认扩展注册。改动适用于使用该会话路径的 ACP 宿主，包括 daemon，并非仅限 daemon。

## 设计

在 slash command、资源及模型专用提示词展开前捕获提交文本。存在已有可信 `promptDisplayText` 投影时优先使用它，否则用空格连接 ACP 请求中的文本块，与 headless 文本投影一致。保留原始空白。显式空的显示投影不能回退到内部 channel 指令。

仅当已有 `isFreshUserTurn` 分类为真且捕获的文本非空白时添加 `submitted_prompt`。保持旧 `prompt` 值及已有 hook 执行策略不变。重试仍可执行旧 hook，但不携带提交来源；continue、恢复提问和 runtime goal 回合保留现有 hook 排除规则。工具结果、Stop hook 及后台重新进入执行循环不会产生新的提交文本。在模型执行前就返回的本地 slash command 仍不经过这条 hook 路径。

不得把资源正文、图片或音频内容、模型专用委派、展开后的 slash command 内容或前序 hook 输出投影到新增字段。ACP 文本块表示宿主提交的文本，不证明由人撰写；该字段不是身份认证或 DLP 边界。可信显示投影已经在 daemon、bridge 和 ACP 准入边界过滤，本次不增加调用方可控制的 metadata 覆盖机制。

## 消费方与兼容性

已有 hook 管道在补充 session/cwd 元数据时保留该字段。Mem0 Auto Recall 将其作为搜索查询来源，其他已配置 hook 也可读取。默认 Mem0 扩展仍仅提供 MCP；管理员必须显式注册 Auto Recall 并提供 v3 配置。已启用该配置的 daemon 启动器在修复后将开始执行符合条件的搜索，因此现有凭证和仓库绑定应符合管理员意图。

单个 v3 Auto Recall profile 仍绑定一个规范化仓库根和一个 scope。位于该根之外的第二个 workspace 必须跳过检索；本次不添加按 workspace 路由 profile 的功能。现有清洗、有限超时、失败放行和不可信上下文包装均保持不变。

## 验证与验收

- 使用真实 daemon 及观察 wrapper，将 hook JSON 原样传给已打包的 Auto Recall，复现问题；不伪造提交字段。
- 单测固定普通及多个文本块、非文本附件、可信模型专用内容、包含空文本的显示投影、空白输入、重试和续跑行为。
- 重新构建后，普通 daemon 提问必须只调用本地 provider 一次，将合成记忆注入实际模型输入，且不配置搜索 MCP 工具。工具续接不能触发第二次搜索。配置仓库之外的 workspace 不得注入记忆。
- 用隔离 Holo 记录验证新会话自动召回、workspace 排除，以及删除后新会话没有被删记录而保留控制记录。只清理本次创建的合成记录并核实清理结果。
- 执行变更包测试、构建、类型检查和定向 lint，审查完整 diff。将实测结果记录在 `.qwen/e2e-tests/`，不保存凭证。

## 状态

已于 2026-09-09 在 `1919ff97f5` 加本次工作区改动上实现并验证。全局 CLI 与修复前 daemon 探针均复现缺少字段的问题。869 项会话测试全部通过，构建、打包、类型检查、lint 和格式检查通过。本地与真实 Holo 验收各四项全部通过，均使用新会话并断言实际模型输入。两条合成 Holo 记录均已删除并确认不存在。

模型在本地受控，daemon、hook 和 Holo 搜索均真实执行。本轮针对 hook，直接通过 Holo 创建和删除测试记录；显式 MCP 写入和删除已在独立验收中验证。本地 provider 请求次数经过计数；云端验证记录了每回合一次 hook 执行，但未独立统计 hook 子进程的 HTTP 请求次数。Workspace B 被配置的仓库绑定排除，并非路由到第二个 profile。证据记录在 `.qwen/e2e-tests/holo-auto-recall-fix-20260909-report.md`。
