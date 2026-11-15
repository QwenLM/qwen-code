# Daemon PR watch：提示词语言

[English](2026-11-15-daemon-pr-watch-drain-language.md) | [简体中文](2026-11-15-daemon-pr-watch-drain-language.zh-CN.md)

状态：提案（2026-11-15）

## 问题

即使运维者的 UI 语言是中文，daemon 的 PR 状态监视仍以英文投递绑定事件提示词。channel 车道已在 #16773 本地化，共享构造器自那时起就带有按语言的信封、角色指引表与文案映射，但 daemon 生产方从不传语言：`PrWatchDrainDeps` 未声明 `language` 成员，`buildDrainPrompt` 调用 `buildBoundEventPrompt` 时不带它，而四处转换摘要在 observation 生产方里是英文字面量。因此今天一个带事件订阅的 zh 部署收到的是英文 daemon 提示词。

[绑定会话事件提示词语言](2026-11-09-bound-event-prompt-language.zh-CN.md) 的决策 7 把这件事记为仍欠着、而非已排到别处：启用增量（#17032）落地时没有穿它。本增量把它穿上。

## 现状

| 表面                                                                      | 位置                                                                            | 今天的语言                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 信封措辞（头部、告示、工作流句、截断标记）                                | `packages/channels/base/src/bound-session-prompt.ts`，`BOUND_ENVELOPE_COPY`     | 已本地化；drain 不传 `language`，因此解析为 `en`               |
| 内置角色指引                                                              | 同文件，`DEFAULT_BOUND_ROLE_GUIDANCE_BY_LANGUAGE`                               | 已本地化；drain 索引的是仅英文的 `DEFAULT_BOUND_ROLE_GUIDANCE` |
| 来源说明行                                                                | `packages/cli/src/serve/server/pr-watch-drain.ts`，`buildDrainPrompt`           | 硬编码英文字面量                                               |
| 转换摘要（`head_change`、`ci_failure`、`merge_conflict`、`state_change`） | `packages/cli/src/serve/server/pr-watch-observation.ts`，四处 `summary:` 字面量 | 硬编码英文，持久化进 `pending[].summary`                       |
| locale 解析                                                               | `packages/cli/src/commands/channel/runtime.ts`，`resolveChannelLocale`          | 已存在，仅 channel worker 使用                                 |

## 目标

- `general.language` 解析为 `zh` 的 daemon，投递的绑定 PR-watch 提示词其信封措辞、角色指引、来源说明与转换摘要均为中文。
- `en`（或未设置、或无法识别）的语言保持今天的输出**逐字节不变**。
- pending 事件保留其检测时的语言，与 channel 车道的决策一致。
- 不改 store 结构，不改任何转换 key。

## 非目标

- 运行时语言切换。locale 在 daemon 启动时读一次，与 channel worker 在启动时读取完全一致。
- 本地化运维模板。`sessionPrWatch.actions` 的值按运维者书写的语言逐字渲染。
- 本地化 channel 的评论车道，#16773 已覆盖。
- 结构性标记。字段标签（`Repo:`、`PR:`、`Event:`、`Summary:`）、trusted-instruction 标签与 `Source:` 行在每种语言下都保持英文，这是共享契约的要求。

## 拟议改动

### 一个 locale，在启动时解析

`run-qwen-serve.ts` 在既有 `resolveSessionPrWatchConfig` 调用旁解析 `resolveChannelLocale(bootSettings?.general?.language)`，并把它带进 `prWatchSources`。两个接缝读同一个值，因此 observation 与 drain 对同一个事件的语言绝不会不一致。

### observation 在检测时本地化摘要

`PrWatchObservationTickDeps` 增加 `language?: BoundPromptLanguage`。四处 `summary:` 字面量改为按语言渲染，因此持久化的 `pending[].summary` 已经是检测时的语言。这正是 pending 事件能跨重启或跨后续 locale 变更保留其检测语言的原因，也是不往 store 增加结构化字段的原因。

### drain 本地化它在投递时组装的部分

`PrWatchDrainDeps` 增加 `language?: BoundPromptLanguage`。`buildDrainPrompt` 接收它并：

- 把 `language` 传给 `buildBoundEventPrompt`，由它选择信封文案；
- 索引 `DEFAULT_BOUND_ROLE_GUIDANCE_BY_LANGUAGE[language][role]`，而不是仅英文的表；
- 从按语言的映射中选择来源说明行。

摘要原样透传：它在被撰写的地方就已本地化。

### 缺省语言即英文

每个新字段都是可选的、缺省为 `en`。不设置它的调用方——包括所有既有用例——得到今天的字节。

## 涉及文件

| 文件                                                              | 改动                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/cli/src/serve/server/pr-watch-observation.ts`（+ 测试） | tick deps 增加 `language`；按语言渲染摘要                    |
| `packages/cli/src/serve/server/pr-watch-drain.ts`（+ 测试）       | drain deps 增加 `language`；信封、指引与来源说明的选择       |
| `packages/cli/src/serve/server/pr-watch-deps.ts`（+ 测试）        | sources 增加 `language`，带进两个接缝                        |
| `packages/cli/src/serve/run-qwen-serve.ts`                        | 启动时解析 locale 并传进 sources                             |
| `packages/cli/src/serve/server/session-pr-refresh.test.ts`        | 两个 no-deps 用例断言其声称的效果；退役陈旧的「switch」措辞  |
| `packages/channels/github/src/GithubAdapter.ts`（+ 测试）         | 弃用谓词的 JSDoc 点名全部四个键；告警测试断言 `prWatchLimit` |

## 关键设计决策

1. **在摘要被撰写处本地化，而不是在它被渲染处。** 在投递时重渲染需要往 store 加结构化字段，并会让 pending 事件在 locale 变更时改变语言，与 channel 车道的决策矛盾。检测时渲染不需要改结构，并保持事件语言稳定。
2. **两个共用一个 locale。** 在启动时解析一次、经共享 sources 带下去，防止 observation 与 drain 对同一个事件产生分歧。
3. **缺省即英文、逐字节不变。** 字段可选，因此没有既有调用方改变行为，`en` 臂是回归守卫而不是一条新代码路径。
4. **key 与语言无关。** 转换 key 由身份、类型与 sha/状态构成，绝不由摘要构成，因此本地化不会改变幂等性或去重。
5. **结构性标记保持英文。** 共享契约在每种语言下都保持字段标签与 trusted-block 标签为英文；本增量不触碰它们。

## 约束与风险

- locale 在启动时冻结。修改 `general.language` 的运维者只有在 daemon 重启后才看到新语言，这与 channel 车道已记录的取舍相同。
- 本改动之前检测到的条目保留其英文摘要。这是检测语言规则应用于历史，不是缺陷。
- 摘要渲染现在由四种转换类型共用；缺失的语言条目必须回退到英文，而不是在提示词里产出 `undefined`。

## 验证计划

- 单元（observation）：四种转换各自渲染其 zh 摘要；`en` 渲染与今天逐字节相同；缺省语言渲染英文；两种语言下转换 key 不变。
- 单元（drain）：zh 语言选择 zh 信封、zh 角色指引与 zh 来源说明；摘要原样透传；缺省语言与今天逐字节相同。
- 单元（deps）：sources 的语言到达两个接缝；缺省保持缺省。
- 单元（refresh）：两个 no-deps 用例断言其名字声称的效果——不从遗留 watch 文件投递，以及不认领 owner、不建 view、不写 watch 文件。
- 单元（adapter）：弃用告警测试同时断言 `prWatchLimit` 与 `prWatchBudgetReserve`，含一个只设 `prWatchLimit` 的用例。
- 真实场景：用真实临时 watch 目录与真实绑定扫描驱动已发布的解析器、deps 构造器、observation 与 drain，断言两种语言下投递的提示词文本。

## 验收标准

1. zh daemon 投递的绑定 PR-watch 提示词，其信封、指引、来源说明与摘要均为中文，结构性标记为英文。
2. en daemon 投递的提示词与改动前输出逐字节相同。
3. 在一种语言下检测到的 pending 条目，在 locale 变更后投递时保留该语言。
4. 同一次检测在两种语言下没有任何转换 key 不同。
5. 两个 no-deps refresh 用例在其声称的效果被破坏时变红，而不只是在接缝未被读取时变红。
6. 弃用告警测试在 `prWatchLimit` 被告警漏掉时变红。

## 关联

- [绑定会话事件提示词语言](2026-11-09-bound-event-prompt-language.zh-CN.md) —— 决策 7 把这项穿线记为仍欠着。
- [Daemon PR watch：投递 drain](2026-11-08-daemon-pr-watch-drain.zh-CN.md) —— 本增量本地化的 drain。
- [由 daemon PR 刷新产生 PR 状态转换事件](2026-11-04-daemon-pr-state-transitions.zh-CN.md) —— 母设计。
