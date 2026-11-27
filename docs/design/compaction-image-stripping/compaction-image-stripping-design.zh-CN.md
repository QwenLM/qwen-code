# 压缩输入图片剥离 + Token 估算修复

[English](compaction-image-stripping-design.md) | [简体中文](compaction-image-stripping-design.zh-CN.md)

## 问题陈述

`ChatCompressionService` 触发（自动或手动）时，会把 `historyToCompress`
原样发给摘要模型。两个相关问题损害质量、准确性与成本：

1. **内联图片 / 文档字节泄入摘要提示词。** 呈现附件（截图、设计稿、
   PDF）的 MCP 工具把 `inlineData` 部件直接放进对话。压缩管线不剥离
   它们，摘要模型收到通常无法解释的原始 base64，侧查询载荷被无谓
   放大。

2. **`findCompressSplitPoint` 对二进制部件的 token 估算错误。**
   切分点算法用 `JSON.stringify(content).length` 在历史间分摊字符。
   一张 1 MB 的 base64 图片（约 140 万字符）让一个条目看起来像
   ~35 万 token，淹没真正的文本，把切分偏向错误位置。Qwen-VL 图片
   的真实 token 成本最多几千。估算器应把二进制部件当作小常数。

claude-code 用 `stripImagesFromMessages` 解决（1）。qwen-code 既没有
这个剥离，也没有对应的字符计数修复。

本变更同时补上两者，作用域**仅限压缩侧查询输入**。活跃对话历史、
持久化（`chats/<sessionId>.jsonl`）、下一回合发给主模型的提示词都不
受影响。瘦身只作用于 `chatCompressionService` 内部构建的侧查询载荷。

### 范围之外（推迟或否决）

- **大段粘贴外置到粘贴缓存。** 早期草案曾提议把超长文本哈希进
  `~/.qwen/paste-cache/<sha>.txt` 并替换为占位符。在调研 claude-code
  2026-03 至 2026-05 的发布后我们否决了它：上游方向是保持用户输入对
  模型可见，并通过提示词缓存（1 小时 TTL 旋钮、图片降采样）摊薄成本，
  而非外置。把逐字用户输入藏到哈希占位符后面，一旦压缩把原文折叠
  掉，就有"意图漂移"风险。若将来重访，正确形态是 `read_paste(hash)`
  这样的真实工具，而非静默改写。

## 现状 vs 目标

| 关注点                  | qwen-code 现状                        | claude-code 参考                                          | 本变更后的目标                                                          |
| ----------------------- | ------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| 压缩提示词中的图片/文档 | 原样发送                              | `stripImagesFromMessages` 替换为 `[image]` / `[document]` | 以 `[image: mime]` / `[document: mime]` 占位符发送                      |
| 二进制部件 token 估算   | `JSON.stringify().length`（严重失真） | 按固定预算处理                                            | 可解析的静态图片按分辨率推导；动画与不可解析载荷保 1,600 token 平价回退 |
| 微压缩图片清理          | 不触碰（空闲时只清文本工具结果）      | 时间触发 MC 全清                                          | 微压缩在清理工具结果的同时清理过期内联图片                              |

## 提议的变更

### 第 1 层：压缩输入瘦身（`services/compactionInputSlimming.ts`）

一个新纯函数模块：接收 `Content[]`，返回瘦身后的 `Content[]`。一种
变换：内联媒体剥离。遍历每个 `Part`。若部件带 `inlineData` 或
`fileData`，替换为 `[image: image/png]`（或 `[document: application/pdf]`)
形式的 `text` 部件。

qwen-code 把工具返回的媒体挂在 `functionResponse.parts`（对标准
`@google/genai` `FunctionResponse` 模式的扩展；见
`coreToolScheduler.createFunctionResponsePart`）。瘦身器递归进该嵌套
数组，因此 `read_file` 或任何输出附件的 MCP 工具返回的 base64 图片
也会被替换。

变换返回全新的 `Content[]` 数组；原数组绝不改动。若变换产生零更改，
则原样返回原数组引用（同一性相等）。编排方在
`chatCompressionService.ts` 中于 `runSideQuery` 之前的最后一步调用
`slimCompactionInput`。

### 第 2 层：token 估算修复（`chatCompressionService.ts`）

`findCompressSplitPoint` 目前用 `JSON.stringify(content).length` 做字符
分摊。替换为 `estimateContentChars` 助手：

- `text` 部件：`text.length`
- 带可解析静态图片头的 `inlineData` 部件：分辨率推导的 token 估算
  × 4（见决策 1）。动画载荷（GIF、APNG、动画 WebP）与不可解析的
  `inlineData` / `fileData` 部件保持 `imageTokenEstimate * 4`（默认
  1,600 × 4 = 6,400 字符）。
- `functionCall` / `functionResponse` 部件：
  `JSON.stringify(part).length`（行为不变）。

这与瘦身模块使用的常数同源，切分点算法看到的预算与瘦身后的提示词
下游实际消耗一致。为避免重复遍历，`compress()` 一次预计算
`charCounts` 并传给 `findCompressSplitPoint`（新的可选第 4 参数）；
同一数组复用于 `MIN_COMPRESSION_FRACTION` 门禁。

### 第 3 层：微压缩图片清理（`microcompaction/microcompact.ts`）

`collectCompactablePartRefs` 现在返回三组：

- `tool` —— 可压缩内建工具的 `functionResponse` 部件。整组清除：
  响应输出替换为哨兵，`functionResponse.parts` 随之丢弃。
- `media` —— 用户角色消息下的顶层 `inlineData` / `fileData` 部件
  （例如经 `@reference` 粘贴的图片）。替换为
  `[Old inline media cleared: <mime>]`。
- `nested-media` —— **不可压缩**工具（例如名字不在 `COMPACTABLE_TOOLS`
  里的 MCP 截图工具）在 `functionResponse.parts` 扩展字段上携带图片/
  文档的 `functionResponse` 部件。只丢弃嵌套媒体；工具的文本输出保留。

每类有各自的 `keepRecent` 预算。设 `toolResultsNumToKeep: 1` 保留每类
最近一条（1 tool + 1 media + 1 nested-media），而不是合并列表总共 1 条。

来自 MCP 工具服务器的 mimeType 值在嵌入任何占位符字符串前先过
`sanitizeMimeForPlaceholder`。瘦身器与微压缩共享该助手。

### 第 4 层：配置（`config/config.ts`）

`chatCompression` 设置下新增一个字段：

```json
{
  "chatCompression": {
    "contextPercentageThreshold": 0.7,
    "imageTokenEstimate": 1600
  }
}
```

外加运维/调试用的环境变量覆盖：`QWEN_IMAGE_TOKEN_ESTIMATE`。

## 关键设计决策

**决策 1（修订）：静态图片默认按分辨率计价；1600 平价下限是回退，
不是模型。** 本设计最初把每张图片按 1,600 token 平价计价，刻意偏高
——高估导致更早压缩（安全），低估导致更晚压缩（不安全）。经维护者
批准的修订（#17321）在可解析的静态图片上替换了它：估算采用 omni
管线已在用的 patch-grid 公式 `ceil(width × height / (32 × 32 × 2))`，
小截图与 4K 图不再同价。记录在案的取舍：小静态图现在计价低、可能
更晚压缩——被接受为有意的修正而非回归；对应的配重是字符分摊采用
`max(resolution, floor)` 而非回到平价分支，4K 图片仍按其完整分辨率
费用计价。动画载荷（任何 GIF、APNG、动画 WebP）与不可解析二进制在
帧计数落地前保持平价 `imageTokenEstimate`——60 帧 GIF 按静态公式计价
会造成约 27 倍的不安全方向低估。显式配置的估算
（`QWEN_IMAGE_TOKEN_ESTIMATE` 或 `chatCompression.imageTokenEstimate`
设为默认以外的任何值）是覆盖，取代两条路径。对非 VL 模型
（Qwen3-Coder，qwen-code 默认）该估算只影响 token 估算正确性——
图片本来就到不了模型。

**决策 2：剥离瘦身副本，不动活跃历史。** `slimCompactionInput` 返回
新数组；`GeminiChat` 存储的聊天历史不被触碰。本地持久化
（`.chats/<sessionId>.jsonl`）保留用户经历过的完整对话，`--resume`
无损可用。

**决策 3：微压缩把图片与旧工具结果同等对待。** 基于时间的空闲触发
已在清理过期工具输出；扩展到内联图片保持策略一致，并复用现有
keepRecent 窗口。

**决策 4：不做粘贴存储 / 不做文本外置。** 见"范围之外"。上游共识
（claude-code 2026-03 → 2026-05）是保持逐字用户输入可见、经提示词
缓存摊薄，而非外置。

## 涉及文件

**新文件**

- `packages/core/src/services/compactionInputSlimming.ts`
- `packages/core/src/services/compactionInputSlimming.test.ts`

**修改文件**

- `packages/core/src/config/config.ts` —— 扩展 `ChatCompressionSettings`
- `packages/core/src/services/chatCompressionService.ts` —— 在
  `runSideQuery` 前调用瘦身；替换字符计数助手；为切分器 + 门禁一次性
  预计算 charCounts
- `packages/core/src/services/chatCompressionService.test.ts` —— 加
  接线测试断言 base64 不会到达摘要模型
- `packages/core/src/services/microcompaction/microcompact.ts` ——
  收集扩展到内联图片
- `packages/core/src/services/microcompaction/microcompact.test.ts` ——
  测试图片清理

## 范围边界

**范围内**

- 从压缩输入剥离内联媒体
- 修复 `findCompressSplitPoint` 字符估算
- 空闲触发上的微压缩图片部件清理
- 一个设置 + 环境变量覆盖

**推迟**

- 大段粘贴外置（见上文"范围之外"）
- 回充工具（`read_paste(hash)` 等）
- 持久层去重
- `/context` 粘贴细分
- 瘦身统计遥测事件

## 待定问题

1. **占位符文本是否应包含哈希以支持将来回充？** 目前只发
   `[image: image/png]`。若将来出现 `read_paste` 类工具，可能需要 ID。
   现在占位符只是信息性的；原图仍在活跃历史与持久化中。
2. **经 Anthropic / OpenAI 代理服务的非 Qwen-VL 模型，平价 1,600
   合适吗？** 对 Claude（图片最多约 5K token）可能略低估但无害：
   它只影响切分点启发式，从不影响面向用户的模型实际看到的提示词。
3. **`MIN_COMPRESSION_FRACTION` 门禁按瘦身前字符数计算。** 图片密集
   的切片可过 5% 阈值（估算器里每张图按 ~6,400 字符计），瘦身后缩成
   `[image: …]` 占位符。摘要模型于是几乎收不到文本上下文。目前是有意
   为之：摘要的职责是记录"用户分享了 X 的图片"，即使切片大部分是
   视觉内容；门禁的目的是"是否有值得摘要的内容"——图片合理满足。
   若质量回退，可重访：瘦身后复查，或按 `imagesStripped` 比例偏置门禁。
