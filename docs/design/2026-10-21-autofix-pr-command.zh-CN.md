# `/autofix-pr`：在本地盯住 PR 并自动修复

[English](2026-10-21-autofix-pr-command.md) | [简体中文](2026-10-21-autofix-pr-command.zh-CN.md)

状态：进行中。2026-10-21，同日在定时任务闸门（[2026-10-21-scheduled-task-gate.md](2026-10-21-scheduled-task-gate.md)，PR #15069）取代模型驱动的 tick 之后修订：触发层是定时任务上的 `gate`，本命令的探针——作者侧的 `snapshot --gate` 和评审者侧的 `review watch-repo`——已实现，与之一起实现的还有等待反应层的 `prepare`、`ci-log` 和 `cleanup` 辅助命令。其余仍是提案。[已定决策](#11-已定决策)中的四项产品决策于 2026-10-21 确定；第四项在该节中修订。

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
/autofix-pr [<pr-number>|<pr-url>] [--once] [--every <minutes>] [--no-reply] [instructions...]
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
  ├─ fix                       background agent, working_dir = worktree
  ├─ qwen autofix-pr push      guarded push, advances the cursor
  ├─ qwen autofix-pr reply     post replies with a marker, record their ids
  ├─ qwen autofix-pr cleanup   remove worktree, branch and state file when safe
  └─ cron_create               session-only, recurring, gate:
                               "qwen autofix-pr snapshot <n> --gate --repo <owner>/<repo> --host <host>";
                               the prompt says how to handle the events the gate printed

qwen review watch-repo         the reviewer's probe: PRs opened, pushed or marked
                               ready since the last run, behind a gate of its own
```

辅助命令放在 `packages/cli/src/commands/autofix-pr.ts` 和 `packages/cli/src/commands/autofix-pr/` 下；评审者探针和其他 `qwen review` 辅助命令放在一起。每个 PR 的状态放在 worktree 旁边，不放在 worktree 里面，位于 clone 的主 worktree 下。分支由同一个 clone 的所有 worktree 共享，所以每个辅助命令从其中任何一个 worktree（包括 autofix worktree 本身）运行，都能找到同一次监视：

- worktree：`.qwen/tmp/autofix-pr-<n>/`
- 状态：`.qwen/tmp/autofix-pr-<n>-state.json`
- 闸门游标：`.qwen/tmp/autofix-pr-<n>-gate.json`
- 日志和修复说明：`.qwen/tmp/autofix-pr-<n>-*.{log,md}`
- 评审者游标：`.qwen/tmp/review-watch/<host>/<owner>/<repo>.json`

## 6. 辅助命令契约

### 6.1 `prepare <pr> --repo <owner>/<repo> [--host <host>]`

1. 用 `gh` 解析 PR。PR 已关闭或已合并、head 仓库已被删除、或 head 是默认分支时拒绝。
2. 动手之前先检查推送权限。同仓库 PR 要求仓库的 `viewerPermission` 为 `WRITE`、`MAINTAIN` 或 `ADMIN`。fork PR 要求当前用户就是 fork 的所有者，或者既有写权限又有 `maintainerCanModify`。否则拒绝并说明原因。
3. 要求本地恰好有一个 remote 和 base 仓库匹配（使用 `review match-remote` 背后的匹配逻辑）。
4. 确定推送目标。优先使用唯一一个和 head 仓库匹配、并且只推送到它的本地 remote：匹配器只读 fetch URL，所以该 remote 推送到的每一个 URL——它的 `pushurl`，或者多条 `url` 里的每一条——都用同一个匹配器再核对一遍，任何一个目的地在别处的 remote 都不算。没有的话，按 `gh config get git_protocol` 给出的协议使用 head 仓库的 URL。把结果记到状态文件里。
5. 状态文件就是锁。它记录会话 id（`QWEN_CODE_SESSION_ID`）；由另一个会话写下的状态文件直接导致拒绝，绝不抢占。
6. 把 `refs/pull/<n>/head` fetch 到本地分支 `qwen-autofix/pr-<n>`，并在它上面创建 worktree。`prepare` 从不丢弃之前的工作：残留的 worktree，或可能含有超出记录 head 的提交的残留分支，都会导致拒绝，并提示先运行 `cleanup`。
7. 在拥有这次监视的会话里重新运行 `prepare`，且 worktree 还在时，直接报告现有状态并带上 `resumed: true`，不再调用其他任何东西。如果 worktree 已被删除（包括用 `rm -rf` 删除，`git worktree prune` 会清掉它的登记），就重新创建它，并保留已记录的 `pushedShas`、`handledCommentIds` 和 `postedCommentIds`。状态文件属于另一个仓库的同号 PR 时直接拒绝。仓库按 GitHub 的方式比较：owner 和仓库名不区分大小写；host 不区分大小写、忽略默认端口，但保留其他端口，因为不同端口可能是不同的实例。
8. 输出 JSON 报告：worktree 路径、分支、head SHA、base/head ref、推送目标、当前用户和 PR 作者的 login、draft 和 fork 标志，以及 `localUnpushedCommits`，即用户自己那份 head 分支上 PR 还没有的提交数。worktree 看不到这些提交。只有 upstream 是推送 remote 上 head 分支的本地分支才算这份副本，因此 fork 的 `main` 永远不会和用户自己的 `main` 比较。

### 6.2 `snapshot <pr> [--repo <owner>/<repo>] [--host <host>] [--gate]`

一次 GraphQL 调用（检查或 review thread 每多一页再加一次）读取：

- PR 字段：`state`、`isDraft`、`url`、`headRefOid`、`mergeable`、作者和当前用户
- head 提交的 status check 汇总，翻页读到前 100 个 context 之后（最多十页；繁忙仓库上一个 head 远超 100 个，后面页上的失败绝不能被读成全绿）
- `reviewThreads`，翻页读到前 100 个之后（最多十页：thread 按创建先后排列，新 thread 在最后一页），每个 thread 带第一条评论的 `databaseId` 和最后 100 条评论（`id`、`databaseId`、`author { __typename login }`、`authorAssociation`、`body`、`url`）
- 最后 100 条 `reviews` 和最后 100 条 issue 评论

汇总列出 head 上的每一次运行：被重跑的 job 的早先 attempt，以及在多个事件上触发的 workflow 的每一次触发。每个检查只看最新一次运行——check run 由 app、workflow（按 id 区分：两个 workflow 文件可能同名）、触发事件和 job 名确定，按运行 id 排序；commit status 由 context 确定，按创建时间排序——所以被重跑转绿的失败不会被报告。两个 app 发布同名的检查时算两个检查：分支规则可以要求其中任一个 app 的检查，所以一个的成功不会抵消另一个的失败。

不带 `--gate` 时，`snapshot` 把它们和 `prepare` 写下的状态文件对比，输出事件列表和一个动作：

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

- 评论 id 是 GraphQL node id，在评论、review 和 thread 之间都唯一。`replyTo` 是 thread 第一条评论的 `databaseId`，这是 REST 回复接口唯一接受的 id；它单独读取，所以超过 100 条评论的 thread 也能拿到。
- 只看当前 `headRefOid` 上的检查；旧提交的汇总会被忽略。check run 在 `FAILURE`、`TIMED_OUT` 或 `STARTUP_FAILURE` 时算失败；commit status 在 `FAILURE` 或 `ERROR` 时算失败。`CANCELLED` 不算失败。`runId` 从 Actions URL 中解析，否则为 null。
- 只有 CI 还在跑时，动作是 `wait`。CI 在跑的同时仍然可以修可信评论，因为下一次推送反正会重新触发 CI。
- 评论 id 既不在 `handledCommentIds` 也不在 `postedCommentIds` 里、且不是工具自己的回复——即当前用户发的、正文以回复标记（第 9 节）结尾的评论——时，才算新评论。标记出现在别处（有人引用了一条回复）不会让评论被忽略。已 resolve 的 thread、空的或 pending 的 review，以及被 dismiss 的 review（它已被撤回）会被跳过；outdated 的 thread 会保留，并带上 `outdated: true`。
- head SHA 和 `lastKnownHeadSha` 不同、且不在 `pushedShas` 里，记为 `head_moved_externally`。
- `truncated` 列出条目数超过查询读取范围的连接（`checks`、`reviewThreadComments`、`reviewThreads`、`reviews`、`comments`）。

动作优先级：`stop`（已合并或已关闭）→ `resync`（head 被别人移动）→ `fix`（冲突、失败的检查或可信评论）→ `wait`。循环会再加两个输入：预算用完时为 `stop`，修复进行中（状态文件里有 `inFlight`）时为 `wait`，直到这次尝试结束（第 7 节）。

#### 闸门模式（`--gate`）

`snapshot <n> --gate` 是定时任务闸门背后的那条命令。它不需要 worktree，也不需要状态文件：首次运行用 `--repo` 指定 PR 所在的仓库（或由已准备好的状态提供），它自己的游标 `.qwen/tmp/autofix-pr-<n>-gate.json` 记录已经报告过的内容。没有 `--host`（或 `GH_HOST`）时，先用该 PR 已在监视的 host——游标里的，或已准备状态里的——最后才回落到 github.com；空白的 `--host` 会被拒绝。游标属于另一个仓库的同号 PR 时直接拒绝，比较方式与 `prepare` 比较状态文件相同。它输出同样的 JSON，但只包含自上次运行以来的迁移，没有迁移时什么都不输出，因此会话只会为迁移被唤醒：

- 失败的检查按（检查，head，attempt）报告一次：游标键带上运行 id（commit status 则是它的创建时间），所以重跑后再次失败的检查会再次报告，即使没有任何一次轮询看到它处于运行中。游标只保留仍然存在的失败，新的 head 从头开始。
- 进行中的检查从不报告；不会出现 `ci_pending`。
- 冲突按 head 报告一次；`mergeable` 清除标记，`UNKNOWN` 保留标记。
- 评论、review 和 thread 评论按 node id 各报告一次，沿用第 8 节的信任规则。当前用户自己的评论永远不是事件，同一 PR 的已准备监视处理过的评论（`handledCommentIds`、`postedCommentIds`）也不是；其中查询结果里还在的会被并入游标，所以 `cleanup` 删掉状态文件之后它们仍然保持安静。只有不可信评论时作为提醒报告（`wait`）。查询结果里仍然出现的已报告 id 全部保留在游标里，不论多少；只有已经离开页面的 id 才有上限，所以内容相同的轮询是安静的。正文截到前 1,000 个字符（`bodyTruncated: true`）；完整内容见事件的 `url`。
- head 与上次运行不同时记为 `head_moved_externally`（`resync`），除非同一 PR 的已准备监视记录过或推送过它（`lastKnownHeadSha`、`pushedShas`）；首次运行只记录 head，不报告。
- 合并或关闭报告一次（`stop`）；之后探针保持安静，重新打开的 PR 会再次被监视。
- 从头读取的连接（`checks`、`reviewThreads`）开始被截断时报告一次，没有其他事件时动作为 `wait`：超出最后一页的新 thread 不会留下别的痕迹。持续的截断保持安静。评论、review 和 thread 评论从最新的读起，那里的截断只会藏住更早的内容：它列在 `truncated` 里，但不唤醒会话。
- 输出不超过 12 KiB，低于闸门交给会话的 16 KiB（超出部分会被闸门截掉）。事件按顺序排列——head 移动、冲突、失败、评论——放不下的事件，或放不下整体的 thread 里靠后的评论，会被留下，计入 `deferred`，且不记为已报告，所以下一次运行会报告它们。每次至少输出一个事件或一条评论，所以每次运行都有进展。
- 首次运行报告所有尚未处理的事项：失败的检查、冲突，以及没人处理过的评论。

游标在输出之前写入，所以打印之后崩溃的探针不会把同一批迁移报告两次。`ci_pending` 和安静 PR 的 `wait` 动作只存在于已准备模式。

### 6.3 `ci-log <pr> <run-id> [--lines 200]`

把该 run 中已结束且失败或超时的每个 job 的日志在该 job 最后一行 `##[error]` 之后截断（之后是 post-job 清理步骤），再按 job 截取最后 `--lines` 行，并注明省略了多少行，写到 `.qwen/tmp/autofix-pr-<n>-ci-<run-id>.log`，然后输出路径和 job 名称。修复 agent 读这个文件，而不是把日志通过 shell 预览输出。`--lines` 必须是正整数。某个 job 的日志读不到时，用一行 `log unavailable: <reason>` 代替它的日志，其他 job 照常写入。run 里没有已结束且失败或超时的 job（失败的 job 还在跑，或在任何 job 开始前就启动失败）时报错，而不是写一个空文件。

每个 job 的日志通过 REST jobs 接口读取，而不是 `gh run view --log-failed`：`gh run view`（加不加 `--job` 都一样）会拒绝仍在运行的 run，而 `snapshot` 在一个 job 失败时就会报告它，这时同一 run 的其他 job 可能还在跑。

### 6.4 `push <pr>`

以下条件全部满足才推送，否则拒绝：

- worktree 是干净的（所有改动都已提交）；
- `lastKnownHeadSha` 是 `HEAD` 的祖先（只允许 fast-forward，不改写历史）；
- 目标分支不是 base 仓库的默认分支。

然后执行 `git push <target> HEAD:refs/heads/<headRef> --force-with-lease=refs/heads/<headRef>:<lastKnownHeadSha>`。pre-push hook 照常运行，不使用 `--force` 或 `--no-verify`。成功后把新 SHA 记入 `pushedShas` 和 `lastKnownHeadSha`，推送计数加一，清除 `inFlight`。lease 被拒说明别人推送过，结果是 `resync`，而不是重试。

### 6.5 `reply <pr> <plan.json>`

按 skill 写好的回复计划（第 9 节）发出回复，在每条正文末尾加上标记，把返回的 id 记入 `postedCommentIds`，并把已处理的评论 id 移到 `handledCommentIds`。回复 review thread 使用 `POST /repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies`；推送总结使用 issue 评论。

### 6.6 `cleanup <pr> [--force]`

一起删除 worktree、它的分支和状态文件。worktree 有未提交的改动（包括未跟踪文件和子模块里的改动，不受 `status.showUntrackedFiles` 或子模块的 `ignore` 设置影响），或者 worktree（worktree 已被删除时则是分支）有监视已知的任何 PR head 都不包含的提交时，三者都保留，并在报告里说明原因。已知的 head 是 `lastKnownHeadSha` 和 `pushedShas`，以及——只在前两者比完仍有多出的提交时才去问——远端的 PR head（`refs/pull/<n>/head`），所以手工推送过的工作不会被拦住。worktree 路径上的目录如果不是独立的 worktree，会被保留：在它里面运行 git 会判断外层 clone。没有状态文件时没有记录的 head，因此残留的 worktree 或分支都会被保留。状态文件属于另一个会话时直接拒绝。`--force` 跳过这些检查，也会丢弃无法读取的状态文件。分支删不掉时报错，状态文件保留。在要删除的 worktree 内部运行 `cleanup` 会被拒绝。闸门游标不会被删除：它属于定时任务，而定时任务比一次监视活得久，没有游标的话下一次触发会把所有内容重新报告一遍。要停掉闸门，就删除该任务。报告里会写出保留的游标（`gateCursor`）：之后对另一个仓库同号 PR 的闸门会被拒绝，直到删除这个文件。

### 6.7 `review watch-repo --repo <owner>/<repo> [--host <host>] [--limit 50] [filters]`

评审者的探针，有自己的闸门。一次 GraphQL 调用读取最近更新的打开 PR（`--limit`，默认 50，最多 100）及其 head、draft 标志、作者、label 和评审请求，以及上限之外是否还有打开的 PR。游标 `.qwen/tmp/review-watch/<host>/<owner>/<repo>.json`（全部小写，端口前的 `:` 写成 `_`，所以同一仓库的各种拼写共用一个文件）记录每个打开 PR 的 head 和 draft 标志。带过滤项时文件为 `<repo>@<key>.json`，`<key>` 代表这组过滤项，与拼写和顺序无关：同一仓库上过滤项不同的两个任务各自保存 head，因为一个任务记下却因过滤而没有报告的推送，对另一个任务永远不会再是迁移：

- 首次运行记录打开的 PR，不输出任何内容。
- 之后，游标里没有的 PR 是 `pr_opened`，head 变化的是 `pr_pushed`，原来是 draft 现在不是的是 `pr_ready`。每个事件带编号、标题、作者、URL、head SHA、base 分支、label，以及是否请求了当前用户评审。
- 过滤项决定哪些 PR 成为事件：`--author <login>`、`--label <name>`（两者都像 GitHub 一样不区分大小写）、`--review-requested`（当前用户是被请求的评审者；team 请求不算）、`--exclude-drafts`、`--exclude-bots`、`--exclude-mine`。游标无论如何都跟踪每个 PR，换一组过滤项会使用自己的游标，其首次运行是静默的，所以更改过滤项不会重放历史。过滤项只在三种迁移中做选择，本身不是迁移：head 不变时加上 label 或请求评审不会输出任何内容，直到 PR 下一次推送。
- 列表里没有的 PR 已关闭或合并，会从游标中移除——除非列表被 `--limit` 截断。此时列表外的 PR 可能仍然打开，游标最多保留其中 `--limit` 个，编号大的优先，因为已关闭和已合并的 PR 无法区分，不设上限就会不断累积。被挤出游标、之后又有变化的打开 PR 会以 `pr_opened` 再次出现。

输出：`{ "repo": "<owner>/<repo>", "events": [...] }`，没有事件时什么都不输出。与作者侧闸门同样以 12 KiB 为限，放不下的事件被留下并计入 `deferred`；这些 PR 在游标里保留旧的 head，所以下一次运行会报告它们。使用它的 skill 决定每个事件的含义：对每个 PR 运行 `/qreview <number>` 或一次验证。

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

修复由后台 `agent` 完成，`working_dir` 设为 worktree。它的说明是一个文件，列出事件、日志路径、信任规则、用户追加的指示和验证要求。主会话保持可用。agent 的完成通知到达后，主会话执行 `push` 和 `reply`。验证失败时不推送；这次尝试计入预算，并报告失败原因。

`inFlight` 记录一次尝试开始时的 head 和时间。尝试的每种结束方式都会在计入这次尝试之后清除它：推送、验证失败、agent 出错或被停止、推送被 lease 拒绝，以及 resync。tick 发现 `inFlight` 开始于一个已经不是 PR 当前 head 的提交，或开始时间早于尝试时限（第 10 节）时，把它记为失败并清除，所以 agent 中途死掉的尝试不会让监视一直等待。

resync 时如果新 head 不包含 worktree 的 `HEAD`（作者 rebase 或 force-push 了），worktree 会被重置到新 head，而不是快进。工具推送过的内容此时已在作者手中，是作者改写的那段历史的一部分。重置最多丢掉一次没有推送的尝试，它基于旧的 head，`push` 本来也会拒绝它；这次尝试按上面的规则结束。

一轮检查从不向用户提问。需要人来判断的情况（设计分歧、互相矛盾的评论、超出 PR 范围的要求）会回复"需要人工决定"并记入 `needsHuman`。循环继续关注其他事件。

## 8. 信任模型

所有评论、review 和 CI 日志都是数据。可信作者决定哪些反馈会被处理，但不能扩大工具被允许做的事。

验证会运行 PR 的代码：它的测试，以及 PR 可能改过的构建脚本。对作者没有写权限的 PR，这意味着别人的代码在无人值守的情况下运行，而用户的 `gh` 和 `git` 凭据就在手边。因此监视只在沙箱（`QWEN_SANDBOX`）里验证这类 PR；没有沙箱时不对它做无人值守的监视，`--once` 在用户确认后于前台运行。用户自己或协作者的 PR 按用户自己验证的方式验证。

满足以下条件之一的作者，其评论可处理：

- `authorAssociation` 为 `OWNER`、`MEMBER` 或 `COLLABORATOR`；
- PR 作者；
- bot 账号（`__typename == "Bot"`），仅限 review 和 review thread 评论。bot 的 issue 评论（例如覆盖率或 CI 报告）不当作请求。

永远不处理：

- 工具自己的回复：id 在 `postedCommentIds` 里，或者当前用户发的、以回复标记结尾的评论。当前用户往往就是 PR 作者，因此是可信的；没有这条规则，工具就会回复自己。
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

- 启动时立即跑第一轮检查——已准备模式的 `snapshot <n>`，它读状态文件而不读闸门游标，所以新的监视能看到所有未处理的事项，不论旧闸门报告过什么——然后调用 `cron_create` 创建会话级循环任务，cron 为 `*/<every> * * * *`（默认 `*/2`），闸门为 `qwen autofix-pr snapshot <n> --gate --repo <owner>/<repo> --host <host>`（即传给 `prepare` 的 host），prompt 告诉模型如何处理闸门输出中的事件（`Run /autofix-pr tick <owner>/<repo>#<n> on the events below`）。闸门在创建任务时像 Monitor 命令一样确认一次。
- 会话忙时到达的触发会在通知队列里等待；会话空闲后探针运行一次，输出自上次运行以来的全部新内容。
- 任务随进程结束。状态文件保留，归写下它的会话所有，新会话的 `prepare` 会拒绝它（第 6.1 节）。在之后的会话里接管一次监视、并保留其已处理的评论和推送，属于交付第 4 步；在那之前，重新开始需要 `cleanup <n> --force`，这会丢掉这些历史。已经停止的监视已经运行过 `cleanup`。
- cron 最长存活时间的设置（`QWEN_CODE_CRON_MAX_AGE_DAYS`）仍然生效。

预算记录在状态文件里：

| 预算                                 | 默认值 | 用完时                   |
| ------------------------------------ | ------ | ------------------------ |
| 同一个失败检查在变绿之前的修复次数   | 3      | 停止循环                 |
| 每个检查在每个 head SHA 上的重跑次数 | 1      | 下一次失败按真实失败处理 |
| 每个 review thread 的修复次数        | 1      | 回复"需要人工决定"       |
| 每次启动的推送次数                   | 10     | 停止循环                 |
| 连续被别人移动 head 的次数           | 2      | 停止循环                 |
| 一次修复尝试可运行的分钟数           | 30     | 记为失败并清除           |

停止条件：PR 已合并或关闭；执行 `/autofix-pr stop`；上表中某项预算要求停止；cron 任务过期。每次停止都会执行 `cleanup`，并输出原因、已做的推送和所有 `needsHuman` 项。

开销：一轮无事发生的检查只是一次探针运行——一次 GraphQL 调用，检查或 review thread 每多一页再加一次——没有模型回合。只有带事件的检查才到达模型，所以两分钟的节奏在 PR 安静时不花任何开销。

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
- 在 `PATH` 上放一个假的 `gh` 做集成测试，跑通 `prepare` → `snapshot` → `push` → `reply` → `cleanup`。
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
4. 循环状态：`status`、`stop`、预算，以及由之后的会话接管状态文件。
5. 后续工作：daemon 会话里的持久化监视（`durable` 加 `sessionMode: "current"`，待闸门支持后）；可配置的 bot 允许名单。

待定问题：

- 有了配置项之后，可信 bot 是否默认收窄为一个可配置的允许名单？
- draft PR 是否也要监视，还是在标记为 ready 之前拒绝？
- 有些自动化程序以拥有协作者权限的普通用户账号发评论（在本仓库，`qwen-code-review-bot` 就是这样发布 triage 状态评论的）。这类评论能通过信任规则，每条在被标记为已处理之前都要耗费一轮修复。是否要提供一个可配置的自动化账号列表并跳过它们？
