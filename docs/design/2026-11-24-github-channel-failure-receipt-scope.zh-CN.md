# 把 GitHub 渠道的失败回执限定到显式 @

[English](2026-11-24-github-channel-failure-receipt-scope.md) | [简体中文](2026-11-24-github-channel-failure-receipt-scope.zh-CN.md)

## 问题

公开路径上的入站任务在最后一次尝试失败时，GitHub 渠道会在该 thread 上发这条评论：

```
⚠️ Failed to process this request. Please re-mention the bot to retry.
```

这条回执假定有一个发件人在等回复。对根本没人向 bot 提问的事件，这个假定不成立。2026-11-24，PR #18009 上一条来自 `github-actions[bot]` 的 CI 失败公告在三分钟后产生了这条回执，并以维护者本人的账号发布。于是 thread 上多了一条公开消息，它（a）没有收件人，（b）读起来像 PR 作者在报告失败，（c）没有说明哪个请求失败、为什么失败。

## 现状

两个缺口共同产生这条回执：

1. 评论 lane 只排除渠道自己的账号（`comment.user?.login !== this.botUsername`）。其他机器账号的评论会进入 lane。
2. 「这条是否需要回复」只由模型回答，靠 `<no-reply/>` 哨兵。模型调用连续三次失败时没有哨兵，adapter 无法区分「没答上的提问」和「本来就不需要回答的事件」，于是回退到公开回执。

## 目标

- 不为未 @ bot 的机器作者评论消耗模型尝试。
- 除非事件 @ 了 bot，否则不发布失败回执。
- 让跳过可见：Channel event timeline 记录被丢弃的事件及原因。

## 非目标

- 不改回执文案、发布身份，也不加隐藏标记。
- 不做按 issue 的回执节流（见开放问题）。
- 不把同一策略套到 GitLab adapter，它有自己的一份回执逻辑。
- 不过滤 inline pull-request review comment，它走独立的 lane。

## 方案

### 1. 跳过未 @ 的机器作者评论

`user.type` 为 `Bot`，或 login 以 `[bot]` 结尾，即为机器作者。这类评论若未 @ bot，逐条评论 lane 与聚合 lane 都在认领任务前跳过它，并记录
`{ type: 'inbound', outcome: 'skipped', reason: 'machine_author' }`，带上评论 key 与 actor。

机器作者的评论若确实 @ 了 bot，仍进入 lane，bot 之间的请求不受影响。

### 2. 用显式 @ 作为回执门槛

`Envelope` 新增可选字段 `isExplicitMention`。只有消息正文 @ 了 bot 时它才为 `true`，这比 `isMentioned` 更窄：adapter 对隐式定向的事件（账号拥有的 thread、聚合 digest）也会把 `isMentioned` 置为 `true`。

- 评论 lane：`isExplicitMention: hasMention`。
- 聚合 lane：批次中至少一条评论 @ 了 bot 时为 `true`。
- issue 事件 lane（`review_requested`、`assign`）：`true`，因为事件本身就是请求。
- 首次接触的 issue 正文：与 `isMentioned` 相同，只有正文 @ 了 bot 才为 `true`。

`postErrorComment` 现在要求 `envelope.isExplicitMention === true`。没有该标记的事件仍会在任务行与事件时间线里记录每次失败，只是失去公开回执。

## 决策与理由

- **用两个机器信号，而不是一个。** REST API 返回 `user.type`，但缓存或不完整的 payload 可能缺它。`[bot]` login 后缀在这种情况下仍让过滤有效。
- **新增字段，而不是复用 `isMentioned`。** 在作者触发 lane 里每条评论的 `isMentioned` 都是 `true`，每个 digest 也是，它无法区分提问与旁听。
- **digest 按批次判定。** 一条 mention 混着若干 ambient 评论的 digest 仍有发件人在等，所以批次级标记为 `true`；整批无 mention 则没有。
- **issue 事件保持 `true`。** 评审请求或指派本身就是直接请求，即使正文没有 `@`。

## 约束

- 只改 GitHub adapter。`Envelope` 是共享的，但新字段可选，其他 adapter 行为不变。
- 本改动之前创建的任务没有 `isExplicitMention`。恢复时它不会得到回执。这是一次性的升级效应。

## 风险

- **未 @ bot 的首次接触正文会静默失败。** 配置为监视所有新 issue 的渠道会失去这些失败的公开回执。失败任务行与事件时间线仍会记录它们。
- **以普通用户身份发帖的机器账号**不会被作者过滤命中。渠道自己的 bot 账号已经按 login 排除。
- **聚合 lane 会丢弃机器评论，即使 sender gate 本来也会拒绝它。** 记录的原因变成 `machine_author` 而不是 sender 拒绝，这是更精确的原因。
- **被跳过的机器评论会被后续每个窗口重新列出。** 它从未被派发，没有 cursor key 覆盖它；每窗口一次的日志把它限制为每窗口一条 `machine_author` 行。

## 验证

- `packages/channels/github`：`npx vitest run src/GithubAdapter.test.ts
--coverage.enabled=false` —— 827 passed。
- 新增用例：未 @ 的机器作者评论在聚合 lane 与 pairing lane 上都被跳过并记事件；@ 了 bot 的机器作者评论被保留；混合批次丢掉 CI 公告、保留人类评论；未 @ 的批次连续失败三次不发回执。
- 变异检查，四臂，每臂之后还原并复跑转绿：
  - 禁用作者过滤：三个跳过用例变红（`expected [ { …(12) } ] to have a length of +0 but got 1`）；
  - 去掉 @ 例外：保留用例变红（`expected [] to have a length of 1 but got +0`）；
  - 移除 `isExplicitMention` 条件：两个回执用例变红（`expected "spy" to not be called at all, but actually been called 1 times`、`expected … to have a length of 1 but got 2`）；
  - 只禁用 comment lane 调用点：pairing 用例变红（`expected [ { …(12) }, { …(12) } ] to have a length of 1 but got 2`）。
- `packages/channels/base` 与 `packages/channels/github` 里 `npx tsc --noEmit -p tsconfig.json` —— exit 0。
- 改动文件上 `npx prettier --check` 与 `npx eslint` —— exit 0。

## 验收标准

1. 机器账号的评论未 @ bot 时不创建任务、不发评论，并记录一条原因为 `machine_author` 的 `skipped` 行。
2. 机器账号的评论 @ 了 bot 时照常派发。
3. 事件没有显式 @ 的公开路径任务在三次失败后不发回执；任务行以 `failed` 结束。
4. 事件有显式 @ 的公开路径任务在三次失败后仍恰好发一条回执。
5. `docs/users/features/channels/github.md` 写明这两条规则。

## 开放问题

- 回执是否应带隐藏标记、并由 bot 身份而不是维护者账号发布？这是身份问题的更大修复，不在本次范围内。
- 回执是否应按 issue 节流？issue #16228 报告了同一 thread 上多个任务失败时的重复回执。
- GitLab adapter 是否应采用同样的两条规则？
