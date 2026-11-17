# 提示词上下文的位置

[English](2026-11-04-prompt-context-placement.md) | [简体中文](2026-11-04-prompt-context-placement.zh-CN.md)

**状态：** 已实现

**Issue：** [#16259](https://github.com/QwenLM/qwen-code/issues/16259)

## 问题

用户提交了一条完整的 2461 字符任务，包含 7 个编号步骤。模型回复"目前还没有收到
具体任务"，其 thinking 原文是"The user only provided a system reminder about
available skills ... no specific task."

指令完整送达了服务商，但它的位置在组装过程中没有保住。一次新轮次的 user 条目由
若干独立来源拼成：

1. 每轮的 `<system-reminder>` 分片，前置在正文之前（plan mode、arena、输出风格、
   workflow mode、一次性通知、召回的记忆）。
2. 用户自己的分片。
3. 承载 hook 与 Mod 上下文的 `<qwen:user-prompt-submit-context>` 块，追加在正文
   之后。
4. 记忆目录快照，再追加在其后。

于是真实指令落在条目中段，两侧都是注入上下文。三个各自独立的上限
（`MAX_SKILL_LISTING_CHARS = 8000`、每个索引 `MAX_INDEX_CHARS = 25_000` 且会注入
两个索引，加上无上限的 hook 上下文）让包围它的块可以达到几十 KB，此时 flash 级别
的模型只读到这些信封，漏掉了任务。

## 设计

重排外发请求，让用户自己的正文成为该轮次的最后一段内容。
`LlmChat.getRequestHistoryForRoute()` 本就产出仅用于请求的历史副本；新增的
`movePromptContextAheadOfUserText()` 在该副本上运行，把尾随在用户正文之后的注入
块整体移到正文之前。

注入分片的识别依据是：被 `<system-reminder>` 包裹、是完整的
`<qwen:user-prompt-submit-context>` 块，或带有 `AUTO_MEMORY_SNAPSHOT_METADATA`
标记。其余一律视为调用方自己的内容，保持相对顺序。

只搬动位于调用方**最后一个**自有分片之后的连续注入区段。该过程只向前回溯一段
连续的自有分片，因此调用方放在自己两个分片之间的提醒会成为该区段的边界，保持
原位。

有三类情况原样保留：

- 前导的 `functionResponse` 分片。`tool_result` 块必须紧跟模型的 `tool_use`；
  Anthropic 兼容后端会拒绝排在它之前的文本。
- 不在前导区段内的 `functionResponse`。那个位置属于调用方自己的排序，因此整条
  条目原样返回，而不是把工具结果提到最前。
- 从第一个 `REATTACH_BOUNDARY_METADATA` 标记起的易变尾部。它是一个连续区域——
  一个标记，随后每张回放图片各有一个标签和一张图片——各服务商的缓存处理会把它按
  尾部块计数，从而把每轮断点放在它之前（#11627）。拆开或搬走它会让断点落在后续
  请求不再包含的块上。

## 设计决策

**只改请求，不改历史。** hook 块位于尾部这一点对已存历史是有承载作用的。
`projectUserTranscriptForDisplay()` 把完整的末尾 tagged 分片当作 `displayText`
的配对证据，`restoreUserPromptSubmitContextReceipt()` 在 resume 时也只对最后一
个分片重新盖章。重排已存条目会破坏展示投影，并让已投递的 hook 上下文每轮重复
投递。因此只改请求副本，transcript、resume、去重与 rewind 的契约都不受影响。

**重排作用于每条 user 条目，而不只是待发送的那条。** 下一轮请求会从已存历史里
重新发送上一轮的条目；只重排待发送条目会让一条条目的线上形状取决于它的位置：
第 N 轮发出 `[提醒, hook, 目录, ...正文]`，第 N+1 轮却把同一条目重建成
`[提醒, ...正文, hook, 目录]`。两次请求的公共前缀就只到开头的提醒为止，注入块
每轮都要按全价重新 prefill——这正是 `REATTACH_BOUNDARY_METADATA` 要防止的失效
模式（#11627）。对请求副本里每条 user 条目套用同一条规则，条目的线上形状就与
位置无关，第 N+1 轮请求严格扩展第 N 轮的前缀。已存历史仍然不动。

**在发送边界统一处理，而不是逐个生产者修改。** 提醒、hook 上下文、IDE 上下文和
目录由不同模块在不同前端（TUI、headless、ACP、共享 agent loop）注入。在每轮主
请求组装的唯一位置修正顺序，可以一次覆盖全部路径，避免四处并行修改后各自漂移；
只有一个消费方绕过该位置、必须自己调用这次重排：压缩侧查询的 `promptCacheSharing`
载荷在 `chatCompressionService.ts` 里由 `getHistoryShallow(true)` 构建，因此它
重排自己那份副本，而冷路径与压缩后的图片恢复正常仍读取已存顺序。

**不改预算。** 本次只处理位置。跨注入块的总量上限、把目录彻底移出 user 尾部，
以及 always-on-context 告警对中文 token 的低估，仍是独立工作（#16184、#14976）。

## 约束

- 分片全为工具结果、全为注入上下文，或顺序本已正确的轮次，原样返回。
- 判定覆盖整条 entry，这正是移动区段能被界定的原因：只有「caller 最后一个自有
  分片之后」连续的那段注入内容会被前移；因此 caller 自撰、形似两种信封之一、并
  位于结尾的分片会被当作注入内容，移到 caller 正文之前。
- 侧查询（调用 `getRequestHistoryForRoute` 时没有待发送 user 轮次）不受影响。

## 验证

- 一条多分片提示词，带前导提醒、尾随 hook 块和目录快照，外发顺序为
  `[提醒, hook, 目录, ...正文]`，而已存历史仍是 `[提醒, ...正文, hook, 目录]`。
- 工具结果轮次保持 `functionResponse` 在最前，reattach 区域（标记、标签、图片）
  完整且位于最后。
- 没有注入分片的提示词保持原有分片顺序。
- 调用方放在自己两个分片之间的提醒保持原位；只有最后一个自有分片之后追加的块
  会移动。
- 压缩侧查询的 cache-sharing 载荷携带同一份重排后的条目，从而复用主请求刚预热
  过的前缀，而冷路径与压缩后的图片恢复正常仍读取已存顺序
  （`packages/core/src/services/chatCompressionService.test.ts`）。
- 这个辅助函数本身由 `packages/core/src/core/prompt-context-order.test.ts` 直接
  钉住，包括「分片全为工具结果」的那条条目。
- 既有的目录预算、去重与缓存边界断言仍然成立。三处固定旧顺序的断言已更新：
  待发送轮次的检查改为断言目录存在且用户正文在最后；持久化恢复的检查改为断言
  请求与历史持有相同的条目和分片，只是目录被移到了恢复提示词之前；多轮前缀的
  检查改为每一轮请求与上一轮请求比较。前缀检查无法保留原来的形式——重排之后
  待发送条目本就不再等于它的已存形态，所以「请求 vs 已存历史」不再成立。注入
  分片是否存在仍然有人兜底——由上面两处检查，以及多轮测试自己的快照数量断言，
  而不是由前缀比较负责。

`packages/core/src/core/llm-chat.test.ts`：720 项通过。

## 待定问题

目录是否应该留在 user 条目内，以及每轮注入块应共享怎样的总量预算与淘汰顺序，
另行跟踪。
