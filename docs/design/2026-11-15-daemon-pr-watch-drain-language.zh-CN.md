# Daemon PR watch：提示词语言

[English](2026-11-15-daemon-pr-watch-drain-language.md) | [简体中文](2026-11-15-daemon-pr-watch-drain-language.zh-CN.md)

状态：已实现（#17352；2026-11-15 提案）。下文按该增量当时的设计描述。

## 问题

即使运维者的 UI 语言是中文，daemon 的 PR 状态监视仍以英文投递绑定事件提示词。channel 车道已在 #16773 本地化，共享构造器自那时起就带有按语言的信封、角色指引表与文案映射，但 daemon 生产方从不传语言：`PrWatchDrainDeps` 未声明 `language` 成员，`buildDrainPrompt` 调用 `buildBoundEventPrompt` 时不带它，而四处转换摘要在 observation 生产方里是英文字面量。因此今天一个带事件订阅的 zh 部署收到的是英文 daemon 提示词。

[绑定会话事件提示词语言](2026-11-09-bound-event-prompt-language.zh-CN.md) 的决策 7 曾把这件事记为仍欠着、而非已排到别处：启用增量（#17032）落地时没有穿它。本增量把它穿上。

## 现状

下表描述本增量之前的树。

| 表面                                                                      | 位置                                                                            | 今天的语言                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 信封措辞（头部、告示、工作流句、截断标记）                                | `packages/channels/base/src/bound-session-prompt.ts`，`BOUND_ENVELOPE_COPY`     | 已本地化；drain 不传 `language`，因此解析为 `en`               |
| 内置角色指引                                                              | 同文件，`DEFAULT_BOUND_ROLE_GUIDANCE_BY_LANGUAGE`                               | 已本地化；drain 索引的是仅英文的 `DEFAULT_BOUND_ROLE_GUIDANCE` |
| 来源说明行                                                                | `packages/cli/src/serve/server/pr-watch-drain.ts`，`buildDrainPrompt`           | 硬编码英文字面量                                               |
| 转换摘要（`head_change`、`ci_failure`、`merge_conflict`、`state_change`） | `packages/cli/src/serve/server/pr-watch-observation.ts`，四处 `summary:` 字面量 | 硬编码英文，持久化进 `pending[].summary`                       |
| locale 解析                                                               | `packages/cli/src/commands/channel/runtime.ts`，`resolveChannelLocale`          | 已存在，由 channel 的 `daemon-worker.ts` 与 `start.ts` 读取    |

## 目标

- `general.language` 解析为 `zh` 的 daemon，投递的绑定 PR-watch 提示词其信封措辞、角色指引与来源说明均为中文，且在该 locale 下检测到的每个转换其摘要也是中文。
- `en`（或未设置、或无法识别）的语言保持今天的输出**逐字节不变**。
- pending 条目的持久化摘要保留其检测时的语言；信封、角色指引与来源说明跟随投递时生效的 locale。channel 车道也是同一条规则：它持久化生产方组装的正文（`boundText`），信封在投递时组装，因此两条车道的检测语言保证覆盖的都是被持久化的文本，而不是整个提示词。
- 不改 store 结构，不改任何转换 key。

## 非目标

- 运行时语言切换。locale 在 daemon 启动时读一次，与 channel worker 在启动时读取完全一致。
- 本地化运维模板。`sessionPrWatch.actions` 的值按运维者书写的语言逐字渲染。
- 本地化 channel 的评论车道，#16773 已覆盖。
- 结构性标记。字段标签（`Repo:`、`PR:`、`Title:`、`URL:`、`Event:`、`Summary:`、`Role:`）、trusted-instruction 标签与 `Source:` 行在每种语言下都保持英文，这是共享契约的要求。

## 拟议改动

### 一个 locale，在启动时解析

`run-qwen-serve.ts` 在既有 `resolveSessionPrWatchConfig` 调用旁解析 `resolveChannelLocale(bootSettings?.general?.language)`，并把它带进 `prWatchSources`；`bootSettings` 是绑定 workspace（第一个 `--workspace`）的合并设置，而 `prWatchSources` 是唯一的、daemon 全局的 sources 对象。两个接缝读同一个值，因此在同一次启动内 observation 与 drain 不会对 locale 产生分歧。跨重启则可能：在旧 locale 下持久化的摘要，会被装进按新 locale 组装的信封里投递——这正是预期的切分。

### observation 在检测时本地化摘要

`PrWatchObservationTickDeps` 增加 `language?: BoundPromptLanguage`。四处 `summary:` 字面量改为按语言渲染，因此持久化的 `pending[].summary` 已经是检测时的语言。这正是 pending 摘要能跨重启或跨后续 locale 变更保留其检测语言的原因，也是不往 store 增加结构化字段的原因。

### drain 本地化它在投递时组装的部分

`PrWatchDrainDeps` 增加 `language?: BoundPromptLanguage`。`buildDrainPrompt` 接收它并：

- 把 `language` 传给 `buildBoundEventPrompt`，由它选择信封文案；
- 索引 `DEFAULT_BOUND_ROLE_GUIDANCE_BY_LANGUAGE[language][role]`，而不是仅英文的表；
- 从按语言的映射中选择来源说明行。

摘要原样透传：它在被撰写的地方就已本地化。

### 缺省语言即英文

每个新字段都是可选的、缺省为 `en`。不设置它的调用方——包括所有既有用例——得到今天的字节。

## 涉及文件

| 文件                                                               | 改动                                                                                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/utils/channel-locale.ts`（新增）                 | 零导入的 locale 解析器，从 channel runtime 移出                                                                                                          |
| `packages/cli/src/commands/channel/runtime.ts`（+ 测试）           | 再导出该解析器，其两个既有导入方不变；解析器表新增 trim 与大小写行                                                                                       |
| `packages/cli/src/serve/fast-path-settings.ts`                     | 启动设置面携带 `general.language`；读取器复制字符串、丢弃其余取值                                                                                        |
| `packages/cli/src/serve/fast-path.test.ts`                         | 六个读取器用例：值被带出、非字符串被容忍且不丢弃 summary、chatRecording 与之共存、workspace 压过 user 的优先级及其信任开启镜像、general 跨作用域逐键合并 |
| `packages/cli/src/serve/run-qwen-serve.ts`                         | 启动时解析 locale 并传进 sources                                                                                                                         |
| `packages/cli/src/serve/run-qwen-serve.pr-watch-shutdown.test.ts`  | 以 `general.language: zh` 真实启动 serve，locale 到达两个 watch 接缝                                                                                     |
| `packages/cli/src/serve/server/pr-watch-deps.ts`（+ 测试）         | sources 增加 `language`，带进两个接缝                                                                                                                    |
| `packages/cli/src/serve/server/pr-watch-observation.ts`（+ 测试）  | tick 与 sweep deps 增加 `language`；按语言渲染摘要                                                                                                       |
| `packages/cli/src/serve/server/pr-watch-drain.ts`（+ 测试）        | drain deps 增加 `language`；信封、指引与来源说明的选择                                                                                                   |
| `packages/cli/src/serve/server/pr-watch-drain.scenario.test.ts`    | 两个端到端语言场景，经真实 gh 子进程与真实 admission                                                                                                     |
| `packages/cli/src/serve/server/session-pr-refresh.ts`（+ 测试）    | listing write 携带语言；两个 no-deps 用例断言其声称的效果；退役陈旧「switch」措辞                                                                        |
| `packages/channels/github/src/GithubAdapter.ts`（+ 测试）          | 弃用谓词的 JSDoc 点名全部四个键；告警测试断言两个 limit 旋钮                                                                                             |
| `docs/users/configuration/settings.md`                             | `general.language` 行记录提示词语言效果、匹配规则与信任条件；`serve.sessionPrWatch.events` 行指向它，并区分设置存在与缺失                                |
| `docs/users/features/channels/github.md`                           | 提示词 locale 不是实际渲染的 UI 语言；匹配规则取代形状清单；点名各生产方的读取点                                                                         |
| `docs/design/2026-11-09-bound-event-prompt-language.md`（+ zh-CN） | 决策 7 改为过去时，现状表校准到已发布的树，延后的开放问题标为已解决                                                                                      |
| `docs/design/2026-11-08-bound-session-role-guidance.md`（+ zh-CN） | 同一条延后的开放问题标为已解决                                                                                                                           |

## 关键设计决策

1. **在摘要被撰写处本地化，而不是在它被渲染处。** 在投递时重渲染需要往 store 加结构化字段，并会让 pending 摘要在 locale 变更时改变语言。channel 车道做的是同一个切分——它持久化生产方组装的 `boundText`，信封在投递时按其启动 locale 组装——因此这是把该车道的规则应用到 daemon 的 `pending[].summary`，而不是一条更窄的规则。检测时渲染不需要改结构，并保持摘要语言稳定。
2. **两个共用一个 locale。** 在启动时解析一次、经共享 sources 带下去，防止 observation 与 drain 在同一次启动内对 locale 产生分歧。在更早一次启动的 locale 下持久化的摘要，是唯一可能不同的部分，且这是设计如此。
3. **缺省即英文、逐字节不变。** 字段可选，因此没有既有调用方改变行为，`en` 臂是回归守卫而不是一条新代码路径。
4. **key 与语言无关。** 转换 key 由身份、类型与 sha/状态构成，绝不由摘要构成，因此本地化不会改变幂等性或去重。
5. **结构性标记保持英文。** 共享契约在每种语言下都保持字段标签与 trusted-block 标签为英文；本增量不触碰它们。

6. **平台数据保持字节，其周围的散文本地化。** sha 原样插值，检查名在两种语言下都保持 `, ` 连接，这是 prompt-language 设计钉住的。`state_change` 也本地化：其 `PR …` 外壳是撰写的散文、不是平台 token，因此 zh daemon 读到 `PR 已合并` / `PR 已关闭`，而转换 key 仍用原始状态对。
7. **坏的 `general.language` 被丢弃，而不是抛错。** 这是逐键的选择，不是读取器一刀切的政策：读取器对 `general.chatRecording`、`advanced.excludedEnvVars`、`advanced.runtimeOutputDir` 与 `security.folderTrust.enabled` 的畸形值会抛错，另有 legacy 顶层 `folderTrust`（legacy 键文件且未取到 `security.folderTrust.enabled` 时）——`pickFastPathSettings` 内共五处。对这个键，`resolveChannelLocale` 本就把非字符串读作英文，丢弃该值不损失任何东西，而抛错会丢弃整个 summary——把权限策略与 PR-watch 订阅一起带走。

## 约束与风险

- locale 在启动时冻结。修改 `general.language` 的运维者只有在 daemon 重启后才看到新语言，这与 channel 车道已记录的取舍相同——而且即便如此，已排队的摘要仍保留其检测时的语言。
- locale 继承 `general.language` 的作用域，且其影响范围是全 daemon。它在启动时由**绑定** workspace 的合并设置解析一次——即第一个 `--workspace`——因此那里的受信任文件会覆盖 user 作用域，并改变投递到每个托管 workspace 的 PR-watch 提示词语言；而其他任何 workspace 文件里的同一个键不起作用。boot 读取器的 `general.*` 值本就都是 daemon 级的——同一读取器读出的 `general.chatRecording` 决定整个 daemon 的会话产物持久化——因此这是读取器既有的行为，不是本增量引入的。本增量写明该来源而不收窄它：在此门控该键会让 daemon 与仓库其余部分不一致。
- 本改动之前检测到的条目保留其英文摘要。这是检测语言规则应用于历史，不是缺陷。
- 摘要渲染现在由四种转换类型共用。文案映射是完整的 `Record<BoundPromptLanguage, …>`，因此新增语言必须同时补上其条目，而缺省语言解析为 `en`——两条路径都不会把 `undefined` 放进提示词。

## 验证计划

- 单元（observation）：四种转换各自渲染其 zh 摘要；`en` 渲染与今天逐字节相同；缺省语言渲染英文；两种语言下转换 key 不变。
- 单元（drain）：zh 语言选择 zh 信封、zh 角色指引与 zh 来源说明；摘要原样透传；缺省语言与今天逐字节相同。
- 单元（deps）：sources 的语言到达两个接缝；缺省保持缺省。
- 单元（启动设置与接线）：fast-path 读取器带出 `general.language`，并在不丢弃 summary 的前提下丢掉非字符串；folder trust 关闭时 workspace 的值覆盖 user 作用域，开启且无规则信任该目录时同一值被忽略，且 `general` 在两个作用域间逐键合并；以 `general.language: zh` 与一个事件订阅真实启动 serve，解析出的 locale 到达 `getPrWatchDeps()` 与 `getPrDrainDeps()` 两者。
- 单元（refresh）：两个 no-deps 用例通过对 store 下 spy 来断言其名字声称的效果——既不认领 owner 记录，也不写 watch 文件。夹具无法把文件种在无 deps 的 drain 会去看的位置，因为 `drainNow` 在 deps 门处返回，早于任何目录被解析。
- 单元（adapter）：弃用告警测试同时断言 `prWatchLimit` 与 `prWatchBudgetReserve`，含一个只设 `prWatchLimit` 的用例。
- 真实场景：场景套件用真实临时 watch 目录、真实 gh 子进程与真实 admission 驱动已发布的 observation 与 drain，locale 设在 deps 上，断言两种语言下投递的提示词文本。启动路径本身由上面的 serve 启动用例与读取器用例覆盖；本增量另跑了一个本地全链路探针（属验证探针，不是入库用例），从真实设置文件驱动已发布的解析器与 deps 构造器。另一个用例在检测与投递之间切换 locale，断言同一条提示词里英文信封包着中文摘要。

## 验收标准

1. zh daemon 投递的绑定 PR-watch 提示词，其信封、指引与来源说明均为中文，结构性标记为英文；在 `zh` 下检测到的转换还带有中文摘要。
2. en daemon 投递的提示词与改动前输出逐字节相同。
3. 在一种语言下检测到的 pending 条目，在 locale 变更后投递时其持久化摘要保留该语言；信封、角色指引与来源说明跟随投递时生效的 locale。
4. 同一次检测在两种语言下没有任何转换 key 不同。
5. 两个 no-deps refresh 用例在其声称的效果被破坏时变红，而不只是在接缝未被读取时变红。
6. 弃用告警测试在 `prWatchLimit` 被告警漏掉时变红。

## 关联

- [绑定会话事件提示词语言](2026-11-09-bound-event-prompt-language.zh-CN.md) —— 决策 7 曾把这项穿线记为仍欠着，现在指向这里作为其落地记录。
- [Daemon PR watch：投递 drain](2026-11-08-daemon-pr-watch-drain.zh-CN.md) —— 本增量本地化的 drain。
- [由 daemon PR 刷新产生 PR 状态转换事件](2026-11-04-daemon-pr-state-transitions.zh-CN.md) —— 母设计。
