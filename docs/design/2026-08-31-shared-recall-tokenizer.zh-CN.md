# 共享召回分词原语

[English](2026-08-31-shared-recall-tokenizer.md) | [简体中文](2026-08-31-shared-recall-tokenizer.zh-CN.md)

## 背景

Core 自动记忆召回与 Channel 记忆召回分别实现了 NFKC 标准化、小写转换，以及面向 CJK
文本的 Unicode code point 二元组生成。两份相同机制独立存在，会导致未来修改后，等价的
记忆文本可能在两条路径中得到不同的标准化或切分结果。

除此之外，两侧调用方并不等价。它们的 token 策略和选择算法存在有意保留的差异，必须
继续由各自调用方维护。

| 行为                 | Core 自动记忆                                          | Channel 记忆                 |
| -------------------- | ------------------------------------------------------ | ---------------------------- |
| 不安全不可见字符处理 | 保持不变                                               | 替换为空格                   |
| CJK 连续片段         | Han、Hiragana、Katakana 和 Hangul 可以组成一个连续片段 | 每种 script 分别形成连续片段 |
| 其他 script          | Unicode 字母、mark 和数字                              | Latin 字母和十进制数字       |
| Latin/数字最小长度   | 三个 code point                                        | 两个 code point              |
| Latin 与数字         | 可以组成同一个 token                                   | 分别生成带 namespace 的 term |
| CJK term             | 原始二元组                                             | 带 script namespace 的二元组 |
| Token 上限           | 最前 32 个和最后 32 个唯一 token                       | 无上限集合                   |
| 匹配方式             | 用查询 token 匹配标准化后的文档子串                    | 消息与条目的精确 term 交集   |

## 目标

- 共享 NFKC 加小写转换的标准化原语。
- 共享相邻 Unicode code point 二元组生成逻辑。
- 在每个调用方保留包装现有策略的薄分词适配器。
- 保持当前所有 term、分数、顺序规则、限制和 fallback 不变。

## 非目标

- 统一两侧 token 集合。
- 修改召回排序、打分、限制或 fallback 行为。
- 增加配置项或分词器框架。
- 重新设计记忆存储或上下文组装。

## 方案

通过 channel-base 的窄子路径导出两个无副作用的帮助函数：

- `normalizeRecallText(text)` 返回 `text.normalize('NFKC').toLowerCase()`。
- `codePointBigrams(run)` 按 Unicode code point 而不是 UTF-16 code unit 遍历，并依次
  生成每一对相邻字符。

Core 保留组合式 CJK 连续片段表达式、Unicode 非 CJK token 策略、去重逻辑和 64-token
首尾上限。Channel 记忆保留不安全不可见字符清理、按 script 划分的表达式、namespace、
最小长度和无上限 term 集合。这些现有的调用方函数就是薄适配器，无需引入新的类或配置层。

当前选择的 package 归属是无副作用的
`@qwen-code/channel-base/recallTokenizer` 导出。Channel-base 不能依赖 core，因为 channel
插件有意只把 channel-base 作为其唯一的 Qwen Code 依赖。反向依赖不会形成源码循环，也
避免增加新的可发布 package。它要求 channel-base 在 core 之前完成构建，并将
channel-base 声明为 core 的测试前置条件。workspace 依赖会让 pnpm 自动按照该顺序调度，
因此无需手工修改构建顺序。

我们也考虑了独立共享 package。它可以避免让基础层 core package 依赖适配层 package，
但会为了两个小函数增加构建、lockfile、发布、发布顺序和版本管理表面。本 PR 选择更窄的
channel-base 子路径；该 package 边界仍需维护者批准。

Issue #9377 的早期 triage 将这个选择留给实现者，并把当前依赖方向列为自然选项。此后，
PR triage 已将最终 package topology 上报给维护者审批。如果维护者不接受这一分层方向，
可以把帮助函数移动到独立共享 package，而无需修改两侧调用方适配器及其
characterization tests。

## 下游消费者

Core 自动记忆通过 `MemoryManager.recall` 进入 `QwenClient` 的托管召回路径，用于组装
初始上下文和工具结果上下文。Channel 记忆通过 `ChannelBase` 的选择与 prompt 格式化路径；
`PollingChannelBase` 以及 DingTalk、DWS、Feishu、GitHub、GitLab、QQBot、Telegram、
WeCom、Weixin 和 plugin-example 适配器都会消费该路径。

因此，本次重构必须保持以下公开选择函数不变：

- `selectRelevantAutoMemoryDocuments`
- `selectRelevantChannelMemory` 及其 prepared-index 变体

## 验证

Characterization tests 在抽取前固定两侧有意保留的差异，包括跨 CJK script 连续片段、
字母与数字混合、非 Latin script、NFKC 输入，以及仅存在于 core 的 token 上限。原语测试
覆盖空输入、单 code point、BMP 和 supplementary-plane 输入。

抽取完成后，运行 core 与 channel 的定向 recall 测试套件，然后运行仓库 build 和
typecheck。这是保持行为不变的内部重构，因此模型可见输出或 TUI E2E 流程不应发生变化。
