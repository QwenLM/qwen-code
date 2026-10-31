# `/autofix-pr`：在本地盯住 PR 并自动修复

[English](2026-10-21-autofix-pr-command.md) | [简体中文](2026-10-21-autofix-pr-command.zh-CN.md)

状态：进行中。2026-10-21，同日在定时任务闸门（[2026-10-21-scheduled-task-gate.md](2026-10-21-scheduled-task-gate.md)，PR #15069）取代模型驱动的 tick 之后修订：触发层是定时任务上的 `gate`，本命令的探针——作者侧的 `snapshot --gate` 和评审者侧的 `review watch-repo`——已实现，与之一起实现的还有 `prepare`、`ci-log` 和 `cleanup` 辅助命令。交付第 3 步（2026-10-24）加上了反应层：`push`、`sync`、`reply`、`rerun` 辅助命令，以及带 `--once` 和 watch 模式的 bundled `/autofix-pr` skill。第 4 步已开始（2026-10-25）：`status`、`schedule` 辅助命令、`/autofix-pr resume`，以及运行这些辅助命令的 `autofix_pr` 工具。评审者监视、第 4 步的其余部分和第 5 步的后续工作仍是提案。[已定决策](#11-已定决策)中的四项产品决策于 2026-10-21 确定；第四项在该节中修订。

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
/autofix-pr status [<pr-number>]
/autofix-pr resume [<pr-number>]
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

启动后，只有发生了事情的检查才会给用户一行输出，例如 `autofix-pr owner/repo#123: fixed "Test ubuntu" and 2 review comments, pushed 3f2a1c0`。`status` 列出这个 clone 的所有监视，不论归哪个会话，包括上次检查和上一轮的时间、head SHA、已用推送次数、等待人工处理的事项，以及是否由本会话运行。

监视的定时任务随运行它的会话结束（daemon 会话里任务持久化并绑定该会话：daemon 会保活该会话，重启后任务仍在，浏览器关掉也不会静默停摆），7 天后也会过期。`resume` 在当前会话里重新启动它，沿用启动时的间隔、`--no-reply` 和附加指令，推送、历史和预算都保留。它为要恢复的全部监视只确认一次，然后对每个监视跑一轮并重新排程。

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
  ├─ qwen autofix-pr schedule  record the watch's task, print its cron, gate and prompt
  ├─ qwen autofix-pr status    every watch of the clone, read from its files
  ├─ qwen autofix-pr cleanup   remove worktree, branch and state file when safe
  └─ cron_create               recurring, gate（终端会话里是会话内任务；daemon 里是绑定该会话的持久化任务）:
                               "qwen autofix-pr snapshot <n> --gate --repo <owner>/<repo> --host <host> --session <sessionId> --task <task>";
                               the prompt says how to handle the events the gate printed

qwen review watch-repo         the reviewer's probe: PRs opened, pushed or marked
                               ready since the last run, behind a gate of its own
```

辅助命令放在 `packages/cli/src/commands/autofix-pr.ts` 和 `packages/cli/src/commands/autofix-pr/` 下，skill 通过 core 工具 `autofix_pr` 运行它们（第 6.12 节）；评审者探针和其他 `qwen review` 辅助命令放在一起。每个 PR 的状态放在 worktree 旁边，不放在 worktree 里面，位于这次监视 prepare 时所在的 worktree 下——daemon 会话里是会话自身的 worktree，否则是 clone 的主 worktree（见 [2026-10-29-autofix-pr-worktree-rooted-storage.zh-CN.md](2026-10-29-autofix-pr-worktree-rooted-storage.zh-CN.md)）。分支由同一个 clone 的所有 worktree 共享；监视列表会扫描全部 worktree，所以无论监视落在哪一个里都能找到：

- worktree：`.qwen/tmp/autofix-pr-<n>/`
- 状态：`.qwen/tmp/autofix-pr-<n>-state.json`
- 闸门游标：`.qwen/tmp/autofix-pr-<n>-gate.json`
- 监视自己的闸门上次检查的时间：`.qwen/tmp/autofix-pr-<n>-gate.checked`
- 最近一次已准备快照：`.qwen/tmp/autofix-pr-<n>-snapshot.json`
- GitHub 对 bot 评论的答复：`.qwen/tmp/autofix-pr-<n>-replies.json`
- 日志、修复说明和回复计划：`.qwen/tmp/autofix-pr-<n>-*.{log,md,json}`
- 用户给每一轮的附加指令：`.qwen/tmp/autofix-pr-<n>-instructions.txt`
- 评审者游标：`.qwen/tmp/review-watch/<host>/<owner>/<repo>.json`——这一个仍在
  clone 的**主** worktree（`repoRoot()`）下，而非 watch 根：`qwen review
watch-repo` 是 clone 级探针，不是按会话的 watch

## 6. 辅助命令契约

### 6.1 `prepare <pr> --repo <owner>/<repo> [--host <host>]`

1. 用 `gh` 解析 PR。PR 已关闭或已合并、head 仓库已被删除、或 head 是默认分支时拒绝。
2. 动手之前先检查推送权限。同仓库 PR 要求仓库的 `viewerPermission` 为 `WRITE`、`MAINTAIN` 或 `ADMIN`。fork PR 要求当前用户就是 fork 的所有者，或者既有写权限又有 `maintainerCanModify`。否则拒绝并说明原因。
3. 要求本地恰好有一个 remote 和 base 仓库匹配（使用 `review match-remote` 背后的匹配逻辑）。
4. 确定推送目标。优先使用唯一一个和 head 仓库匹配、并且只推送到它的本地 remote：匹配器只读 fetch URL，所以该 remote 推送到的每一个 URL——它的 `pushurl`，或者多条 `url` 里的每一条——都用同一个匹配器再核对一遍，任何一个目的地在别处的 remote 都不算。没有的话，按 `gh config get git_protocol` 给出的协议使用 head 仓库的 URL。把结果记到状态文件里。
5. 状态文件就是锁。它记录会话 id（`QWEN_CODE_SESSION_ID`）；由另一个会话写下的状态文件直接导致拒绝。`/clear` 和 `/resume` 会给会话换一个新 id，而它的定时任务继续运行，所以在用户同意时，`prepare --take-over` 把监视（连同历史和预算）移交给发起请求的会话；被移交的那个会话的辅助命令从此拒绝执行，它的定时任务在下一次触发时停止：它的闸门写明创建它的会话（`--session`，即 `prepare` 报告的 `sessionId`），在那之前不推进游标——写游标之前会再确认一次监视归谁——只把它唤醒（`watched_elsewhere`，`session` 是拥有者）。每个任务还写明 `schedule` 为它生成的 id（`--task`，第 6.11 节）：id 与状态文件记录的不一致的闸门——被之后的启动或 resume 替换掉的任务，或者同一会话在第二个进程（`qwen --continue`）里的副本，这时辅助命令会接受它的轮次——同样这样回答；监视已被 `cleanup` 删除的闸门回答 `watch_ended`。两种事件都写明闸门自己的会话和任务（`gateSession`、`gateTask`），这一轮据此精确删除那个任务。原拥有者已在进行中的一轮，会被它下一次辅助命令调用拦下，因为那些调用也带着任务（第 6.8 节）；但它的修复 agent 不调用辅助命令，拦不住，可能继续往 worktree 里提交，新拥有者的一轮可能把这些提交推上去。这是已知限制：`status` 报告 `checkedRecently` 时，接管和 resume 的提问会说明这一点，最好等另一个会话停下后再接管。
6. 把 `refs/pull/<n>/head` fetch 到本地分支 `qwen-autofix/pr-<n>`，并在它上面创建 worktree。`prepare` 从不丢弃之前的工作：残留的 worktree，或可能含有超出记录 head 的提交的残留分支，都会导致拒绝，并提示先运行 `cleanup`。
7. 在拥有这次监视的会话里重新运行 `prepare`，且 worktree 还在时，直接报告现有状态并带上 `resumed: true`，只向 GitHub 询问 PR 作者是谁、能否推送，并按本 clone 的 remote 重新推导 remote 和推送目标：状态文件就在 worktree 旁边，一轮运行的代码够得着它，所以这些都不从它读回；本 clone 不服务的仓库直接拒绝。只有权限 API 返回 404 才表示作者不能推送；其他失败（限流、网络）都是什么也不改的拒绝，接管也只在拿到这些答案之后才写入。head 仓库已被删除的 PR 同样拒绝。新建监视时，作者能否推送在获取或创建任何东西之前就询问，所以被拒时不留下任何东西。监视的每个文件——状态、游标、history、回复缓存、快照——都只在是普通文件时才读取，所以以其名字放置的 FIFO 卡不住辅助命令或闸门；写入时替换链接而不是跟随它，所以没有辅助命令会写到 `.qwen/tmp` 之外。如果 worktree 已被删除（包括用 `rm -rf` 删除，`git worktree prune` 会清掉它的登记），就重新创建它，并保留已记录的 `pushedShas`、`handledCommentIds` 和 `postedCommentIds`，以及预算、记下的任务（`watch`）和 `needsHuman`，报告里写 `recreated: true`：随后被取消的启动不能清理一个不是它创建的监视。`stop` 已结束的监视也以同样方式恢复（`wasEnded`，与保留 worktree 的路径相同）。带 `--take-over` 时，只有 PR 通过第 2 步的检查后才把监视移交给本会话，被拒时监视仍归原来的会话。状态文件属于另一个仓库的同号 PR 时直接拒绝。仓库按 GitHub 的方式比较：owner 和仓库名不区分大小写；host 不区分大小写、忽略默认端口，但保留其他端口，因为不同端口可能是不同的实例。在 daemon 会话里（`QWEN_CODE_SERVE=1`），监视以会话自身 worktree 的 toplevel 为根，所以开在 clone 的 linked worktree 里的会话会把监视准备在自己的目录之内。若 worktree 仍会落在会话工作目录之外（会话位于该 worktree 的子目录，或在另一个 clone 里），则在读取状态文件之前就拒绝，恢复、接管和新建监视都一样：daemon 只在那个目录里运行修复 agent 的命令，在那里的一轮无法测试、提交或推送。拒绝信息会写明应该从哪个目录运行 prepare。
8. 输出 JSON 报告：worktree 路径、分支、head SHA、base/head ref、推送目标、当前用户和 PR 作者的 login、draft 和 fork 标志，以及 `localUnpushedCommits`，即用户自己那份 head 分支上 PR 还没有的提交数。worktree 看不到这些提交。只有 upstream 是推送 remote 上 head 分支的本地分支才算这份副本，因此 fork 的 `main` 永远不会和用户自己的 `main` 比较。报告还带 `localUncommittedChanges`：这个 clone 里是否有 worktree 检出了同一份副本、并且有 git 报告的未提交改动。读取时带 `--no-optional-locks`、`--untracked-files=normal` 和 `--ignore-submodules=none`，所以用户的 `status.showUntrackedFiles` 或 submodule 的 `ignore` 设置藏不住这些改动；只排除辅助命令写入的 `.qwen/tmp`，`.qwen` 下的其他内容都算用户的。只在这份副本存在时计算，且只算检出该分支的 worktree，检出别的分支的 worktree 里的改动不属于这份副本。`worktree list --porcelain -z` 可避免路径被引号包裹；git 没有 `-z` 时（2.36 之前）回退到行格式，被它加引号的路径会读成未知而不是「没有工作」。`localWorkUnknown` 表示根本无法比较——PR head 不在这个 clone 里，或 git 读不了某个检出——这种情况永远不会被报成「没有工作」。两个字段都只是报告，不是拒绝：工作为真或该未知标记为真时，skill 的启动不再继续（除非用户知情后要求继续），因为监视的推送与用户自己的推送去的是同一个 head 分支。

### 6.2 `snapshot <pr> [--repo <owner>/<repo>] [--host <host>] [--gate] [--session <id>] [--task <id>]`

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
- 每个失败检查的修复推送预算（第 10 节）是 prepared 快照唯一保存的记录，存在状态文件的 `failingChecks` 里：每个被某一轮看到失败、此后还没看到通过的检查（按上文的检查身份）一条，记着它最后一次失败所在的 head、它在监视之后的几次推送上失败，以及计数截至的那次推送（`lastPush`）。它数的是推送而不是修复：为评审评论做的推送、检查在上面失败的，也计入。通过（`SUCCESS` 或 `NEUTRAL`；status 的 `SUCCESS`）结束这一条。别人的推送让每一条都拿回推送次数，从监视最近的推送重新计起：`sync` 和 `prepare` 采纳别人的推送时就这样做，不论之后有没有哪一轮读到它；读取这样的 head 也一样。回到监视更早的推送不消耗。只有读到监视已知的 head（`sync` 或 `push` 记下的那个）才计数：其他的要么是 API 落后于分支，要么是这一轮会同步过去再读一次的推送。head 的 rollup 在页数上限处被截断的读取也不改变任何一条：某个检查更晚的一次运行可能在没读到的页上。闸门不会因为通过而唤醒任何一轮，所以通过可能没有哪一轮读到：监视可能在修复的检查结束前又推送了一次（为评审评论），重跑也可能在这一轮继续往下走之后才通过。因此检查在监视之后的推送上失败时，快照会向 GitHub 询问它在中间这些尚未计入的监视推送上的结果，以及——某一轮在它最后失败的 head 上重跑过时——在那个 head 上的结果（`commitCheckResults`：读一次该提交的 rollup，与 PR 的 rollup 一样翻页，在页数上限处被截断的 rollup 按没有回应处理；每次读取最多问 4 个提交，由所有检查共用，每个只问一次，从最新的问起）。那里通过，就像某一轮读到通过一样结束这一条，这次失败重新算作第一次；中间某次推送上失败则消耗一次（在最后失败的 head 上重跑后又失败，不再多消耗）。没有结果的 head（仍在运行、被取消、未列出，或 GitHub 没有回应）不消耗，并留在这一条上（`unanswered`，保留最新的 4 个），在它的下一次推送时再问：那时查到通过，则只保留某一轮此后再次看到检查失败以来计入的次数；查到失败则不消耗——只有计入某次推送时已知的结果才消耗。只有改变了某一条的读取才会加监视的锁，重新读取状态后写入；被读取改变的条目排在最后，最多保留 100 条。3 次推送都没让检查变绿后，它的 `ci_failed` 带上 `exhausted: true`，skill 把它作为需要人工处理来回答，而不再修复——像其他不经推送处理的失败一样，每个 head 一次——直到一次通过结束这一条，或别人的推送把次数还给它。只在监视已计入的 head 上被人看到的通过（有人在那里手动重跑）不会被查询。接管、resume 和重建 worktree 都保留这条记录；新的启动不带它，与推送预算一样；每次 `--in-place` 启动（每次一轮）也不带。
- 尚未提交的 review 里的评论（`PENDING`）是只有作者能看到的草稿，会被跳过。bot 在开启 thread 的评论（以及 review）里提要求；它在 thread 里的回复是在回答某人，不算请求。被回复的评论删除后，GraphQL 会丢掉回复的 `replyTo`，并把它列为 thread 的第一条，所以看起来像是开启了 thread、又尚未见过的 bot 评论，会通过 REST 逐条查询（`in_reply_to_id` 仍保留在这条评论上），只针对打开的 PR 上未解决的 thread，而且每条只问一次：答案保存在 `.qwen/tmp/autofix-pr-<n>-replies.json`，闸门、已准备快照和 `reply` 共用。期间被删除的评论不算请求。每条答案一拿到就保存。闸门每次触发最多问 20 条、不超出闸门的读取时限，遇到第一次失败就停，剩下的留到下一次触发，这次既不算请求也不记为已看过；一轮的快照则问完所有条目，GitHub 没有回应时直接失败，绝不丢掉闸门已经报告过的请求（`reply` 按闸门的方式询问：它的计划只会点名快照问过的 thread）；问了八分钟仍未问完时就停下，保留已有答案，并提示再运行一次。闸门也把 bot 的回复记为已看过。否则，会回复每条回复的评审 bot 会让每次都多跑一轮，不受信任的评论者也能借 bot 之口提要求，删掉自己的评论之后也一样。
- 失败的检查只有在它是 PR 所在仓库的 GitHub Actions job 时才带 `runId`（它的 suite 有 workflow run，URL 位于 `https://<host>/<owner>/<repo>/actions/runs/` 之下）：commit status 或其他应用的检查可以链接任意 run，`ci-log` 会去读它。
- 已合并或已关闭的 PR 只读第一次调用：它的结果就是停止，不需要再翻检查、suite 或 thread 的后续页。
- 监视属于 CLI 会话，其 id 保持不变。Managed Session 把每一轮、每一次闸门都作为各自的 Runtime Session 运行，所以辅助命令的会话检查会拒绝它的下一轮：探针可以充当 Managed 自动化的闸门——不写 `--session` 的闸门不做所有者检查——而监视本身暂不适用于 Managed Session。这样的闸门和同一 clone 里对同一 PR 的 CLI 监视共用闸门游标，先触发的一方会拿走另一方的迁移：请各用一个 clone。
- check 和 suite 属于提交而不属于 PR：同一个 head 提交的另一个 PR 会共用它们。这是已知的局限。
- 已准备模式把整个快照缩进后写到 `.qwen/tmp/autofix-pr-<n>-snapshot.json`，只输出一行：去掉事件的快照、事件数量和类型，以及文件路径（`snapshot`）。有一点历史的 PR 上，评论正文远远超出一行工具输出能显示的长度；这一轮读取该文件，修复说明列出修复 agent 要处理的条目，正文从该文件读取。正文写成按行的数组，超过 2,000 字符的行写成由若干片段组成的数组（绝不在一个字符中间切开），因为 `read_file` 按行分页，一次读取返回的内容超过 25,000 字符就截断；被这样截断的读取要从它最后显示的那一行重新读。
- `truncated` 列出条目数超过查询读取范围的连接（`checks`、`reviewThreadComments`、`reviewThreads`、`reviews`、`comments`）。

动作优先级：`stop`（已合并或已关闭）→ `resync`（head 被别人移动）→ `fix`（冲突、失败的检查或可信评论）→ `wait`。循环会再加三个输入：预算用完时为 `stop`；后台修复进行中（它的尝试标记，第 6.14 节）时，闸门保持安静，prepared 快照被拒绝，直到这次尝试结束；被它的会话遗留下来的尝试（过期的标记）也是 `fix` 的来源——监视自己的闸门把它作为一次 `abandoned_fix` 事件报告，所以即使没有别的变化，也会有一轮丢弃这次尝试的工作并重做修复。

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
- 被会话遗留下来的后台修复尝试（过期的标记，第 6.14 节）按尝试 id 只报告一次，作为 `abandoned_fix` 事件，记在游标里（`reportedAbandonedFix`），并且只由监视自己的闸门（带 `--session` 的运行）报告：手动运行的探针或 Managed 自动化的闸门不会唤醒处理它的那一轮。它排在其他事件之后，不计入它们所适配的 12 KiB（它只有几十字节），即使没有别的变化也会让动作变为 `fix`。标记新鲜时闸门什么都不输出。

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
  "handledConflict": false,
  "needsHuman": ["PRRC_x: rename the public option, or keep it?"]
}
```

能发什么由辅助命令决定，依据是重新读一次 PR（按 prepared snapshot 的规则）：

- 回复只发到此刻有可信作者新评论的 thread，`handled` 列出的必须是该 thread 的评论。不可信评论不能标记为已处理；check 键必须是 head 上某个 `ci_failed` 事件报告的（prepared 模式会输出它的 `key`）——此刻报告的，或这一轮的 prepared snapshot 文件里报告过的（后台修复的认领移走了那个文件时，则是认领后的 `autofix-pr-<n>-fix-snapshot.json`，在下一轮准备新快照之前都读它；第 6.14 节）：一轮运行期间 head 可能已越过某个失败（重跑、review 启动的运行），这一轮对它的回答仍然有效，记在由 review 启动的 workflow 在该 head 上下一次失败会带的那个键下。延后在其 run 运行期间保留的失败（第 6.9 节）不记录（计入 `ignoredChecks`）：run 结束时闸门会再报告一次，或报告该检查之后某次失败的运行，那一轮再回答它。这一轮见过的其他失败照常记录，包括被延后的 run 里延后之后才失败的 job：闸门不会再报告它；冲突只有在确实存在时才能留给人处理。PR 必须仍处于打开状态。
- 判断计划所依据的 head 是监视已知的那个（`sync` 和 `push` 从分支读取），而不是 API 的——API 可能比推送滞后。
- 其他 head 的失败键（这一轮已推送越过了它）被忽略并计入 `ignoredChecks`：prepared snapshot 只读当前 head。根本不是失败键的字符串会被拒绝。`handledConflict` 只在 GitHub 报告冲突时，或者在本监视推送的 head 上报告 `UNKNOWN` 时，才记在当前 head 上：推送刚完成时 GitHub 会报告 `UNKNOWN`，直到重新算完合并。
- 同一 thread 有两条回复，或同一个评论 id 出现两次的计划会被拒绝。
- 所有检查在发出任何内容之前完成，被拒绝的计划什么都不发。
- 每次 POST 之前先在状态文件里登记（`pendingPosts`：发往哪里、回复哪些评论、正文的哈希、发帖时的 head——之后认领的总结只算作那个 head 的推送，而不是更晚的推送）。下一次运行会在 PR 上找每条登记过的回复：找到的——POST 已到达 GitHub 但响应丢失——按它当初回复的那些评论记录（`adopted`）；找不到的说明从未发出。回复永远不会按之后计划的措辞来认，为别的评论发的回复也永远不会被当成对新评论的回答。
- 回复里列出的评论如果已经回答过，就从这条回复里去掉；回复仍会回答其余评论，所以一轮运行期间新来的评论不会没人回答。
- 每条正文只加一次标记，且必须在 GitHub 的 65,536 字符以内。
- 每个发出的 id 一产生就写入状态文件，连同它所回复的评论。中途失败时，其余部分不发也不记录；用同一份计划重跑时会认出已发出的内容（见上），回复的评论全部已处理才跳过，评论都已处理的总结也跳过——除非该 head 是本监视推送且尚无总结：每次推送都有一条总结，每个 head 一条（记在 `summarizedSha`），不论它是否回答评论。
- `handledChecks` 和 `handledConflict` 记录这一轮没有靠推送修好的失败和冲突，prepared snapshot 不再报告它们：失败按 attempt 记（重跑后再次失败算新的），冲突按 head 记。
- `needsHuman` 每行一项，是这一轮留给人处理的事项。辅助命令把每项连同回答它时的 head 和时间记入状态文件，按时间先后排列，最多保留最新的 20 项，供 `status` 列出。空白会折叠，超过 300 字符的行会被截断，同一 head 上的同一行只记一次，所以重跑同一份计划不会增加条目。
- `--no-post`（skill 的 `--no-reply`）记录同样的内容（包括总结的 `summarizedSha`），但不发任何东西。

回复 review thread 使用 `POST /repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies`；总结是一条 issue 评论。两种 POST 都不重试：在传输错误之前已到达 GitHub 的请求会发出两次。

### 6.6 `cleanup <pr> [--force] [--take-over]`

一起删除 worktree、它的分支和状态文件。worktree 有未提交的改动（包括未跟踪文件和子模块里的改动，不受 `status.showUntrackedFiles` 或子模块的 `ignore` 设置影响），或者 worktree（worktree 已被删除时则是分支）有监视已知的任何 PR head 都不包含的提交时，三者都保留，并在报告里说明原因。监视照样结束：记下的任务（`watch`，第 6.11 节）被去掉，状态里记下 `ended`（时间和原因）。这样 `/autofix-pr resume` 不会重新启动它，仍在进行的一轮（删除任务之前就已排队的触发、同一会话的第二个进程）的辅助命令会拒绝它，它的闸门回答 `watch_ended`——否则其中任何一个都会丢弃保留下来的内容。显式启动（`prepare`，报告 `wasEnded`）会恢复它。已知的 head 是 `lastKnownHeadSha` 和 `pushedShas`，以及——只在前两者比完仍有多出的提交时才去问——远端的 PR head（`refs/pull/<n>/head`），所以手工推送过的工作不会被拦住。worktree 路径上的目录如果不是独立的 worktree，会被保留：在它里面运行 git 会判断外层 clone。没有状态文件时没有记录的 head，因此残留的 worktree 或分支都会被保留。状态文件属于另一个会话时直接拒绝，除非 `--take-over` 先像 `prepare --take-over` 那样把监视移交给本会话：`/autofix-pr stop <n>` 会带上它，这样另一个会话留下的监视也能停掉，而不丢弃其中的工作。`--force` 跳过这些检查，也会丢弃无法读取的状态文件。分支删不掉时报错，状态文件保留。在要删除的 worktree 内部运行 `cleanup` 会被拒绝。闸门游标不会被删除：它属于定时任务，而定时任务比一次监视活得久，没有游标的话下一次触发会把所有内容重新报告一遍。要停掉闸门，就删除该任务。报告里会写出保留的游标（`gateCursor`）：之后对另一个仓库同号 PR 的闸门会被拒绝，直到删除这个文件。

监视发出和处理过的内容——`handledCommentIds`、`postedCommentIds`、`handledChecks`、`rerunChecks`、`handledConflictSha`，以及已登记但尚未结算的回复（`pendingPosts`）和延后的重跑（`deferredRuns`、`heldChecks`）——后两者取监视自己当前的列表（它们本就从历史开始，之后已结算的不能再回来）——会在删除状态文件之前并入该 PR 的历史 `.qwen/tmp/autofix-pr-<n>-history-<host>+<owner>+<repo>.history.json`（同一个 clone 可能监视 fork 和上游里同号的 PR；`+` 和代替端口 `:` 的 `@` 不会出现在任何名字里，后缀也永远不会与 skill 可写的文件名重合），这个文件同样保留（报告里的 `history`）。`--force` 还会删除这次监视的锁，以防某个辅助命令在持锁时被杀掉。之后对同一 PR 的新监视在 `prepare` 时从它开始，所以不会再回复之前监视回复过的评论，也不会在同一 head 上把一个检查重跑两次；另一个仓库同号 PR 的历史会被忽略。

### 6.7 `review watch-repo --repo <owner>/<repo> [--host <host>] [--limit 50] [filters]`

评审者的探针，有自己的闸门。一次 GraphQL 调用读取最近更新的打开 PR（`--limit`，默认 50，最多 100）及其 head、draft 标志、作者、label 和评审请求，以及上限之外是否还有打开的 PR。游标 `.qwen/tmp/review-watch/<host>/<owner>/<repo>.json`（全部小写，端口前的 `:` 写成 `_`，所以同一仓库的各种拼写共用一个文件）记录每个打开 PR 的 head 和 draft 标志。带过滤项时文件为 `<repo>@<key>.json`，`<key>` 代表这组过滤项，与拼写和顺序无关：同一仓库上过滤项不同的两个任务各自保存 head，因为一个任务记下却因过滤而没有报告的推送，对另一个任务永远不会再是迁移：

- 首次运行记录打开的 PR，不输出任何内容。
- 之后，游标里没有的 PR 是 `pr_opened`，head 变化的是 `pr_pushed`，原来是 draft 现在不是的是 `pr_ready`。每个事件带编号、标题、作者、URL、head SHA、base 分支、label，以及是否请求了当前用户评审。
- 过滤项决定哪些 PR 成为事件：`--author <login>`、`--label <name>`（两者都像 GitHub 一样不区分大小写）、`--review-requested`（当前用户是被请求的评审者；team 请求不算）、`--exclude-drafts`、`--exclude-bots`、`--exclude-mine`。游标无论如何都跟踪每个 PR，换一组过滤项会使用自己的游标，其首次运行是静默的，所以更改过滤项不会重放历史。过滤项只在三种迁移中做选择，本身不是迁移：head 不变时加上 label 或请求评审不会输出任何内容，直到 PR 下一次推送。
- 列表里没有的 PR 已关闭或合并，会从游标中移除——除非列表被 `--limit` 截断。此时列表外的 PR 可能仍然打开，游标最多保留其中 `--limit` 个，编号大的优先，因为已关闭和已合并的 PR 无法区分，不设上限就会不断累积。被挤出游标、之后又有变化的打开 PR 会以 `pr_opened` 再次出现。

输出：`{ "repo": "<owner>/<repo>", "events": [...] }`，没有事件时什么都不输出。与作者侧闸门同样以 12 KiB 为限，放不下的事件被留下并计入 `deferred`；这些 PR 在游标里保留旧的 head，所以下一次运行会报告它们。使用它的 skill 决定每个事件的含义：对每个 PR 运行 `/qreview <number>` 或一次验证。

### 6.8 `sync <pr> [--discard] [--task <id>]`

一轮从 `sync` 开始，所以它也检查这一轮能否运行：监视没有结束（第 6.6 节）且归本会话，带 `--task`（即这一轮 prompt 写明的任务）时还要求该任务仍在驱动监视。在之后的 `schedule` 替换掉它的任务之前、或在 `stop` 结束监视之前就已排队的触发，会在这里被拒绝，这一轮随即删除该任务。`snapshot`、`ci-log`、`push`、`reply` 和 `rerun` 带同样的 `--task`、以同样的方式拒绝，所以任务被替换时已经过了 `sync` 的一轮，会在下一次辅助命令时停下。

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

### 6.10 `status [<pr>]`

列出这个 clone 的监视，从每个 worktree 的 `.qwen/tmp` 下它们的文件读取——扫描 clone 的全部 worktree，所以落在任何一个里的监视都会被列出（`--no-work` 让 `worktreeWork` 为 null，跳过它的 git 扫描）：不取锁，也不询问 GitHub，所以辅助命令运行期间也能回答，且不论监视归哪个会话。显式指定 root 时只扫描那一个 worktree。输出为 `{ "now": "<时间>", "watches": [...] }`；读不了的状态文件放在 `unreadable` 里，带 PR 和原因。每个监视包含：

- PR、它的仓库、host 和 URL；`headRefName`、`pushTarget` 和监视已知的 head（`headSha`）；
- `pushes` 和 `maxPushes`；
- `session`（拥有它的会话）和 `thisSession`；
- `preparedAt`：`prepare` 创建该监视的时间（在它开始记录这个值之前创建的监视为 null），`prepare` 也会报告它；
- `lastCheck`：监视自己的闸门（带 `--session` 的那个）最近一次运行的时间，不论它读取了 PR，还是因后台修复进行中而跳过读取（第 6.14 节）——每次这样的运行都会更新 `.qwen/tmp/autofix-pr-<n>-gate.checked`，`cleanup` 会随监视一起删除它；共用游标但不带会话的闸门不碰它；`lastRound`：最近一次已准备快照的时间；首次之前两者都是 null；
- `checkedRecently`：`lastCheck` 是否在该监视的两个间隔之内，即某个闸门（本会话的或别的会话的）很可能仍在运行。由辅助命令给出而不是由模型判断，因为模型知道日期但不知道时刻；
- `stopped`：闸门看到 PR 已合并或关闭而监视没有清理时为 `merged` 或 `closed`——以 `lastCheck` 时为准：PR 之后可能已重新打开，所以 skill 只通过会读 GitHub 的一轮来处理它；
- `watch`：`schedule` 记下的任务，`--once` 为 null；
- `ended`：保留了 worktree 的 `cleanup` 结束该监视的时间和原因；
- `needsHuman`（第 6.5 节）；
- `gitTrusted`：worktree 的 gitfile 和每个已检出子模块的 gitfile 都指向 clone 自己保管的 git 目录，直接读文件判断（第 6.12 节）；
- worktree 的路径及其是否存在，以及 `worktreeWork`：worktree 或其分支里有而 PR 没有的内容，按 `cleanup` 的方式判断，但不询问远端、也不占用 index 锁，没有则为 null。在它上面开始的一轮会丢弃这些内容，所以接管或 resume 会在提问前说明；
- `fix`：后台修复的尝试标记 `{ attempt, startedAt, fresh }`，没有则为 null。`fresh` 表示一个尚未结束的尝试：它的 agent 在 worktree 里工作，或已经结束（完成或被停止）、这次尝试仍可由这一轮认领——两种情况下这一轮的辅助命令都会拒绝；否则它是被会话遗留下来的，下一轮的 `sync` 会移除它（第 6.14 节）。

闸门游标比一次监视活得久（第 6.6 节），所以只有它指向该监视的仓库、且不早于该监视（`preparedAt`，由 `prepare` 写入：在 PR 重新打开并再次被监视之前看到它被关闭的游标，属于之前那个监视）时才读取；读不了的游标让 `stopped` 为 null，而不会让这个监视从列表里消失。状态文件只按辅助命令给出的名字读取（不带前导零），并且必须是它自己那个 PR 的；它和游标都只在是普通文件时才读取（同名的 FIFO 会让读取阻塞）；其他情况都放进 `unreadable`，并写明文件和处理办法（`cleanup <n> --force`）。

定时任务只存在于创建它的会话里，辅助命令看不到：由 skill 把列表和 `cron_list` 对照，说明哪些监视由本会话运行。

### 6.11 `schedule <pr> [--every <minutes>] [--no-reply] [--instructions] | --again`

把监视的定时任务记入状态文件（`watch: { every, reply, instructions, task }`；读状态时只取这些字段，文件里多出来的内容会被丢弃），并按 `cron_create` 的参数输出：`cron`、`recurring`、`gate`、`prompt`，以及这些选项。闸门和 prompt 都带着任务 id（`tick <owner>/<repo>#<n> --task <id>`），所以被替换掉的任务唤醒的一轮会在第一次 `sync` 时停下。skill 照原样用它们创建任务，这样闸门和 prompt 不再由模型拼出来。

- 每次运行都生成一个新的任务 id，由闸门带上（`--task`）。用这份输出创建的任务是该监视唯一的任务：其他任务——之前启动留下的、接管之前的，或同一会话在第二个进程里的副本——的闸门都会回答 stop（第 6.1 节第 5 步），skill 也会在创建这个任务之前删掉该 PR 的其他任务。

- `--every` 取 `1, 2, 5, 10, 15, 30, 60` 之一（默认 2），且必须带值；60 对应 `0 * * * *`。
- `--instructions` 从 `.qwen/tmp/autofix-pr-<n>-instructions.txt` 读取用户的附加指令，该文件由 skill 按用户原话写入。prompt 只有一行，所以空白会折叠，格式字符（双向控制符、零宽字符）会被去掉；超过 2,000 字符会被拒绝。
- 闸门写明拥有该监视的会话；在会话之外准备的监视，或会话 id 无法原样放进命令的（必须以字母或数字开头，这样它永远不会被当成选项），会被拒绝。
- 附加指令里的控制字符和空白一样折叠；状态文件自身的校验把记下的任务限制为一行、最多 2,000 字符，所以 `--again` 输出的不会更长。
- `--again` 用之前记下的选项、以新的 id 再次排程该任务，不接受其他选项：resume 在接管之后、跑那一轮之前运行它。没有记录任务的监视（`--once` 启动，或 `cleanup` 保留 worktree 时结束的监视）会被拒绝，这一轮已结束的监视也会被拒绝：用 `/autofix-pr <n>` 重新启动。
- PR 作者无法推送时拒绝——只要状态不是 `authorCanPush: true`：它的代码会在用户凭据可及的环境里运行，这只能按 `--once` 一轮一轮地确认，不能用于监视。
- `watch`、`ended`、`needsHuman` 里本 CLI 不认识的字段（较新版本写入的）会在读状态时被丢弃，因此也不会被写回。
- 只有拥有该监视的会话能运行它；任务做不出来时什么也不记录。

### 6.12 `autofix_pr` 工具

由一个 core 工具来运行这些辅助命令，这样权限规则才能点名它们。一次调用运行一个辅助命令：`command` 指明是哪一个（`prepare`、`snapshot`、`ci-log`、`push`、`sync`、`reply`、`rerun`、`schedule`、`status`、`cleanup`；`fix-end`，第 6.14 节；`unattended` 和 `attended`，第 6.13 节——`fix-start` 不是这个工具的命令：由后台修复的启动自己运行），带类型的参数携带它的选项（`pr`、`repo`、`host`、`take_over`、`task`、`run_id`、`lines`、`plan`、`no_post`、`discard`、`every`、`no_reply`、`instructions`、`again`，以及 `fix-end` 必需的 `attempt`）。工具自己拼参数，选项写成 `--name=value`，并且不经过 shell 启动 CLI，所以参数里的任何内容都不会被当成 shell 语法或选项；某个命令不接受的参数会在运行任何东西之前被拒绝。`reply` 的回复计划必须是 skill 写的那个，即 worktree 旁边的 `.qwen/tmp/autofix-pr-<n>-plan.json`——对本会话准备过的监视，就是那个 worktree 旁边——并且不能在 worktree 里面：PR 自己的代码树带来的文件不能代表用户在 PR 上发言。

- 它运行本会话所用的 CLI：`QWEN_CODE_CLI` 指向可用入口时用它——脚本经 JavaScript 解释器运行，可执行文件直接运行，Windows 的 `.cmd` 或 `.bat` 包装脚本跳过（只有 shell 能启动它们）——否则用解释器加上本进程启动时的入口。环境变量与 shell 给子进程的相同，带调用方会话的 id；工作目录是会话自己的目录，所以第 6.1 节第 7 步的 daemon 检查看到的和 shell 调用时一样。
- 一次调用最长十分钟，这是辅助命令最长需要的时间（`push` 给 pre-push hook 九分钟），回合被取消时随之停止。同一工作目录下的调用逐个执行——但不取锁的 `status` 不等任何调用，等待中被取消的调用会立即返回；其他进程由辅助命令自己的锁来管。
- 结果是辅助命令输出的那一行 JSON。非零退出就是辅助命令的拒绝，连同它的消息一起返回。
- 不提供 `snapshot --gate` 和 `cleanup --force`：闸门在模型之外运行，丢弃 worktree 里的工作只能由用户来做。
- 只有主会话有这个工具：子 agent、fork、teammate 和 workspace agent 都没有，code mode 的 `exec` 也调用不了它。
- 在 worktree 里运行任何 git 命令之前，`push`、`sync`、`status` 和 `cleanup` 都会直接读文件检查它的 `.git`：它必须指向本 clone 自己为某个 worktree 建的 admin 条目，而该条目也必须指回它。这个文件按 git 的方式读取（`gitdir: ` 加其余部分），路径按内核的方式解析，没有这个文件的 worktree 也会被拒绝。一轮运行的代码可以改写这个文件；它自己搭出来的 git 目录会把它的 config 交给那里的每一条 git 命令——`core.fsmonitor` 里的命令会在下一次 `git status` 时运行。
- 用户为 shell 工具配置的 PreToolUse 或 PostToolUse hook 看不到这些调用；为 `autofix_pr` 配置的才看得到。
- plan 模式下除 `status` 外它什么都不运行：规则会让一轮里的辅助命令绕过 plan 模式本会拦下的弹窗，而它们每个都会写东西。

`status` 只读，不需要审批。其他每次调用都和 shell 命令一样要询问——auto 模式下由分类器决定。规则按 `command` 和 `watch` 匹配；`watch` 由工具推导，模型无法设置：

- **`watch:confirmed`：本会话准备过的监视。** `prepare` 通过工具成功运行后，会话在内存里记下它报告的监视：PR、所属仓库和 host、准备时所在的目录、worktree、它的 `preparedAt`，以及 GitHub 当时说作者能否推送。一次辅助命令调用要算 `confirmed`，需要这条记录属于当前 clone，并且在判定权限时询问的 `status` 仍把该监视列为同一个——仓库、host、`preparedAt` 和 worktree 都相同——归本会话、未结束。这里的 `status` 带 `--no-work` 运行，跳过对 worktree 的 git 扫描；YOLO 模式下（什么都不问）和 plan 模式下（不运行任何辅助命令）则根本不运行。`push` 或 `sync` 只有在 git 不会运行它们触发的任何 hook（`pre-push`、`post-checkout`、`post-merge`、`reference-transaction`），或者该监视的修复已免询问（第 6.13 节）时，才算 `confirmed`：相对的 `core.hooksPath`（husky 的 `.husky`）会在 worktree 里解析，hook 就来自 PR 自己的代码树；而 clone 自己 hooks 目录里的 hook 可能是一个转发脚本（pre-commit、lefthook、husky 4），运行的是代码树里某个配置文件写的命令。这种调用的弹窗会说明这一点。此外，只有 `status` 报告 `gitTrusted` 时调用才算 `confirmed`：worktree 里的命令会读的每个 git 目录——它自己的和每个已检出子模块的——都必须由 clone 自己保管，而不是内嵌在子模块里或放在代码树可写的其他地方，否则 git 会读到 PR 可控的配置；对这样的 worktree，`status` 和 `cleanup` 根本不用 git 扫描。shell 命令的 ask 规则（`Bash(qwen autofix-pr push *)`）也会让工具的调用询问，任何针对该工具的放行规则和 auto 模式的分类器都代替不了，与 shell 写法一致（YOLO 对两者都忽略 ask 规则）。辅助命令读取的状态文件在一轮运行的代码够得着的地方，所以它只能让一次调用变成 `unconfirmed`；记录里的任何内容都不会从它读回。其他辅助命令调用都是 `watch:unconfirmed`。一轮开始时先通过工具运行 `status`：监视已不归本会话（`/clear` 之后，或被接管）时还在运行的任务会在这里结束、什么都不问，而不是走到会询问的辅助命令。`status` 还会给每个监视标上 `preparedHere`；本会话的监视这一项为 false 时——daemon 重启后恢复的持久任务（第 6.11 节），或 `/resume` 回到了这个会话——这一轮照常进行，辅助命令和修复按审批模式运行，与没有这个工具时一样，报告里会说明 `/autofix-pr resume <n>` 可以重新确认这个监视——即使本会话的任务驱动着这样的监视，resume 也会接手它。这条记录在通过工具对该 PR 运行 `cleanup` 时、以及会话结束时消失。
- **`watch:take-over`**：用于 `prepare --take-over` 和 `cleanup --take-over`（`/autofix-pr stop <n>` 运行的就是后者，所以会询问）。`prepare` 和 `status` 的 `watch` 是 `none`。
- **只点名 `command` 的规则覆盖该命令的每一次调用**，不论它的 `watch` 是什么：`deny: ["AutofixPr(command:push)"]` 会挡住所有推送。拒绝这次调用对应 shell 写法的规则——`Bash`，或 `Bash(qwen autofix-pr *)`——也一样，因为这个工具运行的是同一个程序，并且会执行仓库的 git hook。
- **启动、重新排程、接管，以及未确认的辅助命令**不提供"总是允许"：保存下来的规则会放行以后的每一次。`prepare` 的弹窗会说明，此后这个监视的每一轮都会不经询问地推送和回复；在 auto 模式下这个弹窗由用户回答，而不是分类器。其他情况下保存的规则会写明 `watch:confirmed`。

skill 的 `allowedTools` 以 `watch:confirmed` 放行一轮里运行的命令——`snapshot`、`ci-log`、`sync`、`push`、`reply`、`rerun` 和 `cleanup`——再加上 `status`；不放行 `prepare`（它启动或恢复监视），也不放行 `schedule`（一轮里从不运行它，而它会替换监视的任务和选项）。这些规则放行的范围同样由辅助命令划定：每个辅助命令都会拒绝由另一个任务驱动的监视（第 6.1 节第 5 步；第 6.8 节），`push` 检查推送去向并计数，`reply` 只回复有可信作者新评论的 thread。工具运行的 CLI 在每个进程里只确定一次，所以之后环境变化（比如重新加载的 `.env`）不会改变它。

在这个工具没有注册的地方——设置里的工具白名单（`autofix_pr` 属于它所列的 core 工具），或按命令执行的沙箱——skill 照旧通过 shell 工具运行同一个辅助命令。在那个沙箱下修复 agent 本来就无法启动：带 `working_dir` 的 `agent` 在那里会被拒绝。daemon 的 shell 守卫只检查 shell 调用；它从来看不到辅助命令内部运行的 git 命令，而这个工具的工作目录就是会话自己的目录。

### 6.13 修复命令不再询问：`autofix_pr` `unattended`

在 default、auto-edit 和 auto 模式下，修复 agent 每条命令都要先询问，所以此前只有整个会话都允许直接运行命令时，监视才能无人值守。现在启动、接管和恢复的提问里多了一个选项（"Start, fixes run without asking"），选了它，skill 就调用 `command: "unattended"` 加 `pr`：它用自己的弹窗确认这个选择，并记在本会话里。

- 弹窗里没有"总是允许"，授权只来自这个弹窗的回答：保存的规则、hook、auto-edit 的自动批准和 auto 模式的分类器都代替不了它。拒绝它就是取消一次工具调用，回合随之结束，所以 skill 只把它交给刚刚选了这一项的用户；此时监视已准备好但没有任务，重新运行启动或恢复即可。没人能回答时——headless 运行、后台 agent——它被拒绝；stream-json 宿主的回答、以及通过 `--input-file` 驱动会话的程序的回答也被拒绝，它们是程序，真需要这样会以 YOLO 模式运行。YOLO 模式下不需要它，也什么都不记录。在弹窗之前就能确定的拒绝（文件夹、宿主、下面说的监视条件）不弹窗，直接给出。
- 它只授权本会话通过工具准备过、且 GitHub 当时说作者能推送的监视（第 6.12 节），并且只在 `status <pr>` 仍把它列为本会话的、未结束、属于那个仓库（名字比较不区分大小写）、使用那个 worktree、`preparedAt` 不变时有效——同一会话的另一个进程重新准备过的监视就是另一个监视。授权只给弹窗里点名的那个监视；在回答之前又被重新准备的，会被拒绝。`status` 读的是状态文件，所以它只能收回授权。别人的 PR 永远不会被监视（第 8 节），这类 PR 的 `--once` 一轮每条命令都会询问。不受信任的文件夹和 session-agents 会话会被拒绝：它们的子 agent 拿不到特权模式。
- 授权保存在 CLI 进程里，以会话 id 和 worktree 的真实路径为键。不写任何文件。
- 它只作用于一种 agent：内置的 `general-purpose` agent——不是项目或用户自己定义的同名 agent，那种可能运行另一个执行器，本会话的 deny 规则管不到它——并且要由会话本身（而不是它的子 agent）以 `working_dir` 指向已授权 worktree 启动。启动前会再检查一次：文件夹仍受信任，监视仍满足上面的条件。然后这个 agent 以 YOLO 模式运行；它再启动的 agent 用会话自己的模式而不是 YOLO，不论执行器是什么。plan 模式保持 plan 模式；其他执行器（Codex）的 agent、teammate 和 workflow agent 不受影响。
- `command: "attended"` 收回该 PR 的授权，什么都不问：用户回答普通的"Start""Take over"或"Resume"时，以及带 `--yes` 时，skill 都会调用它，所以之前的选择不会延续过之后的选择。
- 授权在以下情况结束：通过工具对该 PR 运行 `cleanup`；报告了该 PR 另一个监视的 `prepare`（重新创建的、另一个仓库的，或从另一个会话接管来的；在同一个监视上再次启动或恢复，包括被拒绝的那次，不会结束它）；启动时的检查没有通过；会话结束——`/clear`、`/new` 和 `/resume` 会丢掉会话确认过和授权过的内容，离开的会话和进入的会话都一样；关闭会话也会丢掉，daemon 在重新加载一个会话之前就是这样做的。plan 模式不授予任何东西。

它并不约束这个 agent。agent 的运行方式和 YOLO 会话里的 agent 一样：带着用户的凭据，能访问 worktree 之外的文件，不受用户的 ask 规则约束；deny 规则仍然生效。弹窗会说明这一点；把别人的代码挡在外面的，是第 8 节的信任规则。任务已过期或被删除的监视，授权会一直保留到上面某种情况结束它。

### 6.14 后台修复与 `fix-end`

修复免询问的监视（第 6.13 节）把修复 agent 放到后台运行，这样它工作期间会话仍然可用。其他修复保持第 7 节的前台 agent——后台 agent 无法询问，而这类修复的每条命令都要询问——一轮的合并 agent、每个 `--once` 一轮（即使所在 PR 的监视免询问：授权和尝试都属于那个监视，带着它的选项）、在本回合内重新开始的一轮，以及上一次尝试被放弃的那一轮的修复（见下文）也都在前台。通过工具运行的 `status` 会说明本会话以免询问方式运行哪些监视（`unattended`）；YOLO 会话不记录授权，所以它的修复仍在前台。

**启动。** `agent` 工具拒绝 `working_dir` 与 `run_in_background` 同时出现，因为 worktree 归调用方所有，调用方可能在 agent 运行时删掉它。现在只为一种启动放行这一组合：会话在它持有免询问授权的 worktree 上启动的顶层、内置 `general-purpose` agent，且不在 plan 模式、文件夹受信任——也就是第 6.13 节以 YOLO 模式运行的那个 agent。参数检查只看授权是否存在而不复检；启动时像前台修复一样检查完整条件，任何一部分不满足就让启动失败，而不是在没有授权的情况下放到后台。然后由启动本身（而不是 skill）打开这次修复的尝试：授权运行 `fix-start <n> --attempt <id>`（只有会话会运行的辅助命令）。它会拒绝，除非本会话拥有该监视、监视未结束、那里没有任何尝试的标记（新鲜的说明有尝试在运行；过期的应由这一轮的 `sync` 移除），并且这一轮在最近 30 分钟内、以监视的任务在监视的 head 上准备了一份待修复的快照（prepared 快照会记下它所在的任务，所以 `--once` 一轮的快照永远不算数），而且每一次打印了内容的闸门运行都在那份快照开始读取 PR 之前就已读完（闸门游标记下最近一次这样的运行读完的时间 `reportedAt`，快照记下自己开始读取的时间 `readAt`；安静的运行即使移动了游标也不记）——否则闸门那次触发会在队列里等着，它的那一轮在修复运行期间跑完会发现无事可做，它报告过的事件也不会再来；前台修复时它会排在之后运行；然后它在状态文件旁写下尝试标记 `autofix-pr-<n>-fix.json`：尝试 id、监视的任务、head 和时间。认领（`fix-end`）会把这一轮的快照移到 `autofix-pr-<n>-fix-snapshot.json`，在下一轮准备新快照之前 `reply` 都读它；移除被放弃尝试的 `sync` 也会移除它的快照：之后的尝试都不会从它开始。被拒绝时启动随之被拒绝；在它之后失败的启动会结束这次尝试（`fix-end --abandon`：只移除标记，把这一轮的快照留给随后的前台修复）。只有授权已不成立、或没有一轮有修复可启动（辅助命令以 "no round of PR #<n> has a fix to start" 拒绝，包括快照存在、但闸门在它开始读取之后又报告过的情形）时，这一轮才回退到前台修复；其他拒绝（已有修复在运行、有被遗留的尝试、监视已不归这一轮）都会结束这一轮。所以 worktree 上每个后台 agent 都有一个属于准备它的那一轮的尝试，而尝试存活期间，不会有其他 agent、teammate 或 workflow agent 在那里启动，无论前台还是后台——但修复 agent 自己、或经由它启动的 agent 再启动的，属于这次修复本身：subagent 只能经由 `agent` 工具启动 agent（workflow 和 teammate 属于顶层会话），注册表的父链把每个这样的 agent 都连到修复 agent 上。会话自己对 worktree 的 `edit`、`write_file` 和 `notebook_edit`——修复自己的 agent 所做的除外——（路径按内核的方式解析：链接按其原样跟随，之后才处理其后的 `..`；也按 Windows 的方式解析，它先按字面折叠 `..`；任一方式落在 worktree 内即算在内）无论审批模式如何都会询问用户，因为修复 agent 会不经询问地构建、运行那里的东西；会话 `/cd` 进 worktree 后在自己目录里启动的 agent、teammate 或 workflow agent 会被拒绝。只有本进程知道这次尝试：另一个进程固定到这个 worktree 的 agent 不会被拒绝，启动也看不到在它之前固定在那里的 agent——这和这一步之前两个会话对同一监视的前台修复一样。

后台修复 agent 运行期间不接受 `send_message`（它的注册表条目带着一个拒绝它的原因，但它自己启动的 Monitor 的事件仍会送达），并且永远不会被继续：它结束后，`send_message`、复活它的 transcript、重启后的恢复都会被拒绝，依据是它保存的记录里写着的原因，以及它结束后注册表条目上的原因（运行期间条目不带，否则它自己启动的 Monitor 的事件也会被拒绝），它也从不常驻，所以之后的任何回合都不会在尝试之外——或在会话自己的目录里，复活的 agent 会在那里运行——再给这个 agent 派活。它保存的记录里留下的是没有授权时它会用的审批模式。

**尝试。** 会话把尝试记在内存里，与授权放在一起，并带上本会话自己的 `schedule` 打印出的监视的 `--no-reply` 和 instructions。这份记录在本会话内说了算：agent 运行期间，`autofix_pr` 工具拒绝该 PR 除 `status` 和 `cleanup`（它会停止 agent，见下文）以外的每个辅助命令，agent 结束之前也拒绝 `fix-end`——它的注册表条目到达终态，被停止的 agent 在它的工具都结束、或取消的宽限期用完时到达；之后认领还会最多再等 15 秒，让 agent 的主体真正结束。agent 启动期间要求的停止，会在它注册时生效。标记是给闸门和其他会话、其他进程看的：尝试存活期间，只要标记仍写着这次尝试，会话每 30 秒刷新一次它的修改时间（打开时不跟随链接、不阻塞，且只在它是普通文件时）；标记不再写着它、它写着的尝试开始时间比时钟超前一分钟以上（时钟被调回过，辅助命令会把标记读成过期的），或者某次刷新晚了一分钟以上（进程被挂起过，期间可能有别的会话接手了 worktree），会话就停止 agent。工具或 agent 工具查找这次尝试时也会发现刷新迟到：笔记本休眠醒来后，闸门可能在会话的计时器再次运行之前就发现标记过期，它启动的那一轮不能因为一个其实已经结束的尝试而被拒绝。接下来要动 worktree 的一方——通过工具运行的辅助命令、agent 工具的启动、teammate 或 workflow agent 的启动，无论是固定到那里，还是在会话自己位于其中的目录里启动——会先等待：从尝试被丢弃（刷新迟到、到期或授权被收回）时起最多 15 秒，让被停止的 agent 结束；停止和认领自己也会这样等，会话自己对 worktree 的写入在此之前也会询问。心跳启动之前，不会把任何刷新算作迟到。辅助命令认为标记新鲜的条件是：最近 90 秒内刷新过，且尝试的开始时间既不比时钟晚一分钟以上，也不早于 45 分钟之前。标记新鲜时：

- `sync`（包括 `--discard`）、prepared `snapshot`、`ci-log`、`push`、`reply`、`rerun`、`schedule`、`cleanup`（包括 `--force`）和 `prepare` 会拒绝，并说明是哪次尝试、何时开始：此时重置、推送、回复或删除，都会作用在做了一半的工作上；
- 闸门什么都不打印，不问 GitHub，也不移动游标，所以一次触发不花费回合，期间的变化留给尝试之后的那一轮；它仍会记下这次检查，所以 `status` 不会把监视看成被遗留的；
- `status` 显示它（`fix`），以及它是否新鲜；`status` 显示有新鲜尝试的定时一轮不发消息就结束。

agent 超过尝试时限（第 10 节，从尝试打开起 30 分钟）时，会话会停止它；这样的尝试仍然归这一轮认领，相当于 agent 被停止了。授权结束时（第 6.13 节：`attended`、启动检查未通过），会话停止 agent 并丢弃这次尝试：下一轮按用户现在的选择，在前台重做修复。本会话里的 `/autofix-pr stop`——通过工具运行的 `cleanup`——会在不发通知的情况下停止 agent，最多等 15 秒让它的主体结束（在辅助命令的队列之外等；agent 已经结束时也等，因为宽限期可能先让它结束），结束这次尝试，然后再清理；结束尝试的辅助命令被拒绝时，尝试留给下一次停止。尝试打开后 40 分钟内没有认领（通知要等会话空闲才送达，所以期限不从 agent 结束时算起），以及会话或它的进程结束、或它的对话被重置（`/clear`、`/resume`）时，会话会丢弃这次尝试，随之停止刷新标记；对话被重置时停止 agent 不发通知，否则通知会落进下一段对话。被丢弃尝试的标记在被停止的 agent 结束后（最多 15 秒）、只要它仍写着这次尝试，就会被设为过期，于是辅助命令那时就放下一轮进来，而不是 90 秒之后。另一个会话无法停止这个 agent：标记新鲜时，它的 `cleanup`、`prepare --take-over` 和 `resume` 都会拒绝，并说明拥有该监视的会话的修复正在那里运行。不再新鲜的标记就是被它的会话遗留下来的：闸门会为它打印一次 `abandoned_fix` 事件，所以即使没有别的变化也会运行一轮；那一轮的 `sync` 在给出答复之后移除它并报告 `abandonedFix`（失败的 `sync` 把它留给下一次），这一轮像对待任何没有结束的一轮那样丢弃 worktree 里的东西，并以前台修复重新处理这次尝试的事项——否则一个通知到不了模型的会话会一次又一次地放弃后台尝试。移除监视的 `cleanup` 和 `prepare --take-over` 也会移除这样的标记（保留 worktree 的 `cleanup` 把它留给下一次 `sync`）。

**续接。** 这一轮以 `run_in_background: true` 和 `description` = `autofix-pr <owner>/<repo>#<n> round` 启动 agent。定时的一轮随后用一行消息结束回合；启动或恢复则回到运行这一轮的那一步，所以监视在它的修复结束之前就排好了程。agent 结束时，只要这次尝试还归这一轮认领，它的完成通知就会带上一个由会话（而不是 agent）写的 `<follow-up>` 元素，放在 agent 已转义的 `<result>` 旁边：以 `after-fix <owner>/<repo>#<n> --task <task> --attempt <id>` 调用 skill，再加上记录里的 `--no-reply` 和 instructions。那个回合会重新进入 skill，不论对话里还留着这一轮的多少内容，并运行 `fix-end <n> --task <task> --attempt <id>`：它只移除那次尝试的标记，打印这次尝试取走的快照、它的修复说明和开始时的 head；工具再从内存里补上 agent 的结束方式、它的报告和监视的选项，这个回合以这些选项为准，不论 follow-up 里写的是什么。辅助命令拒绝时，这次尝试还可以再认领；若拒绝说的是这一轮的快照已不在，则丢弃它，任其过期。工具从 CLI 报错里点名错误的那一行读出拒绝原因，而不是从其后打印的调用栈读。修复说明里除了 agent 的事项，还列出这一轮自己的事项——修复之前就定下的重跑和需要人工决定的事项——所以这个回合也会回答它们。然后它像前台 agent 返回后那样继续第 7 节的重跑、推送和回复。失败或被停止的 agent 做的东西一律不推送：这个回合运行 `sync --discard`，把修复说明里的事项回答为需要人工决定——PR 上用固定的一句话，agent 的报告只留在会话里——和没通过验证的修复一样，所以它们会被记录下来，不会因为闸门已经报告过而丢失。辅助命令拒绝的认领——尝试已被丢弃，或被某一轮丢弃了——以一行消息结束。在 plan 模式下工具会拒绝 `fix-end`；这个回合会说明这一点，这次尝试按没有认领的尝试结束。一直没来、或来得太晚的通知，会把这次尝试留给 `abandoned_fix` 那一轮。

不带 `--no-post` 的 `reply` 在以 `--no-reply` 启动的监视上会拒绝，所以即使某个回合忘了这个选项，它也照样生效。

每个失败检查的修复推送预算（第 10 节）在这一步之后才交付：prepared 快照记录哪些检查失败、哪些通过（第 6.2 节）。

### 6.15 Web Shell：监视及其任务

Web Shell 在监视的主人本来就会看的地方显示它——它的定时任务卡片——并另有一页 **PR 监视**，列出它能访问的各工作区的全部监视。

**daemon 提供什么。** `GET /autofix-pr/watches`（主工作区）和 `GET /workspaces/:workspace/autofix-pr/watches`（已注册且受信任的工作区），以 `autofix_pr_watches` 声明，返回 `status` 为该工作区的 clone 列出的内容。用一次 `git worktree list` 找到 clone 的全部 worktree，所以工作区是 linked worktree 或子目录时，读到的也是这个 clone 的监视；答复里的 `root` 仍是主 worktree（用于展示）。`runStatus` 接收这组 worktree（`roots`）、不带会话，而不是用 daemon 自己的目录和环境，并且不运行任何 git 命令（`git: false`）：daemon 在自己的线程上列出监视，一条卡住的 git 命令会拖住所有请求。它只读文件，每个文件都以不跟随链接、不阻塞的方式打开，所以有人把某个文件换成 FIFO 也拖不住 daemon（辅助命令也这样读）。不取锁、不询问 GitHub，所以辅助命令运行期间也能回答。不返回的有：`thisSession`（daemon 不是会话）、worktree 的路径，以及只有 git 才能给出的 `gitTrusted`、`worktreeWork`。找不到该工作区的 git 仓库、或那里无法运行 git 时，`available` 为 false。这些路由不修改任何东西。

**哪个监视属于哪个任务。** 定时任务没有类型字段：监视的任务按 `schedule` 写的提示词识别——`Run /autofix-pr tick <owner>/<repo>#<n> [--task <id>]…`——与任务所在工作区里同仓库、同编号的监视对应。任务是否过时，按它的闸门的判断：监视已结束、任务带 id 而监视没有记录任务，监视记录的是另一个任务（之后的 `schedule` 替换了它；早于任务 id 的任务也不算记录的那个），或监视已属于另一个会话（被接管了）。过时的任务会被它的闸门在下次触发时停止，卡片上也会说明。

**显示什么。** PR（链接），以及监视所处的状态，按以下顺序取第一个成立的：

- PR 已合入或关闭（`stopped`）；
- 被保留 worktree 的 `cleanup` 结束（`ended`）；
- 没有任务（`watch` 为 null：`--once` 检查留下的状态）；
- 后台修复进行中（新鲜的尝试，附已进行的时间）；
- 后台修复被遗留（过期的尝试：下一轮会重做）；
- 两个间隔内检查过（`checkedRecently`）；
- 否则为最近没有检查。

然后是推送次数及上限、闸门上次检查和上一轮的时间，以及留给人处理的事项（`needsHuman`）。页面也像 `status` 一样，列出读不了的状态文件及原因。

**操作。** 只对所属会话是本 Web Shell 会话的监视提供：它有一个没有过时的任务，绑定在状态文件写明的会话上。页面在它列出的所有工作区里找这个任务；同一 clone 的监视只列一次，因为同一个 clone 的两个 checkout 可能都注册成了工作区。

- **打开会话**：打开那个会话。
- **停止监视**：像定时任务的手动运行发送提示词那样，把 `/autofix-pr stop <n>` 发到该会话——切到那个会话，提示词与手动输入走同一条路径——由 skill 执行，并照常弹出它在那里会弹的确认。Web Shell 不会自己写监视的文件，也不会删除它的任务。

两者都在其任务所在的工作区恢复会话（单项目 daemon 的那个唯一工作区也一样），不论监视列在哪个工作区下，也不论当前对话是什么（其他工作区的、standalone 或 Live）。

没有本 Web Shell 会话在运行、但闸门两个间隔内检查过的监视，运行在其他进程里（终端会话），要在那里停止，页面会说明。其余的——已结束、没有任务，或最近没有任何检查——在其工作区的会话里用 `/autofix-pr stop <n>` 或 `resume <n>` 清理或重新开始，页面会写明命令。

**刷新。** 页面和卡片显示期间每 15 秒重读一次监视；卡片只在列表里有监视的任务、且 daemon 声明了该能力时才读取。

## 7. 一轮检查（`tick`）

闸门已经运行了 `snapshot --gate`；到达模型的触发在闸门输出里带着事件，所以安静的检查永远不会变成一个回合。

```text
snapshot --gate (in the gate)
  ├─ stop     → cleanup, cron_delete, report outcome
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

修复由 `agent` 完成，`working_dir` 设为 worktree。它的说明是一个文件，列出事件、日志路径、信任规则、用户追加的指示和验证要求。agent 在前台运行——`agent` 工具拒绝 `working_dir` 与 `run_in_background` 同时出现，因为 worktree 归调用方所有——它返回后主会话执行 `push` 和 `reply`。唯一的例外是修复免询问的监视：那里工具为该监视 worktree 上的内置 `general-purpose` agent 放行这一组合（不在 plan 模式、文件夹受信任），agent 在后台运行，这一轮从它的完成通知继续（第 6.14 节）。验证失败时不推送，并报告失败原因。

后台修复的尝试标记（第 6.14 节）在它的 agent 工作期间让闸门保持安静、让这一轮的辅助命令拒绝运行。会话已结束的尝试不会让监视一直等待：它的标记会过期，下一轮会移除它并丢弃 worktree 里的东西。

resync 时如果新 head 不包含 worktree 的 `HEAD`（作者 rebase 或 force-push 了），worktree 会被重置到新 head，而不是快进。工具推送过的内容此时已在作者手中，是作者改写的那段历史的一部分。重置最多丢掉一次没有推送的尝试，它基于旧的 head，`push` 本来也会拒绝它；这次尝试按上面的规则结束。

一轮检查从不向用户提问。需要人来判断的情况（设计分歧、互相矛盾的评论、超出 PR 范围的要求）会回复"需要人工决定"并记入 `needsHuman`。循环继续关注其他事件。这一轮会在 PR 上回复这类事项，在本轮消息里报告，并写进回复计划的 `needsHuman`，由 `status` 列出（第 6.5、6.10 节）。

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
- 其他任何人的评论。它们会出现在这一轮的快照和报告里，但不会被处理，也不会被回复。

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

- 启动时立即跑第一轮检查——已准备模式的 `snapshot <n>`，它读状态文件而不读闸门游标，所以新的监视能看到所有未处理的事项，不论旧闸门报告过什么——然后在 `status` 确认监视仍记录着它之后，用那一轮之前 `schedule` 输出的任务（第 6.11 节）调用 `cron_create`——这一轮的修复 agent 可能写进状态文件的内容，到不了任务里：循环任务——终端会话里是会话级任务，daemon（`QWEN_CODE_SERVE=1`）里是绑定该会话的持久化任务，否则会话空闲回收会把会话级任务的内存调度器一并带走——cron 为 `*/<every> * * * *`（默认 `*/2`），闸门为 `qwen autofix-pr snapshot <n> --gate --repo <owner>/<repo> --host <host> --session <sessionId> --task <task>`（即传给 `prepare` 的 host 和拥有该监视的会话），prompt 告诉模型如何处理闸门输出中的事件（`Run /autofix-pr tick <owner>/<repo>#<n> --task <task>`）。第一轮也在这个任务下运行。闸门在创建任务时像 Monitor 命令一样确认一次。一个 daemon 会话只承载一个定时任务，因此第二个监视需要另开会话。
- 会话忙时到达的触发会在通知队列里等待；会话空闲后探针运行一次，输出自上次运行以来的全部新内容。
- 任务随进程结束，daemon 会话例外：任务持久化并绑定该会话，daemon 会保活该会话，重启后重新加载它。状态文件保留，归写下它的会话所有，新会话的 `prepare` 会拒绝它（第 6.1 节）。之后的会话在用户同意后用 `prepare --take-over` 接管监视，推送和预算都保留（第 6.1 节第 5 步）。`/autofix-pr resume` 对本会话没有在运行其任务的每个监视做这件事：确认一次后接管，并创建启动时 `schedule` 记下的任务（`schedule --again`），监视按原来的间隔、`--no-reply` 和附加指令继续。过期的任务也用同样的方式恢复。它先对要恢复的每个监视完成接管并运行 `schedule --again`，然后才跑任何一轮——一轮的修复 agent 就在其他监视的状态文件旁边工作——打印出的选项与提问时不同的监视会被排除；新的任务 id 让这些监视的其他所有任务（包括同一会话在第二个进程里的）停下，并删掉本会话里这些 PR 残留的任务。然后在各自的任务下逐个跑一轮，最后在 `status` 确认监视仍记录着该任务后，按打印出的内容创建任务；没有点名 PR 时，跳过另一个会话的闸门在两个间隔内检查过的监视；`stop` 在保留 worktree 时结束的监视没有记录任务，不会被恢复。监视发出和处理过的内容保存在 PR 的历史文件里（第 6.6 节），所以新的监视不会再回复同样的评论。已经停止的监视已经运行过 `cleanup`。
- cron 最长存活时间的设置（`QWEN_CODE_CRON_MAX_AGE_DAYS`）仍然生效。

预算记录在状态文件里：

| 预算                                   | 默认值 | 用完时                   |
| -------------------------------------- | ------ | ------------------------ |
| 同一个失败检查在变绿之前的修复推送次数 | 3      | 留给人处理，直到它通过   |
| 每个检查在每个 head SHA 上的重跑次数   | 1      | 下一次失败按真实失败处理 |
| 每条 review 评论的修复次数             | 1      | 不再提供                 |
| 每次启动的推送次数                     | 10     | 停止循环                 |
| 连续被别人移动 head 的次数             | 2      | 停止循环                 |
| 一次后台修复可运行的分钟数             | 30     | 停止它的 agent，丢弃它   |

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
   除评审者监视外已交付（2026-10-24）：`push`、`sync`（第 6.8 节）、`reply`、`rerun`（第 6.9 节），以及支持 `--once`、watch 模式、`stop` 和简单 `status` 的 bundled skill。这一步里修复 agent 在前台运行：会话等它结束，所以不会有触发再启动第二次尝试（第 4 步的后台修复加上了第 6.14 节的尝试标记）。它执行的预算是每次启动的推送次数（`push`）、每个检查每个 head 一次重跑（`rerun`），以及每条 review 评论一次尝试（一轮处理过的评论无论结果如何都会被记录；最后一次推送所在的那一轮是监视的最后一轮）；同一轮内两次 resync 会停止监视；一轮没能推送的工作以 `sync --discard` 结束，下一轮不会建立在它之上。第 8 节的沙箱规则在启动时执行，每一轮都先运行 `sync`，所以 GitHub API 尚未显示的推送或回退也会被跟上；推送之前还会再 sync 一次，把修复 agent 的合并留在原处的子模块移过去。skill 的 `allowedTools` 只放行读取它的 `.qwen/tmp` 文件、写它的修复说明、回复计划和用户的附加指令（最后一项由第 4 步加上），以及 `cron_list`——不放行任何 shell 命令。权限匹配器把开头的 `"${QWEN_CODE_CLI:-qwen}"` 读成空词，没有规则能只放行这些辅助命令；而即使是 `gh pr view *` 这样只读命令的放行规则，也会连带放行其后的命令替换、重定向和环境变量前缀。所以在默认审批模式下，每次辅助命令调用——包括推送——都会先询问；第 4 步的 `autofix_pr` 工具改变了这一点（第 6.12 节）。
4. 循环状态：`status`、`stop`、预算，以及由之后的会话接管状态文件。
   已开始（2026-10-25）：`status`（第 6.10 节）从文件列出每个监视，包括留给人处理的事项（回复计划里的 `needsHuman`，第 6.5 节）；`schedule`（第 6.11 节）记录监视的任务；`/autofix-pr resume` 接管监视并重新排程该任务。`autofix_pr` 工具（第 6.12 节）运行这些辅助命令，所以 skill 的 `allowedTools` 可以点名一轮里的辅助命令，它们运行时不再询问；`unattended`（第 6.13 节）让已确认监视的修复 agent 运行命令时也不再询问。这类监视的修复 agent 在后台运行（第 6.14 节），到第 10 节的 30 分钟时限即被停止。Web Shell 在任务卡片和 PR 监视页上显示每个监视，并在所属会话里停止它（第 6.15 节）。之后交付（2026-10-31）：第 10 节中每个失败检查的修复推送预算。用完时该检查作为需要人工处理来回答，监视继续运行而不是停止：它仍然处理评审反馈和其他检查。
5. 后续工作：可配置的 bot 允许名单。

待定问题：

- 有了配置项之后，可信 bot 是否默认收窄为一个可配置的允许名单？
- draft PR 是否也要监视，还是在标记为 ready 之前拒绝？
- 有些自动化程序以拥有协作者权限的普通用户账号发评论（在本仓库，`qwen-code-review-bot` 就是这样发布 triage 状态评论的）。这类评论能通过信任规则，每条在被标记为已处理之前都要耗费一轮修复。是否要提供一个可配置的自动化账号列表并跳过它们？
