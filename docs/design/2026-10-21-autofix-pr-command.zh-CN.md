# `/autofix-pr`：在本地盯住 PR 并自动修复

[English](2026-10-21-autofix-pr-command.md) | [简体中文](2026-10-21-autofix-pr-command.zh-CN.md)

状态：进行中。2026-10-21。交付计划第 1 步（`prepare`、`snapshot`、`ci-log` 和 `cleanup` 辅助命令）已实现，其余仍是提案。[已定决策](#11-已定决策)中的四项产品决策于 2026-10-21 确定。

## 1. 问题

PR 提交之后，作者还得一直盯着：CI 在没测过的平台上失败，reviewer 留了评论，base 分支前进导致冲突。每一轮都不大，但都需要有人发现、同步分支、修改、验证、推送、回复。现在 Qwen Code 能在用户要求时完成其中每一步，但没有东西盯着 PR、自动开始下一轮。

`/autofix-pr` 在本地 Qwen Code 会话里补上这个闭环。它盯住一个 PR，在隔离的 worktree 里修复 CI 失败、review 反馈和合并冲突，把修复推到 PR 分支，回复它处理过的反馈，并在 PR 合并或关闭时停止。

## 2. 现状

这个命令在调度、隔离和委派上需要的能力，`main` 上都已经有了：

| 能力                    | 现有模块                                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 周期触发                | `cron_create`（`packages/core/src/tools/cron-create.ts`）：会话级或持久化，循环任务带最多周期 10% 的抖动，会自动过期。触发进入通知队列，不会打断正在运行的轮次（`packages/cli/src/ui/hooks/use-llm-stream.ts`）。 |
| 循环约定                | bundled `loop` skill（`packages/core/src/skills/bundled/loop/SKILL.md`）、`cron_list` / `cron_delete`、CronPill。                                                                                                 |
| 隔离的 PR worktree      | `qwen review fetch-pr`（`packages/cli/src/commands/review/fetch-pr.ts`）及其 git 辅助函数（`packages/cli/src/commands/review/lib/git.ts` 里的 `releaseWorktree`、`lib/worktree.ts` 里的 `redirectedAncestor`）。  |
| 委派                    | 带 `working_dir` 和 `run_in_background` 的 `agent` 工具（`packages/core/src/tools/agent/agent.ts`）。                                                                                                             |
| 确定性的 skill 辅助命令 | `qwen review <helper>` 模式：逻辑放在有测试的 CLI 子命令里，skill 通过 `"${QWEN_CODE_CLI:-qwen}"` 调用。                                                                                                          |
| 冲突处理策略            | `/resolve` 设计（[2026-06-23-fix-conflicts-command.md](2026-06-23-fix-conflicts-command.md)）：merge base 分支，用 `--force-with-lease` 针对预期的 head SHA 推送。                                                |
| 不可信输入规则          | 仓库的 `.qwen/skills/autofix` skill 把 PR 文本、评论和日志当作数据，而不是指令。                                                                                                                                  |

缺的是确定性的那部分：读取 PR 状态并算出自上次检查以来的变化，强制推送安全，以及发回复时不形成反馈循环。用 monitor 一直跑到条件满足不合适，因为 `monitor` 静默最多 10 分钟就会停，而一个 PR 可能几个小时都没有动静。

## 3. 目标与非目标

目标：

- 在本地会话里盯住一个 PR，响应 CI 失败、可信作者的 review 反馈和合并冲突。
- 绝不碰用户的工作区，绝不强推，绝不推到默认分支。
- 回复它处理过的反馈，让 reviewer 看到改了什么。
- PR 合并或关闭时、或尝试预算用完时自行停止，并说明原因。
- 空闲检查的开销要低。

非目标（第一版）：

- 没有打开 Qwen Code 会话时也能运行（没有云端执行器，没有 webhook）。
- 本地没有匹配 remote 的仓库里的 PR。
- resolve review thread。这个决定留给 reviewer。
- 新开 PR，或改写 PR 标题和描述。

## 4. 用户体验

```text
/autofix-pr [<pr-number>|<pr-url>] [--once] [--every <minutes>] [--no-reply] [instructions...]
/autofix-pr status
/autofix-pr stop [<pr-number>]
```

- 不带 PR 参数：使用 head 是当前分支的那个 PR。
- `--once`：只跑一轮检查和修复，不调度任何东西。headless `-p` 下只能用这个模式。
- `--every`：检查间隔，单位分钟，取值 `5, 10, 15, 20, 30, 60` 之一。默认 `15`。
- `--no-reply`：推送修复，但不在 PR 上发任何内容。
- 选项之后的自由文本会追加到每次的修复说明里，例如"不要改公共 API"。

开始前，命令会给出一次确认：

- 它会向 `<owner>/<repo>:<headRef>` 推送提交，并在 PR 上发回复，两者都使用用户自己的 git 和 `gh` 身份。
- 验证会运行仓库定义的构建和测试命令。

每次启动都会确认，定时检查不会。无法显示确认的会话需要加 `--yes`。

启动后，只有发生了事情的检查才会给用户一行输出，例如 `autofix-pr owner/repo#123: fixed "Test ubuntu" and 2 review comments, pushed 3f2a1c0`。`status` 列出正在盯的 PR，包括上次检查时间、head SHA、已用推送次数和等待人工处理的评论。

## 5. 架构

设计沿用 `/review` 的分工：能计算出来的决定写成有单元测试的 CLI 辅助命令，需要判断的部分留在 skill 里。

```text
/autofix-pr  (bundled skill: packages/core/src/skills/bundled/autofix-pr/SKILL.md)
  ├─ qwen autofix-pr prepare   validate PR, create pushable worktree and state file
  ├─ qwen autofix-pr snapshot  read PR state, diff against the cursor, emit events + action
  ├─ qwen autofix-pr ci-log    write the failing job's log tail to a file
  ├─ fix                       background agent, working_dir = worktree
  ├─ qwen autofix-pr push      guarded push, advances the cursor
  ├─ qwen autofix-pr reply     post replies with a marker, record their ids
  ├─ qwen autofix-pr cleanup   remove worktree, branch and state file when safe
  └─ cron_create               session-only, recurring: "Run /autofix-pr tick <owner>/<repo>#<n>"
```

辅助命令放在 `packages/cli/src/commands/autofix-pr.ts` 和 `packages/cli/src/commands/autofix-pr/` 下。每个 PR 的状态放在 worktree 旁边，不放在 worktree 里面，位于 clone 的主 worktree 下。分支由同一个 clone 的所有 worktree 共享，所以每个辅助命令从其中任何一个 worktree（包括 autofix worktree 本身）运行，都能找到同一次监视：

- worktree：`.qwen/tmp/autofix-pr-<n>/`
- 状态：`.qwen/tmp/autofix-pr-<n>-state.json`
- 日志和修复说明：`.qwen/tmp/autofix-pr-<n>-*.{log,md}`

## 6. 辅助命令契约

### 6.1 `prepare <pr> --repo <owner>/<repo> [--host <host>]`

1. 用 `gh` 解析 PR。PR 已关闭或已合并、head 仓库已被删除、或 head 是默认分支时拒绝。
2. 动手之前先检查推送权限。同仓库 PR 要求仓库的 `viewerPermission` 为 `WRITE`、`MAINTAIN` 或 `ADMIN`。fork PR 要求当前用户就是 fork 的所有者，或者既有写权限又有 `maintainerCanModify`。否则拒绝并说明原因。
3. 要求本地恰好有一个 remote 和 base 仓库匹配（使用 `review match-remote` 背后的匹配逻辑）。
4. 确定推送目标。优先使用唯一一个和 head 仓库匹配的本地 remote；没有的话，按 `gh config get git_protocol` 给出的协议使用 head 仓库的 URL。把结果记到状态文件里。
5. 状态文件就是锁。它记录会话 id（`QWEN_CODE_SESSION_ID`）；由另一个会话写下的状态文件直接导致拒绝，绝不抢占。
6. 把 `refs/pull/<n>/head` fetch 到本地分支 `qwen-autofix/pr-<n>`，并在它上面创建 worktree。`prepare` 从不丢弃之前的工作：残留的 worktree，或可能含有超出记录 head 的提交的残留分支，都会导致拒绝，并提示先运行 `cleanup`。
7. 在拥有这次监视的会话里重新运行 `prepare`，且 worktree 还在时，直接报告现有状态并带上 `resumed: true`，不再调用其他任何东西。如果 worktree 已被删除（包括用 `rm -rf` 删除，`git worktree prune` 会清掉它的登记），就重新创建它，并保留已记录的 `pushedShas`、`handledCommentIds` 和 `postedCommentIds`。状态文件属于另一个仓库的同号 PR 时直接拒绝。
8. 输出 JSON 报告：worktree 路径、分支、head SHA、base/head ref、推送目标、当前用户和 PR 作者的 login、draft 和 fork 标志，以及 `localUnpushedCommits`，即用户自己那份 head 分支上 PR 还没有的提交数。worktree 看不到这些提交。只有 upstream 是推送 remote 上 head 分支的本地分支才算这份副本，因此 fork 的 `main` 永远不会和用户自己的 `main` 比较。

### 6.2 `snapshot <pr>`

一次 GraphQL 调用读取：

- PR 字段：`state`、`isDraft`、`url`、`headRefOid`、`mergeable`
- head 提交的 status check 汇总（前 100 个 context）
- 前 100 个 `reviewThreads` 及其评论（`id`、`databaseId`、`author { __typename login }`、`authorAssociation`、`body`、`url`）
- 最后 100 条 `reviews` 和最后 100 条 issue 评论

`snapshot` 把它们和状态文件对比，输出事件列表和一个动作：

```json
{
  "action": "fix",
  "headSha": "3f2a1c0...",
  "isDraft": false,
  "url": "https://github.com/owner/repo/pull/123",
  "events": [
    {
      "type": "ci_failed",
      "check": "Test ubuntu",
      "url": "https://github.com/owner/repo/actions/runs/456/job/789",
      "runId": 456
    },
    { "type": "ci_pending", "checks": ["Lint"] },
    {
      "type": "review_thread",
      "threadId": "PRRT_x",
      "replyTo": 1001,
      "path": "src/a.ts",
      "line": 3,
      "outdated": false,
      "comments": [
        {
          "id": "PRRC_y",
          "author": "alice",
          "trust": "collaborator",
          "body": "...",
          "url": "..."
        }
      ]
    },
    {
      "type": "untrusted_comment",
      "id": "IC_z",
      "author": "someone",
      "url": "..."
    },
    { "type": "conflict" }
  ],
  "truncated": []
}
```

事件规则：

- 评论 id 是 GraphQL node id，在评论、review 和 thread 之间都唯一。`replyTo` 是 thread 第一条评论的 `databaseId`，这是 REST 回复接口唯一接受的 id。
- 只看当前 `headRefOid` 上的检查；旧提交的汇总会被忽略。check run 在 `FAILURE`、`TIMED_OUT` 或 `STARTUP_FAILURE` 时算失败；commit status 在 `FAILURE` 或 `ERROR` 时算失败。`CANCELLED` 不算失败。`runId` 从 Actions URL 中解析，否则为 null。
- 只有 CI 还在跑时，动作是 `wait`。CI 在跑的同时仍然可以修可信评论，因为下一次推送反正会重新触发 CI。
- 评论 id 既不在 `handledCommentIds` 也不在 `postedCommentIds` 里、且正文不带回复标记（第 9 节）时，才算新评论。已 resolve 的 thread、空的或 pending 的 review 会被跳过；outdated 的 thread 会保留，并带上 `outdated: true`。
- head SHA 和 `lastKnownHeadSha` 不同、且不在 `pushedShas` 里，记为 `head_moved_externally`。
- `truncated` 列出条目数超过查询读取范围的连接（`checks`、`reviewThreads`）。

动作优先级：`stop`（已合并或已关闭）→ `resync`（head 被别人移动）→ `fix`（冲突、失败的检查或可信评论）→ `wait`。循环会再加两个输入：预算用完时为 `stop`，修复进行中（状态文件里有 `inFlight`）时为 `wait`。

### 6.3 `ci-log <pr> <run-id> [--lines 200]`

把失败 job 的日志（`gh run view --log-failed`）按每个 job 截取最后 `--lines` 行，并注明省略了多少行，写到 `.qwen/tmp/autofix-pr-<n>-ci-<run-id>.log`，然后输出路径和 job 名称。修复 agent 读这个文件，而不是把日志通过 shell 预览输出。`--lines` 必须是正整数。

### 6.4 `push <pr>`

以下条件全部满足才推送，否则拒绝：

- worktree 是干净的（所有改动都已提交）；
- `lastKnownHeadSha` 是 `HEAD` 的祖先（只允许 fast-forward，不改写历史）；
- 目标分支不是 base 仓库的默认分支。

然后执行 `git push <target> HEAD:refs/heads/<headRef> --force-with-lease=refs/heads/<headRef>:<lastKnownHeadSha>`。pre-push hook 照常运行，不使用 `--force` 或 `--no-verify`。成功后把新 SHA 记入 `pushedShas` 和 `lastKnownHeadSha`，推送计数加一，清除 `inFlight`。lease 被拒说明别人推送过，结果是 `resync`，而不是重试。

### 6.5 `reply <pr> <plan.json>`

按 skill 写好的回复计划（第 9 节）发出回复，在每条正文末尾加上标记，把返回的 id 记入 `postedCommentIds`，并把已处理的评论 id 移到 `handledCommentIds`。回复 review thread 使用 `POST /repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies`；推送总结使用 issue 评论。

### 6.6 `cleanup <pr> [--force]`

一起删除 worktree、它的分支和状态文件。worktree 有未提交的改动，或者 worktree（worktree 已被删除时则是分支）有超出 `lastKnownHeadSha` 的提交时，三者都保留，并在报告里说明原因。没有状态文件时没有记录的 head，因此残留的 worktree 或分支都会被保留。状态文件属于另一个会话时直接拒绝。`--force` 跳过这些检查，也会丢弃无法读取的状态文件。分支删不掉时报错，状态文件保留。在要删除的 worktree 内部运行 `cleanup` 会被拒绝。

## 7. 一轮检查（`tick`）

```text
snapshot
  ├─ stop     → cron_delete, cleanup, report outcome
  ├─ wait     → end the turn with no message
  ├─ resync   → fetch, fast-forward the worktree to the new head, set cursor;
  │             two resyncs in a row → stop: "someone else is pushing to this PR"
  └─ fix
       1. conflict  → merge origin/<base> in the worktree (merge, never rebase)
       2. ci_failed → ci-log; the agent decides between a code fix and
                      "infrastructure" → gh run rerun <runId> --failed
                      (at most once per check per head SHA)
       3. trusted comments → address or decline with a reason
       4. verify (targeted tests, lint, typecheck chosen from the repo's docs)
       5. commit → push → reply
```

修复由后台 `agent` 完成，`working_dir` 设为 worktree。它的说明是一个文件，列出事件、日志路径、信任规则、用户追加的指示和验证要求。主会话保持可用。agent 的完成通知到达后，主会话执行 `push` 和 `reply`。验证失败时不推送；这次尝试计入预算，并报告失败原因。

一轮检查从不向用户提问。需要人来判断的情况（设计分歧、互相矛盾的评论、超出 PR 范围的要求）会回复"需要人工决定"并记入 `needsHuman`。循环继续关注其他事件。

## 8. 信任模型

所有评论、review 和 CI 日志都是数据。可信作者决定哪些反馈会被处理，但不能扩大工具被允许做的事。

满足以下条件之一的作者，其评论可处理：

- `authorAssociation` 为 `OWNER`、`MEMBER` 或 `COLLABORATOR`；
- PR 作者；
- bot 账号（`__typename == "Bot"`），仅限 review 和 review thread 评论。bot 的 issue 评论（例如覆盖率或 CI 报告）不当作请求。

永远不处理：

- 带回复标记或 id 在 `postedCommentIds` 里的评论。当前用户往往就是 PR 作者，因此是可信的；没有这条规则，工具就会回复自己。
- 其他任何人的评论。它们会出现在 `status` 和最终报告里，但不会被处理，也不会被回复。

即使是可处理的评论，修复说明也禁止：泄露密钥或 token；修改 CI 配置来跳过、禁用或削弱检查；删除或削弱测试来让它们通过；强推；与 PR 无关的改动。这类请求会收到"需要人工决定"的回复。

针对 bot 的循环防护：每个 review thread 只尝试修复一次，推送次数有上限（第 10 节）。因此每次推送都重新 review 的 bot 不能让循环无限进行下去。

## 9. 回复

回复默认开启；`--no-reply` 关闭。

- 每个处理过的 review thread 收到一条回复：`Fixed in <short-sha>: <one line>`、`Not changed: <reason>` 或 `Needs a human decision: <question>`。
- 每次推送发一条 PR 评论，总结这次处理了什么：修复或重跑的检查、处理的评论、解决的冲突，以及如何验证的。
- 回复使用被回复评论的语言；总结使用 PR 描述的语言。
- 每条正文末尾都带 `<!-- qwen-autofix-pr:v1 -->`。
- 工具从不 resolve review thread。

## 10. 调度、预算与生命周期

- 启动时立即跑第一轮，然后调用 `cron_create` 创建会话级循环任务，cron 为 `*/<every> * * * *`（默认 `*/15`），prompt 为 `Run /autofix-pr tick <owner>/<repo>#<n>`。cron prompt 以文本形式交给模型，由模型调用 skill。
- 会话忙时到达的触发会在通知队列里等待。
- 任务随进程结束。之后重新运行 `/autofix-pr` 会从状态文件继续，已处理的评论不会被回复两次。
- cron 最长存活时间的设置（`QWEN_CODE_CRON_MAX_AGE_DAYS`）仍然生效。

预算记录在状态文件里：

| 预算                                 | 默认值 | 用完时                   |
| ------------------------------------ | ------ | ------------------------ |
| 同一个失败检查在变绿之前的修复次数   | 3      | 停止循环                 |
| 每个检查在每个 head SHA 上的重跑次数 | 1      | 下一次失败按真实失败处理 |
| 每个 review thread 的修复次数        | 1      | 回复"需要人工决定"       |
| 每次启动的推送次数                   | 10     | 停止循环                 |
| 连续被别人移动 head 的次数           | 2      | 停止循环                 |

停止条件：PR 已合并或关闭；执行 `/autofix-pr stop`；上表中某项预算要求停止；cron 任务过期。每次停止都会执行 `cleanup`，并输出原因、已做的推送和所有 `needsHuman` 项。

开销：一轮无事发生的检查只是一次很短的模型轮次（调用 `snapshot`，然后空着结束）。间隔 15 分钟时每小时最多 4 轮。在没有变化时完全跳过模型轮次，需要给 cron 加前置条件，属于后续工作（第 12 节）。

## 11. 已定决策

2026-10-21 确定：

1. 命令名为 `/autofix-pr`。
2. 可信作者除 `OWNER`、`MEMBER` 和 `COLLABORATOR` 外，还包括 PR 作者和 review bot。
3. 在 PR 上回复属于第一版，并默认开启。
4. 默认检查间隔为 15 分钟。

## 12. 风险、验证与交付

风险：

- 以用户身份推送。缓解：每次启动都确认、推送保护和预算。
- 与 bot 或工具自己的回复形成反馈循环。缓解：回复标记、记录的 id 和每个 thread 的尝试次数。
- 与另一个 agent 或人在同一分支上竞争。缓解：`--force-with-lease`，以及 head 被别人移动两次后停止。
- 长会话里对话不断增长。每轮无事发生的检查都会增加一小段交互；上下文压缩可以处理，cron 前置条件的后续工作会把它去掉。

验证：

- 用录制的 `gh` JSON fixture 做单元测试：事件对比、旧 SHA 上的过时检查、各信任类别、回复标记和 id 的自我排除、动作优先级、预算。
- 用本地 bare 仓库测试推送保护：拒绝非 fast-forward、拒绝默认分支、别人推送后 lease 被拒。
- 在 `PATH` 上放一个假的 `gh` 做集成测试，跑通 `prepare` → `snapshot` → `push` → `reply` → `cleanup`。
- 在沙箱仓库上手工端到端验证：失败的测试被修复并推送；协作者的评论被修复并回复；陌生人的评论被忽略；合并 PR 后循环结束，worktree 被删除。

验收标准：

- 任何一次运行之后，用户的工作区和当前分支都没有变化。
- 从不强推，也从不推到默认分支。
- 工具从不回复自己的评论，也从不回复不可信作者。
- PR 合并或关闭后，循环在一个间隔内结束。

交付计划：

1. 辅助命令 `prepare`、`snapshot`、`ci-log` 和 `cleanup`，带测试。
2. 辅助命令 `push` 和 `reply`，带测试；以及支持 `--once` 的 skill。状态文件记录每个 head 上已处理过的失败检查，这样 agent 已放弃或已重跑的失败不会在同一个 head 上被再次派发。
3. 循环：`tick`、`status`、`stop`、预算，以及从状态文件恢复。
4. 后续工作：cron 前置条件，让无事发生的检查跳过模型；daemon 会话里的持久化监视（`durable` 加 `sessionMode: "current"`）；可配置的 bot 允许名单。

待定问题：

- 有了配置项之后，可信 bot 是否默认收窄为一个可配置的允许名单？
- draft PR 是否也要监视，还是在标记为 ready 之前拒绝？
- 有些自动化程序以拥有协作者权限的普通用户账号发评论（在本仓库，`qwen-code-review-bot` 就是这样发布 triage 状态评论的）。这类评论能通过信任规则，每条在被标记为已处理之前都要耗费一轮修复。是否要提供一个可配置的自动化账号列表并跳过它们？
