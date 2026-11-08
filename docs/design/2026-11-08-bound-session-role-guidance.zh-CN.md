# 未配置运维者模板时的绑定会话角色指引

[English](2026-11-08-bound-session-role-guidance.md) | [简体中文](2026-11-08-bound-session-role-guidance.zh-CN.md)

状态：提案（2026-11-08）。方向已由维护者确认：显式暴露绑定角色、让机器生成的监视摘要只陈述事实、并提供内置的按角色指引——同时保留基础设计的单赢家路由。基于 [GitHub Channel Events to PR-Bound Sessions](2026-11-02-github-channel-bound-session-events.md)（PR #16117）与 [GitHub Channel Bound-Session Action Templates](2026-11-04-github-channel-bound-session-action-templates.md)（PR #16258）。

## 问题陈述

以 `role: "verify"` 绑定到某个 PR 的会话，收到的事件提示词却指使它去做 fix 角色的工作，而且从不告诉它自己持有哪个角色。

2026-11-08 在一个 `/verify-pr` 会话上实测：该会话绑定的 PR 所属 channel 配了 `deliverToBoundSessions: true` 与四个 `prWatchEvents`，但没有配 `boundSessionActions`：

- `ci_failure` 提示词以 `Inspect the failed checks and fix or attribute the failure.` 结尾；
- `merge_conflict` 提示词以 `Rebase or merge the base branch and resolve the conflicts.` 结尾；
- 两条提示词都没有 `Role:` 行。

该会话靠猜来化解这个矛盾。它正确地把 CI 失败归了因，随后把冲突事件当成了一项任务：它在 PR 分支上造了一个 merge commit，并询问是否推送。验证会话应当报告「冲突阻断了验证」，把分支留给作者。

造成这一点的是两个独立原因：

1. **角色被丢弃。** 未配 `boundSessionActions` 时投递走 legacy 模式，它会丢掉绑定上已标记的角色。会话得不到任何关于自己所扮演角色的信息。
2. **摘要在指派工作。** 监视摘要是与角色无关的祈使句，点名了 fix 角色的动作（`fix`、`Rebase or merge`）。它们原样送达每个角色。

单独任一条都还能应付；两条叠加就变成指使一个只做验证的会话去推送。

## 现状

| 关注点           | 位置                                                                             | 今天的行为                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 提示词组装       | `packages/channels/base/src/bound-session-prompt.ts`，`buildBoundEventPrompt`    | 没有 `instruction` 时输出通用句 `Handle the event with your normal workflow, acting on <platform> only if that workflow calls for it.`；只有 `parts.role` 存在时才输出 `Role: <role>`。 |
| legacy 目标选择  | `packages/channels/github/src/GithubAdapter.ts`，`resolveBoundTargets`           | legacy 分支返回裸的 `{ sessionId }`，丢掉跟随者的角色。                                                                                                                                 |
| legacy gone 回退 | `packages/channels/github/src/GithubAdapter.ts`，`resolveBoundDeliveryExcluding` | 仅在 `this.boundRoleAware && best.role` 时附带角色，注释称这是字节兼容的要求。                                                                                                          |
| 角色化开关       | `packages/channels/github/src/GithubAdapter.ts`，`boundRoleAware`                | 仅当运维者模板映射非空时为真。                                                                                                                                                          |
| 监视摘要         | `packages/channels/github/src/GithubAdapter.ts`，监视转换检测                    | `ci_failure`、`merge_conflict` 以及 `state_change` 的 merged 分支都以祈使句结尾。                                                                                                       |

动作模板设计当初决定「字段缺省时，基础设计的每项行为逐字不变」，并有两条测试为**未类型化**绑定钉住通用提示词（`keeps the legacy prompt byte-compatible when no actions are configured`、`legacy gone-fallback stays generic even when bindings carry roles`）。两条夹具选中的都是未类型化赢家，所以「未类型化投递字节相同」这条承诺并不是本次改动要打破的东西。本次打破的是那条承诺被意外延伸到**确实带角色**的绑定上：由 `/review` 或 `/verify-pr` 回填标记的角色，目前与根本没有角色完全无法区分。

共享提示词模块是为第二个生产者准备的——[Daemon PR State Transitions](2026-11-04-daemon-pr-state-transitions.md) 中的 daemon PR 状态监视——它的模板校验已落地，投递路径尚未落地。放在共享模块里的指引能覆盖两个生产者；放在适配器里的只能覆盖一个。

## 目标

- 只要绑定带角色，绑定会话就能从提示词里得知自己的角色，与运维者如何配置无关。
- 未配运维者模板时，带角色的绑定收到限定于该角色的指引，而不是与角色无关的行动指令。
- 机器生成的事件摘要只陈述事实，绝不指派动作。
- 未类型化绑定的提示词逐字节保持今天的样貌。
- 已配置的运维者模板逐字节保持今天的行为，包括按角色订阅的语义。

## 非目标

- 路由不变。没有模板映射时仍然恰好一个赢家，按同一条最近更新规则选出；绑定上的角色绝不启用扇出。
- 内置指引不可配置，不引入任何新设置。
- 不改动评论车道的准入、mention 豁免或发布契约。
- 此处不实现 daemon 监视生产者。

## 提议的解决方案

### 共享提示词契约

`packages/channels/base/src/bound-session-prompt.ts` 新增一张导出表：

```ts
export const DEFAULT_BOUND_ROLE_GUIDANCE: Readonly<
  Record<PrBindingRole, string>
> = {
  review:
    'Act as the reviewer for this PR: inspect the change and report findings through your review workflow. Do not push commits or modify the PR branch.',
  verify:
    'Act as the verifier for this PR: verify the change and report the outcome through your verification workflow. Attribute CI failures rather than fixing them. Do not merge, rebase, resolve conflicts, or push to the PR branch.',
  fix: 'Act as the fixer for this PR: investigate and fix the problem through your fix workflow, which decides whether to push. Re-read the current PR head before acting; it may have moved since this event.',
};
```

`BoundEventPromptParts` 新增一个可选字段 `roleGuidance?: string`。在没有 `instruction` 的分支里，构造器用它替换那句通用工作流句子。其余一切——头部、不可信数据声明、`Your reply stays in this session` 那句、数据行、`Role:` 行、正文上限——位置与措辞一概不变。

这三个字符串就是全部产品表面。它们只按角色索引，不按 (角色, 事件)：事件正文已经携带了该事件的具体事实，按事件铺成矩阵只会成倍增加文本而不增加信息。

### 生产者提供指引，由构造器裁决

只要目标带角色，适配器就传入 `DEFAULT_BOUND_ROLE_GUIDANCE[role]`；未类型化目标则不传。构造器只在「没有解析出运维者 `instruction`」的分支里使用它，因此：

- legacy 模式、带角色的赢家 → 指引替换通用句；
- legacy 模式、未类型化赢家 → 通用句，与今天字节相同；
- 角色化模式 → 运维者区块，因为那里的目标是**按模板匹配**选出的，必然带有 instruction。

早先的草稿让适配器在 `!boundRoleAware` 时才传指引。变异测试表明该守卫不可观测：去掉它不改变任何投递，因为角色化目标根本到不了「无 instruction」分支。按角色订阅应当在真正可判定的地方强制——目标选择，它让未匹配角色根本拿不到目标——因此该守卫被删除，而不是作为不可达分支保留。

### 角色在 legacy 路由中存活

有三条路径会冻结 legacy 目标，三条都必须带上角色：

| 路径                                 | 服务于                                                        | 改动                                                       |
| ------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------- |
| `resolveBoundDelivery`               | 监视事件（pending 认领与 drain 再解析）以及 legacy 目标再校验 | 通过新增的 `boundRoleOf` 回读角色                          |
| `resolveBoundTargets`（legacy 分支） | 评论车道事件                                                  | 同样的回读                                                 |
| `resolveBoundDeliveryExcluding`      | gone 回退                                                     | 去掉 `this.boundRoleAware &&` 合取项；`best.role` 本就在手 |

`boundSessionByPr` 只持有 `PrBindingSummary`，所以前两条从 `boundFollowersOf` 回读角色——正是角色化路径用来分组的那份列表。

这些都不触及哪个会话胜出：分组、最近更新比较与单赢家形状均未改动。

### gone 回退必须重建提示词

暴露角色之后显出了一处潜伏缺陷。gone 回退循环只为第一个目标构造**一次**提示词，随后对每个候选复用那个字符串。legacy 模式下该循环不带角色过滤地扫描每个跟随者，因此可能跨角色：已 gone 的 `review` 会话的 `Role: review` 行与评审者指引，被投递给了接手的 `verify` 会话。改动前 legacy 提示词不带角色，所以这种复用看不出来。

现在循环按每个目标自己的角色重建提示词。角色化回退留在自己的角色组内，确定性渲染器会产出完全相同的字符串，因此行为不变。这正是动作模板设计已为角色化投递点名过的同一风险（「绝不能把过时角色的指令继续注入被冻结的会话」）；legacy 路由现在获得等价保护。

### 事实化的监视摘要

| 类型                     | 改动前                                                                                                          | 改动后                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `ci_failure`             | `CI failed on head <sha>.<checks> Inspect the failed checks and fix or attribute the failure.`                  | `CI failed on head <sha>.<checks>`                   |
| `merge_conflict`         | `Merge conflicts detected (mergeable_state: dirty). Rebase or merge the base branch and resolve the conflicts.` | `Merge conflicts detected (mergeable_state: dirty).` |
| `state_change`（merged） | `The PR was merged. Wrap up any follow-up work.`                                                                | `The PR was merged.`                                 |
| `head_change`            | `New commits pushed: head moved from <a> to <b>.`                                                               | 不变                                                 |
| `state_change`（closed） | `The PR was closed without merging.`                                                                            | 不变                                                 |

动作现在只来自一个地方：配置了就是运维者模板，否则是内置角色指引，再否则是会话自己的工作流。事件正文不再与它争夺。

## 关键设计决策

1. **内置指引替换通用句，不进入运维者区块。** 通用句本来就是产品撰写的可信文本，替换它不改变任何信任边界。把 `[Operator instruction — trusted]` 复用于内置默认值会错误标注其来源，而新增第二个带标签的区块又会多出一个 `sanitizePromptText` 剥离规则必须考虑的标签。两者都不值得。
2. **默认值绝不覆盖运维者指令，也绝不订阅一个角色。** 前半由构造器里的优先级保证。后半是目标选择的职责：角色化模式下未匹配角色拿不到目标，因此根本到不了构造器。生产者绝不能用「给未匹配角色一个默认目标」来「修补」它——那会把「运维者没有订阅这个角色」变成一次投递，正是键校验器要防的「静默生效的键」失败模式。
3. **生产者提供字符串，构造器掌握优先级。** 构造器不导入那张表、也不按角色查表，因此有自己指引的生产者可以自行传入。运维者指令与指引之间的裁决只发生在一个地方，而不是两个地方各自保持一致。
4. **摘要对所有角色都事实化，不只对 verify。** 一个被告知 `Rebase or merge` 的 review 会话同样是错的。去掉祈使句修的是这一类问题而不是这一个实例，也顺带修好了未来的 daemon 生产者——它会按同一契约发出自己的摘要。
5. **未类型化投递保持字节相同。** 两条既有 pin 选中的都是未类型化赢家，原样继续通过。兼容承诺被收窄回它当初所针对的范围，而不是被退役。

## 受影响文件

| 层          | 路径                                                      | 改动                                                                                                      |
| ----------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 共享契约    | `packages/channels/base/src/bound-session-prompt.ts`      | `DEFAULT_BOUND_ROLE_GUIDANCE`；`BoundEventPromptParts` 上的 `roleGuidance`；在无 instruction 分支中使用它 |
| 共享 barrel | `packages/channels/base/src/index.ts`                     | 导出该表                                                                                                  |
| 适配器      | `packages/channels/github/src/GithubAdapter.ts`           | `boundRoleOf`；三条 legacy 目标路径都带上角色；传入 `roleGuidance`；gone 回退按目标重建提示词；事实化摘要 |
| 共享测试    | `packages/channels/base/src/bound-session-prompt.test.ts` | 指引替换、未类型化兜底、运维者区块优先级                                                                  |
| 适配器测试  | `packages/channels/github/src/GithubAdapter.test.ts`      | legacy 模式下的 Role 行与指引；角色化模式不变；摘要文本                                                   |
| 用户文档    | `docs/users/features/channels/github.md`                  | 记录内置指引与事实化摘要                                                                                  |
| 设计        | 本文这一对                                                | 新设计                                                                                                    |

## 约束与风险

- **提示词文本是面向模型的契约。** 持有较早转录的会话会看到一个新句子。对未类型化绑定是纯增量，对带角色绑定则是替换掉一条与角色无关的祈使句，这正是意图所在。
- **指引不是授权边界。** 它是指令文本而非强制手段；会话仍可能越界行动。工具权限才是边界。这些字符串写成范围陈述，好让守规的会话有明确答案。
- **head 过期仍有可能。** `fix` 那条字符串要求会话重读 head，但没有强制。投递时的 head 再校验不在范围内。
- **表的膨胀。** 三个字符串，按闭合的角色词表索引。往 `PR_BINDING_ROLES` 加角色会在此处变成类型错误，直到补齐指引为止——这正是想要的耦合。

## 验证计划

- `packages/channels/base` 中针对构造器的单元测试：指引替换通用句；缺省时保留通用句；运维者 instruction 优先于 `roleGuidance`；`Role:` 行与正文上限不受影响。
- `packages/channels/github` 中针对投递的单元测试，覆盖**两条**目标路径：监视路径（`resolveBoundDelivery`）与评论路径（`resolveBoundTargets`）。带角色的 legacy 赢家拿到 `Role:` 及其指引；未类型化 legacy 赢家与今天字节相同；gone 回退点名回退会话自己的角色；角色化投递不变，包括「无角色匹配 → 私下退役」。
- 每条被编辑的摘要各一条 pin，断言祈使句已消失，使后续编辑无法把指派重新塞回事件数据。
- 变异测试：逐条单独回退每处源码改动，被点名的用例必须转红。存活的变异说明该用例没有钉住这处改动——要么补上缺失的用例，要么删掉那段不可观测的代码。
- `npm run build`、`npm run typecheck`，以及两个包的定向套件。
- E2E：针对本地 daemon，在配与不配 `boundSessionActions` 两种情况下驱动一个绑定会话，检查投递出的提示词。

## 验收标准

1. 未配运维者模板时，绑定为 `verify` 的会话收到 `merge_conflict`，会得到 `Role: verify`、验证者指引，以及一段陈述冲突但不叫它 rebase 或 merge 的正文。
2. 同一 channel 配上 `boundSessionActions` 后，对每个匹配角色投递的提示词与今天字节相同，且仍跳过未匹配角色。
3. 未类型化绑定的提示词在两种模式下都与今天字节相同。
4. 没有任何监视摘要包含祈使动作。
5. 跨角色的 gone 回退投递的是接手会话自己的角色与指引，绝不是已 gone 会话的。
6. 每处源码改动都有一条让被点名用例转红的变异作为见证。
7. 构建、类型检查与定向套件通过。

## 待决问题

- daemon 监视生产者应当逐字复用这些字符串，还是提供平台中立的变体。推迟到该生产者实现时再定；表放在共享模块里，两种选择都仍然便宜。
- `fix` 指引是否应当点名推送需确认这一预期。暂且交给会话自己的工作流，因为那是用户偏好而非产品规则。
