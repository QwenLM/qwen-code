# `/autofix-pr`：在本地盯住 PR 并自动修复

[English](2026-10-21-autofix-pr-command.md) | [简体中文](2026-10-21-autofix-pr-command.zh-CN.md)

状态：进行中。2026-10-21，同日在定时任务闸门（[2026-10-21-scheduled-task-gate.md](2026-10-21-scheduled-task-gate.md)，PR #15069）取代模型驱动的 tick 之后修订：触发层是定时任务上的 `gate`，本命令的探针——作者侧的 `snapshot --gate` 和评审者侧的 `review watch-repo`——已实现，与之一起实现的还有 `prepare`、`ci-log` 和 `cleanup` 辅助命令。交付第 3 步（2026-10-24）加上了反应层：`push`、`sync`、`reply`、`rerun` 辅助命令，以及带 `--once` 和 watch 模式的 bundled `/autofix-pr` skill。评审者监视、第 4 步的循环状态和第 5 步的后续工作仍是提案。[已定决策](#11-已定决策)中的四项产品决策于 2026-10-21 确定；第四项在该节中修订。

## 1. 问题

PR 提交之后，作者还得一直盯着：CI 在没测过的平台上失败，reviewer 留了评论，base 分支前进导致冲突。每一轮都不大，但都需要有人发现、同步分支、修改、验证、推送、回复。现在 Qwen Code 能在用户要求时完成其中每一步，但没有东西盯着 PR、自动开始下一轮。

`/autofix-pr` 在本地 Qwen Code 会话里补上这个闭环。它盯住一个 PR，在隔离的 worktree 里修复 CI 失败、review 反馈和合并冲突，把修复推到 PR 分支，回复它处理过的反馈，并在 PR 合并或关闭时停止。

## 2. 现状

这个命令在调度、隔离和委派上需要的能力，`main` 上都已经有了：

| 能力                    | 现有模块                                                                                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 周期触发                | `cron_create`（`packages/core/src/tools/cron-create.ts`）：会话级或持久化，循环任务带最多周期 10% 的抖动，会自动过期。触发进入通知队列，不会打断正在运行的轮次（`packages/cli/src/ui/hooks/use-llm-stream.ts`）。                   |
| 不经模型的触发          | 定时任务的 `gate`（[2026-10-21-scheduled-task-gate.md](2026-10-21-scheduled-task-gate.md)）：每次触发时在模型之外运行一条命令；没有输出就跳过这次触发、不产生回合，有输出就唤醒会话并把输出作为数据附上。下面的探针就是这样的命令。 |
| 循环约定                | bundled `loop` skill（`packages/core/src/skills/bundled/loop/SKILL.md`）、`cron_list` / `cron_delete`、CronPill。                                                                                                                   |
| 隔离的 PR worktree      | `qwen review fetch-pr`（`packages/cli/src/commands/review/fetch-pr.ts`）及其 git 辅助函数（`packages/cli/src/commands/review/lib/git.ts` 里的 `releaseWorktree`、`lib/worktree.ts` 里的 `redirectedAncestor`）。                    |
| 委派                    | 带 `working_dir` 和 `run_in_background` 的 `agent` 工具（`packages/core/src/tools/agent/agent.ts`）。                                                                                                                               |
| 确定性的 skill 辅助命令 | `qwen review <helper>` 模式：逻辑放在有测试的 CLI 子命令里，skill 通过 `"${QWEN_CODE_CLI:-qwen}"` 调用。                                                                                                                            |
| 冲突处理策略            | `/resolve` 设计（[2026-06-23-fix-conflicts-command.md](2026-06-23-fix-conflicts-command.md)）：merge base 分支，用 `--force-with-lease` 针对预期的 head SHA 推送。                                                                  |
| 不可信输入规则          | 仓库的 `.qwen/skills/autofix` skill 把 PR 文本、评论和日志当作数据，而不是指令。                                                                                                                                                    |

缺的是确定性的那部分：读取 PR 状态并算出自上次检查以来的变化，强制推送安全，以及发回复时不形成反馈循环。用 monitor 一直跑到条件满足不合适，因为 `monitor` 静默最多 10 分钟就会停，而一个 PR 可能几个小时都没有动静；带闸门的定时任务没有这个上限，PR 安静时也不花任何开销。

## 3. 目标与非目标

目标：

- 在本地会话里盯住一个 PR，响应 CI 失败、可信作者的 review 反馈和合并冲突。
- 绝不碰用户的工作区，绝不强推，绝不推到默认分支。
- 回复它处理过的反馈，让 reviewer 看到改了什么。
- PR 合并或关闭时、或尝试预算用完时自行停止，并说明原因。
- 只在有变化时唤醒会话；安静的检查不花模型回合。

非目标（第一版）：

- 没有打开 Qwen Code 会话时也能运行（没有云端执行器，没有 webhook）。
- 本地没有匹配 remote 的仓库里的 PR。
- resolve review thread。这个决定留给 reviewer。
- 新开 PR，或改写 PR 标题和描述。

## 4. 用户体验

```text
/autofix-pr [<pr-number>|<pr-url>] [--once] [--every <minutes>] [--no-reply] [--yes] [instructions...]
/autofix-pr status
/autofix-pr stop [<pr-number>]
```

- 不带 PR 参数：使用 head 是当前分支的那个 PR。
- `--once`：只跑一轮检查和修复，不调度任何东西。headless `-p` 下只能用这个模式。
- `--every`：检查间隔，单位分钟，取值 `1, 2, 5, 10, 15, 30, 60` 之一。默认 `2`：安静的检查只运行探针，不运行模型。
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
  ├─ fix                       agent, working_dir = worktree
  ├─ qwen autofix-pr push      guarded push, advances the cursor
  ├─ qwen autofix-pr sync      adopt a head someone else pushed
  ├─ qwen autofix-pr reply     post replies with a marker, record what a round handled
  ├─ qwen autofix-pr rerun     re-run an infrastructure failure, once per check and head
  ├─ qwen autofix-pr cleanup   remove worktree, branch and state file when safe
  └─ cron_create               session-only, recurring, gate:
                               "qwen autofix-pr snapshot <n> --gate --repo <owner>/<repo> --host <host> --session <sessionId>";
                               the prompt says how to handle the events the gate printed

qwen review watch-repo         the reviewer's probe: PRs opened, pushed or marked
                               ready since the last run, behind a gate of its own
```

辅助命令放在 `packages/cli/src/commands/autofix-pr.ts` 和 `packages/cli/src/commands/autofix-pr/` 下；评审者探针和其他 `qwen review` 辅助命令放在一起。每个 PR 的状态放在 worktree 旁边，不放在 worktree 里面，位于 clone 的主 worktree 下。分支由同一个 clone 的所有 worktree 共享，所以每个辅助命令从其中任何一个 worktree（包括 autofix worktree 本身）运行，都能找到同一次监视：

- worktree：`.qwen/tmp/autofix-pr-<n>/`
- 状态：`.qwen/tmp/autofix-pr-<n>-state.json`
- 闸门游标：`.qwen/tmp/autofix-pr-<n>-gate.json`
- 最近一次已准备快照：`.qwen/tmp/autofix-pr-<n>-snapshot.json`
- GitHub 对 bot 评论的答复：`.qwen/tmp/autofix-pr-<n>-replies.json`
- 日志、修复说明和回复计划：`.qwen/tmp/autofix-pr-<n>-*.{log,md,json}`
- 评审者游标：`.qwen/tmp/review-watch/<host>/<owner>/<repo>.json`

## 6. 辅助命令契约

### 6.1 `prepare <pr> --repo <owner>/<repo> [--host <host>]`

1. 用 `gh` 解析 PR。PR 已关闭或已合并、head 仓库已被删除、或 head 是默认分支时拒绝。
2. 动手之前先检查推送权限。同仓库 PR 要求仓库的 `viewerPermission` 为 `WRITE`、`MAINTAIN` 或 `ADMIN`。fork PR 要求当前用户就是 fork 的所有者，或者既有写权限又有 `maintainerCanModify`。否则拒绝并说明原因。
3. 要求本地恰好有一个 remote 和 base 仓库匹配（使用 `review match-remote` 背后的匹配逻辑）。
4. 确定推送目标。优先使用唯一一个和 head 仓库匹配、并且只推送到它的本地 remote：匹配器只读 fetch URL，所以该 remote 推送到的每一个 URL——它的 `pushurl`，或者多条 `url` 里的每一条——都用同一个匹配器再核对一遍，任何一个目的地在别处的 remote 都不算。没有的话，按 `gh config get git_protocol` 给出的协议使用 head 仓库的 URL。把结果记到状态文件里。
5. 状态文件就是锁。它记录会话 id（`QWEN_CODE_SESSION_ID`）；由另一个会话写下的状态文件直接导致拒绝。`/clear` 和 `/resume` 会给会话换一个新 id，而它的定时任务继续运行，所以在用户同意时，`prepare --take-over` 把监视（连同历史和预算）移交给发起请求的会话；被移交的那个会话的辅助命令从此拒绝执行，它的定时任务在下一次触发时停止：它的闸门写明创建它的会话（`--session`，即 `prepare` 报告的 `sessionId`），在那之前不推进游标——写游标之前会再确认一次监视归谁——只把它唤醒（`watched_elsewhere`）。
6. 把 `refs/pull/<n>/head` fetch 到本地分支 `qwen-autofix/pr-<n>`，并在它上面创建 worktree。`prepare` 从不丢弃之前的工作：残留的 worktree，或可能含有超出记录 head 的提交的残留分支，都会导致拒绝，并提示先运行 `cleanup`。
7. 在拥有这次监视的会话里重新运行 `prepare`，且 worktree 还在时，直接报告现有状态并带上 `resumed: true`，不再调用其他任何东西。如果 worktree 已被删除（包括用 `rm -rf` 删除，`git worktree prune` 会清掉它的登记），就重新创建它，并保留已记录的 `pushedShas`、`handledCommentIds` 和 `postedCommentIds`。状态文件属于另一个仓库的同号 PR 时直接拒绝。仓库按 GitHub 的方式比较：owner 和仓库名不区分大小写；host 不区分大小写、忽略默认端口，但保留其他端口，因为不同端口可能是不同的实例。
8. 输出 JSON 报告：worktree 路径、分支、head SHA、base/head ref、推送目标、当前用户和 PR 作者的 login、draft 和 fork 标志，以及 `localUnpushedCommits`，即用户自己那份 head 分支上 PR 还没有的提交数。worktree 看不到这些提交。只有 upstream 是推送 remote 上 head 分支的本地分支才算这份副本，因此 fork 的 `main` 永远不会和用户自己的 `main` 比较。

### 6.2 `snapshot <pr> [--repo <owner>/<repo>] [--host <host>] [--gate] [--session <id>]`

一次 GraphQL 调用（check context、check suite 或 review thread 每多一页再加一次；对开启线程的机器人评论，另有一次 REST 调用询问它是否在回答一条已删除的评论，见本节评论规则）读取：

- PR 字段：`state`、`isDraft`、`title`、`url`、`headRefOid`、`mergeable`、作者和当前用户
- head 提交的 check suite，从最新的读起，向前翻页直到最早的（最多五页，每页 100 个：推送创建的 suite 是一个 head 上最早的，之后每条 review 评论都可能再添一个）
- head 提交的 status check 汇总，翻页读到前 100 个 context 之后（最多十页；繁忙仓库上一个 head 远超 100 个，后面页上的失败绝不能被读成全绿）
- `reviewThreads`，翻页读到前 100 个之后（最多十页：thread 按创建先后排列，新 thread 在最后一页），每个 thread 带第一条评论的 `databaseId` 和最后 100 条评论（`id`、`databaseId`、`author { __typename login }`、`authorAssociation`、`body`、`url`、`state` 和 `replyTo`）
- 最后 100 条 `reviews` 和最后 100 条 issue 评论

汇总列出 head 上的每一次运行：被重跑的 job 的早先 attempt，以及在多个事件上触发的 workflow 的每一次触发。每个检查只看最新一次运行——check run 由 app、workflow（按 id 区分：两个 workflow 文件可能同名）、触发事件和 job 名确定，按运行 id 排序；commit status 由 context 确定，按创建时间排序——所以被重跑转绿的失败不会被报告。两个 app 发布同名的检查时算两个检查：分支规则可以要求其中任一个 app 的检查，所以一个的成功不会抵消另一个的失败。

不带 `--gate` 时，`snapshot` 把它们和 `prepare` 写下的状态文件对比，输出事件列表和一个动作。API 可能比推送晚几秒，所以当它的 head 与监视已知的不同时，`snapshot` 会直接询问分支（`git ls-remote`）：分支仍在已知 head 上，说明是 API 还没跟上，而不是别人推送了；这时 snapshot 不带那个过时 head 的检查和合并状态，保留评论，并标出 `lagging: true`：

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
      "runId": 456,
      "key": "Test ubuntu@3f2a1c0...@#789"
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

- 评论 id 是 GraphQL node id，在评论、review 和 thread 之间都唯一。`replyTo` 是 thread 第一条评论的 `databaseId`，这是 REST 回复接口唯一接受的 id；它单独读取，所以超过 100 条评论的 thread 也能拿到。
- 只看当前 `headRefOid` 上的检查；旧提交的汇总会被忽略。check run 在 `FAILURE`、`TIMED_OUT` 或 `STARTUP_FAILURE` 时算失败；commit status 在 `FAILURE` 或 `ERROR` 时算失败。`CANCELLED` 不算失败。`runId` 从 Actions URL 中解析，否则为 null。
- 只有 CI 还在跑时，动作是 `wait`。CI 在跑的同时仍然可以修可信评论，因为下一次推送反正会重新触发 CI。
- 评论 id 既不在 `handledCommentIds` 也不在 `postedCommentIds` 里、且不是工具自己的回复——即当前用户发的、正文以回复标记（第 9 节）结尾的评论——时，才算新评论。标记出现在别处（有人引用了一条回复）不会让评论被忽略。已 resolve 的 thread、空的或 pending 的 review、批准（它的正文表示接受这个 PR；其中的行内评论仍以 thread 的形式到达），以及被 dismiss 的 review（它已被撤回）会被跳过；outdated 的 thread 会保留，并带上 `outdated: true`。
- head SHA 和 `lastKnownHeadSha` 不同时，如果分支本身（对推送目标执行 `git ls-remote`）也已离开已知 head——包括回退到本监视早先推送过的 head——记为 `head_moved_externally`；分支仍在已知 head 上时，是 API 滞后（上文的 `lagging`）。读不到分支时，`pushedShas` 里的 head 视为本监视自己的。
- `title` 是 PR 的标题，这一轮的总结使用它的语言。
- GitHub 没能启动的 workflow（`STARTUP_FAILURE`，常见原因是 workflow 文件无效）在 rollup 里没有任何 check run——它是唯一的 workflow 时根本没有 rollup——只留下它的 check suite。在读到的 suite 里（如上所述向前翻页），每个 workflow 和触发事件只看最近一次运行，而且只看由 PR 代码触发的（`pull_request`、`pull_request_target`、`push`）：为每条 review 评论触发的运行在 GitHub 出问题时也会启动失败，与代码无关。它被报告为带 `startupFailure: true` 和 run id 的 `ci_failed`，每个 head 只报一次（`<workflow>@<head>@#startup:<workflow id>:<event>`），没有日志也没有可重跑的 job，所以 skill 把它答复为需要人工处理。
- 尚未提交的 review 里的评论（`PENDING`）是只有作者能看到的草稿，会被跳过。bot 在开启 thread 的评论（以及 review）里提要求；它在 thread 里的回复是在回答某人，不算请求。被回复的评论删除后，GraphQL 会丢掉回复的 `replyTo`，并把它列为 thread 的第一条，所以看起来像是开启了 thread、又尚未见过的 bot 评论，会通过 REST 逐条查询（`in_reply_to_id` 仍保留在这条评论上），只针对打开的 PR 上未解决的 thread，而且每条只问一次：答案保存在 `.qwen/tmp/autofix-pr-<n>-replies.json`，闸门、已准备快照和 `reply` 共用。期间被删除的评论不算请求。每条答案一拿到就保存。闸门每次触发最多问 20 条、不超出闸门的读取时限，遇到第一次失败就停，剩下的留到下一次触发，这次既不算请求也不记为已看过；一轮的快照则问完所有条目，GitHub 没有回应时直接失败，绝不丢掉闸门已经报告过的请求（`reply` 按闸门的方式询问：它的计划只会点名快照问过的 thread）；问了八分钟仍未问完时就停下，保留已有答案，并提示再运行一次。闸门也把 bot 的回复记为已看过。否则，会回复每条回复的评审 bot 会让每次都多跑一轮，不受信任的评论者也能借 bot 之口提要求，删掉自己的评论之后也一样。
- 失败的检查只有在它是 PR 所在仓库的 GitHub Actions job 时才带 `runId`（它的 suite 有 workflow run，URL 位于 `https://<host>/<owner>/<repo>/actions/runs/` 之下）：commit status 或其他应用的检查可以链接任意 run，`ci-log` 会去读它。
- 已合并或已关闭的 PR 只读第一次调用：它的结果就是停止，不需要再翻检查、suite 或 thread 的后续页。
- 监视属于 CLI 会话，其 id 保持不变。Managed Session 把每一轮、每一次闸门都作为各自的 Runtime Session 运行，所以辅助命令的会话检查会拒绝它的下一轮：探针可以充当 Managed 自动化的闸门——不写 `--session` 的闸门不做所有者检查——而监视本身暂不适用于 Managed Session。这样的闸门和同一 clone 里对同一 PR 的 CLI 监视共用闸门游标，先触发的一方会拿走另一方的迁移：请各用一个 clone。
- check 和 suite 属于提交而不属于 PR：同一个 head 提交的另一个 PR 会共用它们。这是已知的局限。
- 已准备模式把整个快照缩进后写到 `.qwen/tmp/autofix-pr-<n>-snapshot.json`，只输出一行：去掉事件的快照、事件数量和类型，以及文件路径（`snapshot`）。有一点历史的 PR 上，评论正文远远超出一行工具输出能显示的长度；这一轮读取该文件，修复说明列出修复 agent 要处理的条目，正文从该文件读取。正文写成按行的数组，超过 2,000 字符的行写成由若干片段组成的数组（绝不在一个字符中间切开），因为 `read_file` 按行分页，一次读取返回的内容超过 25,000 字符就截断；被这样截断的读取要从它最后显示的那一行重新读。
- `truncated` 列出条目数超过查询读取范围的连接（`checks`、`reviewThreadComments`、`reviewThreads`、`reviews`、`comments`）。

动作优先级：`stop`（已合并或已关闭）→ `resync`（head 被别人移动）→ `fix`（冲突、失败的检查或可信评论）→ `wait`。循环会再加两个输入：预算用完时为 `stop`，修复进行中（状态文件里有 `inFlight`）时为 `wait`，直到这次尝试结束（第 7 节）。

#### 闸门模式（`--gate`）

`snapshot <n> --gate` 是定时任务闸门背后的那条命令。它不需要 worktree，也不需要状态文件：首次运行用 `--repo` 指定 PR 所在的仓库（或由已准备好的状态提供），它自己的游标 `.qwen/tmp/autofix-pr-<n>-gate.json` 记录已经报告过的内容。没有 `--host`（或 `GH_HOST`）时，先用该 PR 已在监视的 host——游标里的，或已准备状态里的——最后才回落到 github.com；空白的 `--host` 会被拒绝。游标属于另一个仓库的同号 PR 时直接拒绝，比较方式与 `prepare` 比较状态文件相同。它输出同样的 JSON，但只包含自上次运行以来的迁移，没有迁移时什么都不输出，因此会话只会为迁移被唤醒：

- 失败的检查按（检查，head，attempt）报告一次；由 review 或评论启动的 workflow，其 attempt 是 workflow 加触发事件（`#on:<workflow id>:<event>`）：任何人每提交一次 review 它都会再跑一次，而已处理过的失败再跑一次，对代码没有新信息。一轮在这个 head 上重跑过它、或延后了它的重跑之后（`rerunChecks` 记下那个 check run，延后则记在 `heldChecks` 里），之后那次运行的失败就是重跑的回答，以 `#rerun:<workflow id>:<event>` 再报告一次；被重跑的那次运行保留原来的键，所以 GitHub 还没列出的重跑、或回答丢失的重跑，都不会被当成它。游标键带上运行 id（commit status 则是它的创建时间），所以重跑后再次失败的检查会再次报告，即使没有任何一次轮询看到它处于运行中。游标只保留仍然存在的失败，新的 head 从头开始。同一 PR 的已准备监视不靠推送处理掉的失败（`handledChecks`）视为已报告。因为 run 仍在进行而延后重跑的失败（`deferredRuns`，第 6.9 节）在该 run 进行期间不报告（prepared snapshot 也不列出它）——只指延后时保留的那些 check run，不包括该 run 里延后之后才失败的 job——在 run 结束时再报告一次，以便监视那时重跑它，除非某一轮此后已回答了它的键。不指明运行的键（`#on:`、`#rerun:`）对该检查在这个 head 上的每次运行都相同：游标记下报告它时的那次运行，所以之后某次运行的失败（某一轮读 PR 时有 review 启动了这次运行）会再报告，直到某一轮处理了这个键；更早一次运行的失败（某次部分读取只列出了它）则不会。run 的结束按该 run 最新的 check run 标记：run 里重跑某个 job 会让 run 再次运行，对它的第二次延后也会再结束一次。被跳过的 job（`if:` 为假）没有运行过，永远不会取代它之前的那次运行。
- 进行中的检查从不报告；不会出现 `ci_pending`。
- 冲突按 head 报告一次；`mergeable` 清除标记，`UNKNOWN` 保留标记。已准备监视在该 head 上留给人处理的冲突（`handledConflictSha`）不报告。
- 评论、review 和 thread 评论按 node id 各报告一次，沿用第 8 节的信任规则。工具自己的回复（当前用户发的、以回复标记结尾的评论）永远不是事件，同一 PR 的已准备监视处理过的评论（`handledCommentIds`、`postedCommentIds`）也不是；其中查询结果里还在的会被并入游标，所以 `cleanup` 删掉状态文件之后它们仍然保持安静。只有不可信评论时作为提醒报告（`wait`）。查询结果里仍然出现的已报告 id 全部保留在游标里，不论多少；只有已经离开页面的 id 才有上限，所以内容相同的轮询是安静的。正文截到前 1,000 个字符（`bodyTruncated: true`）；完整内容见事件的 `url`。
- head 与上次运行不同时记为 `head_moved_externally`（`resync`），除非同一 PR 的已准备监视记录过或推送过它（`lastKnownHeadSha`、`pushedShas`）；首次运行只记录 head，不报告。
- 合并或关闭报告一次（`stop`）；之后探针保持安静，重新打开的 PR 会再次被监视。
- 从头读取的连接（`checks`、`reviewThreads`）开始被截断时报告一次，没有其他事件时动作为 `wait`：超出最后一页的新 thread 不会留下别的痕迹。持续的截断保持安静。评论、review 和 thread 评论从最新的读起，那里的截断只会藏住更早的内容：它列在 `truncated` 里，但不唤醒会话。例外是刷屏：两次检查之间到达超过 100 条时，会把一条还没被任何检查读到的挤出去。这是已知的局限；该轮在报告里会写明截断。
- 一次闸门运行读取 GitHub 最多 15 秒，在 Managed 自动化 20 秒的闸门之内（定时任务允许 60 秒）：超时后停止翻页，没读到的部分保持截断。时限在每次调用之前检查，所以临近时限才发出、而 GitHub 回答得慢（或 `gh` 在 5xx 后重试）的那次调用，仍可能让这次触发超出闸门的限制；这次触发会在写游标之前失败，下一次重新读取。被截断的运行不唤醒任何人，也不改动截断记录：没读到的部分随 GitHub 的快慢时有时无。截断在 check run 里的，还保留已报告过的失败；截断在其后读取的 suite 里的，保留已报告过的启动失败；只截断在 review thread 里的，检查已全部读到，只保留仍然存在的失败。rollup 按从旧到新列出一个检查的各次运行，所以截断在 check run 里的读取可能列出某个检查较早的一次、而没有列出最新的一次：游标保留上一次完整读取看到的每个检查的最新运行（`latestChecks`），截断的读取不把较早的运行报告为失败，也不报告延后 run 的结束（连同它的失败）——那要等一次完整读取。GitHub 一直这么慢时，闸门读到的页之外的内容——检查失败、较新的 review thread——要等别的事项启动一轮才会被看到，那一轮会全部读取；页数上限对每次运行都一样——check run 的上限也是，不论其后的 suite 被时限截断与否——照旧报告一次。
- 输出不超过 12 KiB——按闸门转交时的形式计算，每个 `<` 写成 `&lt;`——低于闸门交给会话的 16 KiB（超出部分会被闸门截掉）。事件按顺序排列——head 移动、冲突、失败、评论——放不下的事件，或放不下整体的 thread 里靠后的评论，会被留下，计入 `deferred`，且不记为已报告，所以下一次运行会报告它们。每次至少输出一个事件或一条评论，所以每次运行都有进展。
- 首次运行报告所有尚未处理的事项：失败的检查、冲突，以及没人处理过的评论。

游标在输出之前写入，所以打印之后崩溃的探针不会把同一批迁移报告两次。`ci_pending` 和安静 PR 的 `wait` 动作只存在于已准备模式。

### 6.3 `ci-log <pr> <run-id> [--lines 200]`

把该 run 中已结束且失败或超时的每个 job 的日志在该 job 最后一行 `##[error]` 之后截断（之后是 post-job 清理步骤），再按 job 截取最后 `--lines` 行，并注明省略了多少行，写到 `.qwen/tmp/autofix-pr-<n>-ci-<run-id>.log`，然后输出路径和 job 名称。修复 agent 读这个文件，而不是把日志通过 shell 预览输出。`--lines` 必须是正整数。某个 job 的日志读不到时，用一行 `log unavailable: <reason>` 代替它的日志，其他 job 照常写入。run 里没有已结束且失败或超时的 job（失败的 job 还在跑，或在任何 job 开始前就启动失败）时报错，而不是写一个空文件。job 列表每页 30 个（大型重跑 run 的 100 个一页，GitHub 会回 502）；从开始算起满八分钟（在 shell 工具的十分钟之内）后，剩下的 job 写成 `log unavailable`，不再读取。每份日志一到就截成要保留的行，所以一个 run 的大量大日志不会同时留在内存里。

每个 job 的日志通过 REST jobs 接口读取，而不是 `gh run view --log-failed`：`gh run view`（加不加 `--job` 都一样）会拒绝仍在运行的 run，而 `snapshot` 在一个 job 失败时就会报告它，这时同一 run 的其他 job 可能还在跑。

### 6.4 `push <pr>`

以下条件全部满足才推送，否则拒绝：

- worktree 是这次监视自己的：不是符号链接、是独立的 worktree，并且检出的是 `qwen-autofix/pr-<n>`（修复时如果切到了用户自己的那份 PR 分支，不能把那个分支推出去）；
- worktree 是干净的（所有改动都已提交）；
- `lastKnownHeadSha` 是 `HEAD` 的祖先（只允许 fast-forward，不改写历史）；
- 目标分支不是 base 仓库的默认分支。

推送时向 GitHub 现查，而不是沿用 `prepare` 时的结果：期间已合并或关闭的 PR 回答 `stop`；默认分支也重新读取，因为监视期间它可能被改名。推送的分支和目的地按 `prepare` 的方式从 GitHub 和 clone 的 remote 重新得出，必须与状态文件记录的一致，所以改过的状态文件无法改变推送去向。状态文件里会交给 git 的值——remote、推送目标、head ref、各个 SHA——在读取时都会检查，以 `-` 开头的值会被当成选项。推送次数已用完（10 次，第 10 节）的监视直接回答 `stop`，不再询问任何东西。`HEAD` 等于已知 head 时没有可推送的内容。

然后在 worktree 里执行 `git push --porcelain <target> <sha>:refs/heads/<headRef> --force-with-lease=refs/heads/<headRef>:<lastKnownHeadSha>`，给 pre-push hook 留九分钟（skill 给这次 shell 调用设置工具允许的最长超时，十分钟，所以辅助命令仍能记录结果）。`<sha>` 是通过上述检查的那个提交，而不是 `HEAD`——询问 GitHub 期间 `HEAD` 可能会动。hook 照常运行，不使用 `--force` 或 `--no-verify`。会访问远端的命令——这次推送、`sync` 和 `prepare` 的 fetch、`ls-remote`——保留用户自己的传输设置（`GIT_SSH_COMMAND`、`GIT_SSH`、`GIT_ASKPASS`、`GIT_PROXY_COMMAND`、`GIT_CONFIG_GLOBAL`、`XDG_CONFIG_HOME`），其他 git 调用都会去掉这些设置，所以它们和用户自己的 `git push` 一样连接和认证。只推送这一个 ref：`--no-follow-tags` 和 `--recurse-submodules=no` 让 `push.followTags`、`push.recurseSubmodules` 不会顺带推送标签或子模块分支。成功后把新 SHA 记入 `pushedShas` 和 `lastKnownHeadSha`，推送计数加一。lease 被拒（`[rejected] (stale info)`，或者 `git ls-remote` 看到远端分支已不在已知 head 上——不依赖 git 输出的语言）说明别人推送过，结果是 `resync` 而不是重试，什么都不记录。响应丢失但远端已经收下提交的推送，按已推送记录。推送前远端就已持有的提交——别人推送的，或者之前某次推送没有被记录——不计为这一次推送：回答 `resync`，由 `sync` 接纳为已知 head，下一次 `push` 便无可推送。skill 随后把这一轮的提交视为已在该 head 上推送，因为该 head 包含它们。其他拒绝——hook、分支保护、凭据——都是错误，附上 git 的最后几行。输出是一行 JSON：`{"pushed": true, "sha", "pushes", "maxPushes"}`；`{"pushed": false, "action": "resync" | "stop", "reason"}`；或者在 `HEAD` 就是已知 head、无可推送时，回答不带 `action` 的 `{"pushed": false, "reason"}`——skill 把没有 `action` 理解为"修复没有留下提交"。和 `sync` 一样，推送时也会记下 GitHub 此刻给出的 PR base 分支：监视期间 PR 可能被改到别的 base，而这一轮的修复说明合并的是记录下的 base。

### 6.5 `reply <pr> <plan.json> [--no-post]`

按 skill 写好的回复计划（第 9 节）发出回复，并记录这一轮处理了什么。计划格式：

```json
{
  "replies": [
    { "replyTo": 1001, "body": "Fixed in 3f2a1c0: ...", "handled": ["PRRC_x"] }
  ],
  "summary": { "body": "...", "handled": ["IC_y"] },
  "handled": ["PRR_z"],
  "handledChecks": ["Test ubuntu@<head>@#789"],
  "handledConflict": false
}
```

能发什么由辅助命令决定，依据是重新读一次 PR（按 prepared snapshot 的规则）：

- 回复只发到此刻有可信作者新评论的 thread，`handled` 列出的必须是该 thread 的评论。不可信评论不能标记为已处理；check 键必须是 head 上某个 `ci_failed` 事件报告的（prepared 模式会输出它的 `key`）——此刻报告的，或这一轮的 prepared snapshot 文件里报告过的：一轮运行期间 head 可能已越过某个失败（重跑、review 启动的运行），这一轮对它的回答仍然有效，记在由 review 启动的 workflow 在该 head 上下一次失败会带的那个键下。延后在其 run 运行期间保留的失败（第 6.9 节）不记录（计入 `ignoredChecks`）：run 结束时闸门会再报告一次，或报告该检查之后某次失败的运行，那一轮再回答它。这一轮见过的其他失败照常记录，包括被延后的 run 里延后之后才失败的 job：闸门不会再报告它；冲突只有在确实存在时才能留给人处理。PR 必须仍处于打开状态。
- 判断计划所依据的 head 是监视已知的那个（`sync` 和 `push` 从分支读取），而不是 API 的——API 可能比推送滞后。
- 其他 head 的失败键（这一轮已推送越过了它）被忽略并计入 `ignoredChecks`：prepared snapshot 只读当前 head。根本不是失败键的字符串会被拒绝。`handledConflict` 只在 GitHub 报告冲突时，或者在本监视推送的 head 上报告 `UNKNOWN` 时，才记在当前 head 上：推送刚完成时 GitHub 会报告 `UNKNOWN`，直到重新算完合并。
- 同一 thread 有两条回复，或同一个评论 id 出现两次的计划会被拒绝。
- 所有检查在发出任何内容之前完成，被拒绝的计划什么都不发。
- 每次 POST 之前先在状态文件里登记（`pendingPosts`：发往哪里、回复哪些评论、正文的哈希、发帖时的 head——之后认领的总结只算作那个 head 的推送，而不是更晚的推送）。下一次运行会在 PR 上找每条登记过的回复：找到的——POST 已到达 GitHub 但响应丢失——按它当初回复的那些评论记录（`adopted`）；找不到的说明从未发出。回复永远不会按之后计划的措辞来认，为别的评论发的回复也永远不会被当成对新评论的回答。
- 回复里列出的评论如果已经回答过，就从这条回复里去掉；回复仍会回答其余评论，所以一轮运行期间新来的评论不会没人回答。
- 每条正文只加一次标记，且必须在 GitHub 的 65,536 字符以内。
- 每个发出的 id 一产生就写入状态文件，连同它所回复的评论。中途失败时，其余部分不发也不记录；用同一份计划重跑时会认出已发出的内容（见上），回复的评论全部已处理才跳过，评论都已处理的总结也跳过——除非该 head 是本监视推送且尚无总结：每次推送都有一条总结，每个 head 一条（记在 `summarizedSha`），不论它是否回答评论。
- `handledChecks` 和 `handledConflict` 记录这一轮没有靠推送修好的失败和冲突，prepared snapshot 不再报告它们：失败按 attempt 记（重跑后再次失败算新的），冲突按 head 记。
- `--no-post`（skill 的 `--no-reply`）记录同样的内容（包括总结的 `summarizedSha`），但不发任何东西。

回复 review thread 使用 `POST /repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies`；总结是一条 issue 评论。两种 POST 都不重试：在传输错误之前已到达 GitHub 的请求会发出两次。

### 6.6 `cleanup <pr> [--force]`

一起删除 worktree、它的分支和状态文件。worktree 有未提交的改动（包括未跟踪文件和子模块里的改动，不受 `status.showUntrackedFiles` 或子模块的 `ignore` 设置影响），或者 worktree（worktree 已被删除时则是分支）有监视已知的任何 PR head 都不包含的提交时，三者都保留，并在报告里说明原因。已知的 head 是 `lastKnownHeadSha` 和 `pushedShas`，以及——只在前两者比完仍有多出的提交时才去问——远端的 PR head（`refs/pull/<n>/head`），所以手工推送过的工作不会被拦住。worktree 路径上的目录如果不是独立的 worktree，会被保留：在它里面运行 git 会判断外层 clone。没有状态文件时没有记录的 head，因此残留的 worktree 或分支都会被保留。状态文件属于另一个会话时直接拒绝。`--force` 跳过这些检查，也会丢弃无法读取的状态文件。分支删不掉时报错，状态文件保留。在要删除的 worktree 内部运行 `cleanup` 会被拒绝。闸门游标不会被删除：它属于定时任务，而定时任务比一次监视活得久，没有游标的话下一次触发会把所有内容重新报告一遍。要停掉闸门，就删除该任务。报告里会写出保留的游标（`gateCursor`）：之后对另一个仓库同号 PR 的闸门会被拒绝，直到删除这个文件。

监视发出和处理过的内容——`handledCommentIds`、`postedCommentIds`、`handledChecks`、`rerunChecks`、`handledConflictSha`，以及已登记但尚未结算的回复（`pendingPosts`）和延后的重跑（`deferredRuns`、`heldChecks`）——后两者取监视自己当前的列表（它们本就从历史开始，之后已结算的不能再回来）——会在删除状态文件之前并入该 PR 的历史 `.qwen/tmp/autofix-pr-<n>-history-<host>+<owner>+<repo>.history.json`（同一个 clone 可能监视 fork 和上游里同号的 PR；`+` 和代替端口 `:` 的 `@` 不会出现在任何名字里，后缀也永远不会与 skill 可写的文件名重合），这个文件同样保留（报告里的 `history`）。`--force` 还会删除这次监视的锁，以防某个辅助命令在持锁时被杀掉。之后对同一 PR 的新监视在 `prepare` 时从它开始，所以不会再回复之前监视回复过的评论，也不会在同一 head 上把一个检查重跑两次；另一个仓库同号 PR 的历史会被忽略。

### 6.7 `review watch-repo --repo <owner>/<repo> [--host <host>] [--limit 50] [filters]`

评审者的探针，有自己的闸门。一次 GraphQL 调用读取最近更新的打开 PR（`--limit`，默认 50，最多 100）及其 head、draft 标志、作者、label 和评审请求，以及上限之外是否还有打开的 PR。游标 `.qwen/tmp/review-watch/<host>/<owner>/<repo>.json`（全部小写，端口前的 `:` 写成 `_`，所以同一仓库的各种拼写共用一个文件）记录每个打开 PR 的 head 和 draft 标志。带过滤项时文件为 `<repo>@<key>.json`，`<key>` 代表这组过滤项，与拼写和顺序无关：同一仓库上过滤项不同的两个任务各自保存 head，因为一个任务记下却因过滤而没有报告的推送，对另一个任务永远不会再是迁移：

- 首次运行记录打开的 PR，不输出任何内容。
- 之后，游标里没有的 PR 是 `pr_opened`，head 变化的是 `pr_pushed`，原来是 draft 现在不是的是 `pr_ready`。每个事件带编号、标题、作者、URL、head SHA、base 分支、label，以及是否请求了当前用户评审。
- 过滤项决定哪些 PR 成为事件：`--author <login>`、`--label <name>`（两者都像 GitHub 一样不区分大小写）、`--review-requested`（当前用户是被请求的评审者；team 请求不算）、`--exclude-drafts`、`--exclude-bots`、`--exclude-mine`。游标无论如何都跟踪每个 PR，换一组过滤项会使用自己的游标，其首次运行是静默的，所以更改过滤项不会重放历史。过滤项只在三种迁移中做选择，本身不是迁移：head 不变时加上 label 或请求评审不会输出任何内容，直到 PR 下一次推送。
- 列表里没有的 PR 已关闭或合并，会从游标中移除——除非列表被 `--limit` 截断。此时列表外的 PR 可能仍然打开，游标最多保留其中 `--limit` 个，编号大的优先，因为已关闭和已合并的 PR 无法区分，不设上限就会不断累积。被挤出游标、之后又有变化的打开 PR 会以 `pr_opened` 再次出现。

输出：`{ "repo": "<owner>/<repo>", "events": [...] }`，没有事件时什么都不输出。与作者侧闸门同样以 12 KiB 为限，放不下的事件被留下并计入 `deferred`；这些 PR 在游标里保留旧的 head，所以下一次运行会报告它们。使用它的 skill 决定每个事件的含义：对每个 PR 运行 `/qreview <number>` 或一次验证。

### 6.8 `sync <pr> [--discard]`

接纳别人推送的 head。它从推送目标读取 PR 分支——也就是推送 lease 保护的那个 ref，它会立即变化，不像 `refs/pull/<n>/head` 有延迟——取到 worktree 自己的 `FETCH_HEAD`（不碰用户的 checkout），并像 `push` 一样检查 worktree。然后：

- 不包含已知 head 的新 head 改写了历史：作者 rebase、force-push，或把分支回退了（可能退到本监视推送之前）。worktree 按第 7 节所述重置到新 head：在旧历史上构建的任何东西都会把作者删掉的内容放回去。在旧历史上做的未推送尝试报告为 `dropped`；
- 建立在已知 head 之上、且 worktree 已经包含的新 head（某一轮合并过），记为 `lastKnownHeadSha`，已检出的子模块按下文所述跟着移动。回答里带有 `unpushed`：worktree 持有而 PR 没有的提交数——这一轮自己的工作，或者某一轮没有结束就留下的工作，skill 会在一轮开始前丢弃后者；
- worktree 落后于它且是干净的，就 fast-forward；
- worktree 有某一轮未推送的提交时不动它：回答 `{"synced": false, "action": "merge"}` 并给出要合并的 head（不要 rebase），什么都不改。

有未提交改动的 worktree 永远不会被移动或重置。`--discard` 把 worktree 恢复到 PR head（修复切到别的分支时先结束它停在半途的 merge、rebase、cherry-pick、revert 或 `am`，再切回监视分支，那个分支保留它的提交），不管里面有什么——未推送的提交和未提交的改动，包括嵌套仓库（`git clean -ffd`）和已检出子模块里的改动（`git submodule foreach`，从不碰未检出的子模块）——用来结束一轮没能推送的工作，并报告丢弃了什么。之后 worktree 仍不干净时回答 `{"synced": false, "reason"}`。`sync` 每次移动 worktree 时，都以同样方式把已检出的子模块移到新 head 记录的提交上，子模块缺少的提交从它自己的远端获取（PR 的 fetch 不递归进子模块，所以取不到的子模块提交不会让它失败）。`foreach` 只用来列出已检出的子模块，每条记录以 NUL 结尾（PR 指定的路径里可能有换行，按行读取时换行之后的内容会被当成另一个子模块）；fetch（每个子模块有自己的一分钟时限，一次 `sync` 的所有子模块合计三分钟，并沿用 git 对子模块的协议限制）和 reset 都在它之外执行，因为 `foreach` 启动的子进程会活过只杀掉顶层 git 的超时，在 `sync` 返回之后继续改动子模块（超时的 fetch 会被杀掉；它启动的传输进程可能留到连接结束，但只会下载对象）。子模块逐层对齐，所以嵌套的子模块在父模块移动之后才取父模块记录的提交；worktree 已包含 PR head（某一轮合并过）时也会对齐——合并移动的是 gitlink，而不是已检出的子模块。这条路径事先没有检查未提交的改动，所以在这里，持有自己工作的子模块（有未提交的改动，或 HEAD 不被记录的提交包含）保持原样。列出的子模块只有同时满足以下条件才会被处理：位于 worktree 内部、是它自己仓库的顶层、git 目录在父仓库的 `modules` 目录下（`git submodule` 放置的位置）或在它自身内部。否则，在普通目录里 `git -C` 会找到外层仓库；通过指向别的仓库或目录的 `.git` 文件或 `core.worktree`，reset 会移动那个仓库的分支，或写入那个目录。不论 `submodule.recurse` 怎么设，reset 都不递归进子模块；之后仍不干净则回答 `synced: false`，所以修复永远不会把子模块提交回旧的提交。读不到 PR 分支时（PR 已关闭、分支被删、网络不通），改为恢复到监视上次知道的 head。

和 `push` 一样，`sync` 先向 GitHub 查 PR 的 head 分支，并对照 clone 的 remote 检查目的地，所以改过的状态文件无法让 fetch 指向别的 ref 或仓库；head ref 按分支名规则校验（`git check-ref-format --branch`），因此不能夹带 refspec。它还会记下 GitHub 此刻给出的 PR base 分支。`remote` 和 `baseRefName` 会被这一轮的修复说明写进修复 agent 的合并命令，所以必须是不含 shell 特殊字符的分支名（名字含这类字符的 PR 或 remote，`prepare` 会拒绝）。辅助命令从状态文件读取的每个列表都必须是类型正确的列表；历史文件里格式不对的字段会被丢弃，其余部分照常合并。

### 6.9 `rerun <pr> <run-id>`

对修复 agent 判断为基础设施问题的 run，用 `gh run rerun <run-id> --failed` 重跑其失败的 job，只针对打开的 PR。只认 PR 所在仓库的 GitHub Actions job：commit status 或其他 app 可以链接任意 URL，从中读出的 run id 会重跑某个无关的 run。该 run 最新一次 attempt 里的每个失败或被取消的 job 都用掉它所属检查唯一的一次重跑——在 PR 上已被该检查更晚一次运行取代的 job 也一样，因为 `--failed` 也会重跑它（`rerunChecks`，按检查身份——app、workflow、触发事件和 job 名，与第 6.2 节区分检查的方式相同——和 head 记，所以两个 workflow 里同名的 job 各有各的一次，并记下该检查之后的运行必须晚于哪个 check run 才算重跑的回答，第 6.2 节据此定键：这个 job 的，或者 PR 上已有更晚的运行时，该检查最新的那个）；如果其中有检查已在这个 head 上重跑过，回答 `{"rerun": false}`，该失败按真实失败处理。被重跑的 attempt 记入 `handledChecks`，所以重跑期间 prepared snapshot 不会再派发它们；重跑后再次失败是新的 attempt。head 在监视上次看到之后移动过时回答 `resync`；head 上没有失败检查的 run 是错误。重跑在询问 GitHub 之前就计数，调用本身也不重试，所以响应丢失的重跑不会被再请求一次：最多一次，绝不两次。只有 GitHub 接受了重跑，其失败才记为已处理：被拒绝（gh 的 `run <id> cannot be rerun`，即 403——token 没有 `actions: write`、run 太旧——或其他 HTTP 4xx）会退还这次重跑（包括延后时保留的那次），而任何错误都会让这一轮把这些失败作为需要人工处理来回答，所以检查不会一直红着却无人报告。

GitHub 只在 run 结束后才能重跑它，而 `snapshot` 在 job 一失败就报告。因此仍在进行的 run 不询问 GitHub，直接回答 `{"rerun": false, "deferred": true}`，并记入 `deferredRuns`：该 run 结束时闸门会再报告一次它的失败（第 6.2 节），届时那一轮再重跑。在那之前 prepared snapshot 也不列出它们，这样别的事件不会把同一个失败再交给这一轮延后一次。延后为它的每个失败检查保留那一次重跑（记在 `heldChecks` 里，与已花掉的 `rerunChecks` 分开，带上该 run 的 id 和被延后的 check run，所以别的 run 花掉的重跑永远不会被当成这个 run 保留的），也只隐藏这些 check run：该 run 里延后之后才失败的 job 立即交给这一轮，不论 run 还要跑多久。该 run 结束时重跑它——这次重跑（或回答丢失）会把该 run 的所有保留都算作已花掉，包括在 run 里已不再失败的检查（单独重跑过的 job 已经用过它的重跑）；而在该 head 上这个检查更晚的一次运行——比如它结束前某次 review 启动的运行——视同重跑的回答，以重跑的键报告（第 6.2 节），并按真实失败处理。同一 workflow 里同名的两个 job 算同一个检查：第二个在延后之后才失败时，那次重跑已由第一个占用，run 结束后第二个按真实失败处理。这是已知限制。

`push`、`sync`、`reply` 和 `rerun` 在读写状态文件期间都持有这次监视的锁（`.qwen/tmp/autofix-pr-<n>.lock`）：否则模型同时发出的两个辅助命令调用会各自写回自己读到的内容，抹掉对方关于推送、回复或重跑的记录。`prepare` 在创建 worktree 和状态文件期间也持有它，所以同时进行的两次启动不会回滚或接管对方的 worktree。锁以硬链接的方式整体创建（链接到一个已写好令牌的文件），并且只在仍持有自己令牌时才删除。沙箱可能让每条命令运行在独立的 pid 命名空间里，pid 会重复，所以只在同一命名空间里才检查持有者的 pid；其他锁在存在时间超过任何辅助命令的运行时长（十五分钟）后被接管，`cleanup --force` 则会立即删除它。过期锁一次只由一个辅助命令打破，在独占的 `<lock>.break` 文件保护下进行（被杀掉的辅助命令留下的 `.break` 在一分钟后清除，不论时钟偏前还是偏后）；此时锁里仍是过期令牌，就用一次 rename 把它替换成打破者自己的令牌，所以锁路径从不出现空档让别的辅助命令趁机拿到，新的锁也永远不会被动到。

## 7. 一轮检查（`tick`）

闸门已经运行了 `snapshot --gate`；到达模型的触发在闸门输出里带着事件，所以安静的检查永远不会变成一个回合。

```text
snapshot --gate (in the gate)
  ├─ stop     → cron_delete, cleanup, report outcome
  ├─ wait     → end the turn with no message
  ├─ resync   → fetch, fast-forward the worktree to the new head, set cursor,
  │             then handle the other events of the same output (the gate
  │             does not report them again);
  │             two resyncs in a row → stop: "someone else is pushing to this PR"
  └─ fix
       1. conflict  → merge origin/<base> in the worktree (merge, never rebase)
       2. ci_failed → ci-log; the agent decides between a code fix and
                      "infrastructure" → gh run rerun <runId> --failed
                      (at most once per check per head SHA, and only once
                      the run has finished: GitHub refuses to rerun a run
                      in progress); when ci-log finds no finished failed
                      job (the run failed before any job started), there
                      is no log to fix from: re-run it under the same
                      rule and report it, and once re-run, report it as
                      needing a human
       3. trusted comments → address or decline with a reason
       4. verify (targeted tests, lint, typecheck chosen from the repo's docs)
       5. commit → push → reply
```

修复由 `agent` 完成，`working_dir` 设为 worktree。它的说明是一个文件，列出事件、日志路径、信任规则、用户追加的指示和验证要求。交付第 3 步里 agent 在前台运行——`agent` 工具只能在前台运行带 `working_dir` 的 agent，因为 worktree 归调用方所有——它返回后主会话执行 `push` 和 `reply`；在后台修复、期间主会话保持可用，属于交付第 4 步。验证失败时不推送；这次尝试计入预算，并报告失败原因。

`inFlight` 记录一次尝试开始时的 head 和时间。尝试的每种结束方式都会在计入这次尝试之后清除它：推送、验证失败、agent 出错或被停止、推送被 lease 拒绝，以及 resync。tick 发现 `inFlight` 开始于一个已经不是 PR 当前 head 的提交，或开始时间早于尝试时限（第 10 节）时，把它记为失败并清除，所以 agent 中途死掉的尝试不会让监视一直等待。

resync 时如果新 head 不包含 worktree 的 `HEAD`（作者 rebase 或 force-push 了），worktree 会被重置到新 head，而不是快进。工具推送过的内容此时已在作者手中，是作者改写的那段历史的一部分。重置最多丢掉一次没有推送的尝试，它基于旧的 head，`push` 本来也会拒绝它；这次尝试按上面的规则结束。

一轮检查从不向用户提问。需要人来判断的情况（设计分歧、互相矛盾的评论、超出 PR 范围的要求）会回复"需要人工决定"并记入 `needsHuman`。循环继续关注其他事件。（交付第 3 步在 PR 上回复这类事项并在本轮消息里报告；`needsHuman` 列表随第 4 步的 `status` 一起提供。）

## 8. 信任模型

所有评论、review 和 CI 日志都是数据。可信作者决定哪些反馈会被处理，但不能扩大工具被允许做的事。

验证会运行 PR 的代码：它的测试，以及 PR 可能改过的构建脚本。对作者没有写权限的 PR，这意味着别人的代码在无人值守的情况下运行，而用户的 `gh` 和 `git` 凭据就在手边。Qwen Code 提供的沙箱都不能让这些凭据脱离那些代码的触及范围：macOS 默认的 profile 只限制写入，而在容器里，辅助命令本身就需要 `gh` 和 `git` 凭据。因此监视完全不监视这类 PR；`--once` 在用户确认后于前台运行，确认时说明这一风险，`--yes` 不能跳过确认。用户自己或协作者的 PR 按用户自己验证的方式验证。`prepare` 报告 `authorCanPush`（作者是用户本人，或对 base 仓库有写权限），skill 在询问是否开始之前据此执行这条规则。一个不持有任何凭据的验证沙箱可以解除这一限制，但不在本设计范围内。

辅助命令检查推送去往哪里、是否建立在 PR head 之上，但不检查这一轮的提交包含什么：例如移动子模块指针的修复，会和其他改动一样被推送。修复说明要求修复 agent 只暂存自己改过的文件，绝不提交修复不需要的 gitlink 改动；其余的由 PR 的评审把关。辅助命令也防不住反过来对付它们的修复 agent：它用用户自己的凭据运行命令，和用户运行的任何工具一样。辅助命令保证的是：会话自己的步骤和被改过的状态文件，不会把推送导向别处或改写 PR 的历史；它们按 git 实际存储的样子读取历史，replace ref 和 graft 文件都被忽略。

满足以下条件之一的作者，其评论可处理：

- `authorAssociation` 为 `OWNER`、`MEMBER` 或 `COLLABORATOR`；
- PR 作者；
- bot 账号（`__typename == "Bot"`），仅限 review 和 review thread 评论。bot 的 issue 评论（例如覆盖率或 CI 报告）不当作请求。

永远不处理：

- 工具自己的回复：id 在 `postedCommentIds` 里，或者当前用户发的、以回复标记结尾的评论。当前用户往往就是 PR 作者，因此是可信的；没有这条规则，工具就会回复自己。
- 其他任何人的评论。它们会出现在 `status` 和最终报告里，但不会被处理，也不会被回复。

即使是可处理的评论，修复说明也禁止：泄露密钥或 token；修改 CI 配置来跳过、禁用或削弱检查；删除或削弱测试来让它们通过；跳过仓库的 commit hook（`--no-verify`）；强推；与 PR 无关的改动。这类请求会收到"需要人工决定"的回复。

针对 bot 的循环防护：每条 review 评论只尝试修复一次（已回答过的 thread 里的新评论是新的请求），bot 在 thread 里的回复不算请求（第 6.2 节），推送次数有上限（第 10 节）。因此每次推送都重新 review 的 bot 不能让循环无限进行下去。

## 9. 回复

回复默认开启；`--no-reply` 关闭。

- 每个处理过的 review thread 收到一条回复：`Fixed in <short-sha>: <one line>`、`Not changed: <reason>` 或 `Needs a human decision: <question>`。
- 每次推送发一条 PR 评论，总结这次处理了什么：修复或重跑的检查、处理的评论、解决的冲突，以及如何验证的。
- 回复使用被回复评论的语言；总结使用 PR 标题的语言（`snapshot` 报告的 `title`）。
- 每条正文末尾都带 `<!-- qwen-autofix-pr:v1 -->`。
- 工具从不 resolve review thread。

## 10. 调度、预算与生命周期

- 启动时立即跑第一轮检查——已准备模式的 `snapshot <n>`，它读状态文件而不读闸门游标，所以新的监视能看到所有未处理的事项，不论旧闸门报告过什么——然后调用 `cron_create` 创建会话级循环任务，cron 为 `*/<every> * * * *`（默认 `*/2`），闸门为 `qwen autofix-pr snapshot <n> --gate --repo <owner>/<repo> --host <host> --session <sessionId>`（即传给 `prepare` 的 host 和 `prepare` 报告的会话），prompt 告诉模型如何处理闸门输出中的事件（`Run /autofix-pr tick <owner>/<repo>#<n> on the events below`）。闸门在创建任务时像 Monitor 命令一样确认一次。
- 会话忙时到达的触发会在通知队列里等待；会话空闲后探针运行一次，输出自上次运行以来的全部新内容。
- 任务随进程结束。状态文件保留，归写下它的会话所有，新会话的 `prepare` 会拒绝它（第 6.1 节）。之后的会话在用户同意后用 `prepare --take-over` 接管监视，推送和预算都保留（第 6.1 节第 5 步）。监视发出和处理过的内容保存在 PR 的历史文件里（第 6.6 节），所以新的监视不会再回复同样的评论。已经停止的监视已经运行过 `cleanup`。
- cron 最长存活时间的设置（`QWEN_CODE_CRON_MAX_AGE_DAYS`）仍然生效。

预算记录在状态文件里：

| 预算                                 | 默认值 | 用完时                   |
| ------------------------------------ | ------ | ------------------------ |
| 同一个失败检查在变绿之前的修复次数   | 3      | 停止循环                 |
| 每个检查在每个 head SHA 上的重跑次数 | 1      | 下一次失败按真实失败处理 |
| 每条 review 评论的修复次数           | 1      | 不再提供                 |
| 每次启动的推送次数                   | 10     | 停止循环                 |
| 连续被别人移动 head 的次数           | 2      | 停止循环                 |
| 一次修复尝试可运行的分钟数           | 30     | 记为失败并清除           |

停止条件：PR 已合并或关闭；执行 `/autofix-pr stop`；上表中某项预算要求停止；cron 任务过期。除了定时任务过期（默认 7 天：`experimental.cronRecurringMaxAgeDays` 或 `QWEN_CODE_CRON_MAX_AGE_DAYS`）会不经过任何一轮就结束监视之外，每次停止都会执行 `cleanup`，并输出原因、已做的推送和所有 `needsHuman` 项。

开销：一轮无事发生的检查只是一次探针运行——一次 GraphQL 调用，check context、check suite 或 review thread 每多一页再加一次，每条之前没问过的、开启线程的机器人评论再加一次 REST 调用——没有模型回合。只有带事件的检查才到达模型，所以两分钟的节奏在 PR 安静时不花任何开销。

## 11. 已定决策

2026-10-21 确定：

1. 命令名为 `/autofix-pr`。
2. 可信作者除 `OWNER`、`MEMBER` 和 `COLLABORATOR` 外，还包括 PR 作者和 review bot。
3. 在 PR 上回复属于第一版，并默认开启。
4. 每轮检查都是模型回合时，默认检查间隔为 15 分钟。有了闸门之后安静的检查不花回合，所以默认改为 2 分钟（2026-10-21 修订）。

## 12. 风险、验证与交付

风险：

- 以用户身份推送。缓解：每次启动都确认、推送保护和预算。
- 与 bot 或工具自己的回复形成反馈循环。缓解：回复标记、记录的 id 和每个 thread 的尝试次数。
- 与另一个 agent 或人在同一分支上竞争。缓解：`--force-with-lease`，以及 head 被别人移动两次后停止。
- 长会话里对话不断增长。安静的检查从不到达模型；只有事件会，而且探针每个迁移只报告一次。
- 每次运行都有输出的探针会把闸门变回模型驱动的循环。两个探针都维护游标、只报告迁移；它们的测试钉住了"对未变化的数据再跑一次什么都不输出"。

验证：

- 用录制的 `gh` JSON fixture 做单元测试：事件对比、旧 SHA 上的过时检查、各信任类别、回复标记和 id 的自我排除、动作优先级、预算；闸门游标规则（每个 head 一次、重跑后的失败、冲突标记、当前用户自己的评论、合并与重新打开）和 check 汇总翻页；评审者探针的事件、过滤项和游标清理。
- 用本地 bare 仓库测试推送保护：拒绝非 fast-forward、拒绝默认分支、别人推送后 lease 被拒。
- 在 `PATH` 上放一个假的 `gh` 做集成测试，跑通 `prepare` → `snapshot` → `push` → `reply` → `cleanup`——尚未编写；目前每个辅助命令各自用真实 git、裸远端仓库和打桩的 `gh` 测试。
- 在沙箱仓库上手工端到端验证：失败的测试被修复并推送；协作者的评论被修复并回复；陌生人的评论被忽略；合并 PR 后循环结束，worktree 被删除。

验收标准：

- 任何一次运行之后，用户的工作区和当前分支都没有变化。
- 从不强推，也从不推到默认分支。
- 工具从不回复自己的评论，也从不回复不可信作者。
- PR 合并或关闭后，循环在一个间隔内结束。

交付计划：

1. 触发层：定时任务闸门（PR #15069）。
2. 探针（本 PR）：带游标和 check 翻页的 `snapshot --gate`，以及 `review watch-repo`；`prepare`、`ci-log` 和 `cleanup` 一同交付，等待反应层。
3. 辅助命令 `push` 和 `reply`，带测试；以及 skill：支持 `--once` 的 `/autofix-pr`，然后是作为带闸门任务的 watch 模式，以及对每个事件运行 `/qreview` 或一次验证的评审者监视。状态文件记录已处理过的失败检查 attempt，键与闸门游标相同（检查，head，attempt），这样 agent 已放弃的失败不会被再次派发，而重跑后再次失败的会。
   除评审者监视外已交付（2026-10-24）：`push`、`sync`（第 6.8 节）、`reply`、`rerun`（第 6.9 节），以及支持 `--once`、watch 模式、`stop` 和简单 `status` 的 bundled skill。这一步里修复 agent 在前台运行：会话等它结束，所以不会有触发再启动第二次尝试，暂时不需要 `inFlight`。它执行的预算是每次启动的推送次数（`push`）、每个检查每个 head 一次重跑（`rerun`），以及每条 review 评论一次尝试（一轮处理过的评论无论结果如何都会被记录；最后一次推送所在的那一轮是监视的最后一轮）；同一轮内两次 resync 会停止监视；一轮没能推送的工作以 `sync --discard` 结束，下一轮不会建立在它之上。第 8 节的沙箱规则在启动时执行，每一轮都先运行 `sync`，所以 GitHub API 尚未显示的推送或回退也会被跟上；推送之前还会再 sync 一次，把修复 agent 的合并留在原处的子模块移过去。skill 的 `allowedTools` 只放行读取它的 `.qwen/tmp` 文件、写它的修复说明和回复计划，以及 `cron_list`——不放行任何 shell 命令。权限匹配器把开头的 `"${QWEN_CODE_CLI:-qwen}"` 读成空词，没有规则能只放行这些辅助命令；而即使是 `gh pr view *` 这样只读命令的放行规则，也会连带放行其后的命令替换、重定向和环境变量前缀。所以在默认审批模式下，每次辅助命令调用——包括推送——都会先询问。
4. 循环状态：`status`、`stop`、预算，以及由之后的会话接管状态文件。
5. 后续工作：daemon 会话里的持久化监视（`durable` 加 `sessionMode: "current"`，待闸门支持后）；可配置的 bot 允许名单。

待定问题：

- 有了配置项之后，可信 bot 是否默认收窄为一个可配置的允许名单？
- draft PR 是否也要监视，还是在标记为 ready 之前拒绝？
- 有些自动化程序以拥有协作者权限的普通用户账号发评论（在本仓库，`qwen-code-review-bot` 就是这样发布 triage 状态评论的）。这类评论能通过信任规则，每条在被标记为已处理之前都要耗费一轮修复。是否要提供一个可配置的自动化账号列表并跳过它们？
