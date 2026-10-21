# 第三轮 system prompt 精简

[English](2026-09-26-system-prompt-third-pass.md) | [简体中文](2026-09-26-system-prompt-third-pass.zh-CN.md)

## 问题与范围

第二轮（#12546）有意推迟的两处重复仍在：

1. **Todo 指导表述了三遍。** `todoWriteEnabled` 时，`## Software Engineering Tasks` 的 `Plan` 条目、`## Using Your Tools` 的 `Task Management` 条目（两种调用约定都有）、以及 `# Task Management` 小节各自重复同一组规则：何时用（"复杂、模糊或多步骤"）、何时不用（"简单或单步工作，除非用户明确要求"）、清单质量（"简短、面向结果、保持最新"）。只有小节带有独有的操作规则（最多一个 `in_progress`、`todo_id` 委派、不用散文复述清单、状态更新合并成一次调用）。
2. **`Comments` 条款过度规约。** "Do not narrate what the code does" 是 "Default to none" 加 why-only 判据的推论；"NEVER talk to the user or describe your changes through comments" 与 `Tools vs. Text` 条目（"text output _only_ for communication. Do not add explanatory comments within tool calls or code blocks"）重叠。

本轮仅修改 prompt 文本及其测试。公共 API、模型族路由、按声明门控（`TOOL_GUIDANCE_LINE_GATES` 的每个行前缀、每个小节标题、测试钉住的 `# Task Management` 小节文本均逐字保留）、两种调用约定、所有安全小节，全部不变。

## 修改内容

- **Plan 条目（Todo 变体）。** 压缩为只点名工具和跳过规则："Track complex, ambiguous, or multi-step work with `todo_write`; skip it for simple tasks unless the user explicitly requests a plan." 何时用/怎么用的清单规则只保留在 `# Task Management`。
- **Adapt 条目。** 删除 "If a todo list exists, keep it current as the scope or approach changes."——小节已要求 "Keep the list current … revise it when the scope or approach changes."。
- **Task Management 条目（两种调用约定同步）。** 压缩为指针："Use `todo_write` to keep user-visible progress on multi-step work; `# Task Management` governs its use." 受门控的行前缀 `- **Task Management:**` 不变，按声明门控行为完全一致。
- **Comments 条款。** 压缩为："Default to none. Add one only when the _why_ cannot be conveyed through naming or code structure — a hidden constraint, a subtle invariant, or a workaround for a specific bug. Do not edit comments that are separate from the code you are changing."

与第二轮同样如实声明：本轮**不是行为策略中性的**——"Do not narrate what the code does" 和显式的 "NEVER talk to the user or describe your changes through comments" 是有意从 `Comments` 条款删除的约束，依据是 `Tools vs. Text` 条目已覆盖，而非移动到 prompt 其他位置。

## 理由与调用方

入口仍是 `getCoreSystemPrompt`；调用方（主会话客户端、Arena worker）与 `/context` 口径不变。Todo 部分的节省只作用于 `todoWriteEnabled` 的会话（非默认），所以降幅集中在 `+ todo` 测量行；`Comments` 压缩作用于所有变体。

## 验证与验收

- `packages/core`：prompt 测试与再生成的快照（仅含预期文本变化），外加 prompt-tool-examples、client、Arena 测试。
- `packages/cli`：context 命令测试。
- 构建、typecheck、改动文件的 Prettier/ESLint。
- 五个模型族在 interactive、headless、ACP 三种模式下均正常渲染，覆盖 CodeModeOnly。
- 前后大小在相同输入下对渲染出的基础 prompt 实测（interactive、Git 环境、无 sandbox、无 style/context），以 `o200k_base` 作为统一文本标尺；不是 provider 计费口径，也不证明任务成功率变化。

## 风险与后续

压缩后的措辞仍可能改变模型行为；结构化测试不能证明任务成功率不变。覆盖前两轮的外部成对评测未包含本次文本；若其报出回退，指针式条目是首要恢复候选。本轮之外的已知余项：按能力装配（会话没有的 skill/工具不注入相应指导），以及 #12054 跟踪的工具描述块。
