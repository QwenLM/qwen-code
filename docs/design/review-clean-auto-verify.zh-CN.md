# 评审干净的 PR 自动进入深度验证

[English](review-clean-auto-verify.md) | [简体中文](review-clean-auto-verify.zh-CN.md)

状态：已随本次改动实现。

## 问题

维护者跑完 `/review <pr>` 拿到干净裁决后，仍要自己注意到这个裁决、判断这个改动
值得补行为证据、再手工起一轮 `/verify-pr <pr> --publish`。产品里没有任何东西把
两者接起来，于是这次交接是一种人的习惯：越忙越容易被跳过，而且每换一个平台都要
重新拼一遍。

显而易见的捷径——bot 评审发出 approve 后用 GitHub Actions 触发验证——被否掉了。
评审管线早已不止服务 GitHub（`packages/cli/src/commands/review/lib/platform/`
在同一注册表后面放了 GitHub 与 Aone 两个 provider），GitLab 也是明确方向。工作流
触发在构造上就是 GitHub 专属，跑在操作者会话之外，也无法创建子会话。这次交接应当
属于 qwen-code 内置能力。

**评审者不一定是 qwen-code。** 一个 PR 可能由别的 agent（Codex、Claude Code）、
CI bot 或人来评审。把入口焊死在 qwen-code 自己的评审管线上，这些情况一个都覆盖
不到；因此事件契约必须能从管线之外抵达，消费者也必须能处理一条不指向任何
qwen-code 会话的事件。

## 现状

以下均已对着本次改动所基于的代码树核实：

- 裁决权威是 `qwen review compose-review`，由 `qwen review save-artifact` 持久化为
  `.qwen/reviews/<report>.json`（`ReviewArtifactV1`：`target`、`effort`、
  `verdict`、`findings`、`counts`、`markdownReportPath`）。`save-artifact` 在
  Step 8 执行，晚于 Step 7 的提交与 Step 6B 可能的重新 compose，早于 Step 9
  cleanup 清扫 `.qwen/tmp`。
- `compose-review` 已经在算「本轮能否认证它所评审的范围」。
  `anchorFailsClosed(cappedBy, scopeUnproven, dimensionGapsAreDepthOnly)` 决定
  composed body 内 `qwen-review-ledger` 标记的 `sha` 字段是否写出：任何未决阻塞、
  未证明的覆盖、或模块自己算出的除「纯深度 `unreviewed-dimension`」以外的任何
  cap，都会 withhold 这个锚点。该标记就是这个决定的持久化形态。
- `fetch-pr` 写出的 plan 报告（`.qwen/tmp/qwen-review-pr-<n>-fetch.json`）带有
  目标身份：`prNumber`、`ownerRepo`、`host`（github.com 时为 null）、`fetchedSha`。
  `compose-review` 通过 `planPrIdentity` 读的正是同一个文件。
- 会话身份经 `QWEN_CODE_SESSION_ID` 到达 review 子命令，由
  `packages/core/src/services/shellContextEnv.ts` 导出，且已被
  `review/lib/paths.ts`、`review/lib/transcripts.ts`、`review/lib/run-ledger.ts`
  读取。
- daemon 具备派生子会话的能力：`createSubSessionLauncher`
  （`packages/cli/src/serve/create-sub-session.ts`）接为 bridge 的
  `onCreateSubSession`，带 per-caller 与工作区两级并发闸和 depth-1 嵌套闸。
  `launch` 要求 `callerSessionId`，并通过 `bridge.getSessionSummary` 解析它。
- daemon 已经有本次所需的消费者形态：`startScheduledTaskKeepalive`
  （`packages/cli/src/serve/scheduled-task-keepalive.ts`）把周期 tick 与对一个
  持久化 JSON 文件的 `fs.watch` + debounce 组合起来，带 in-flight 守卫、`unref`
  定时器、以及工作区生命周期读取的 `activeWork` 信号。它由 `server.ts` 按受信
  工作区逐个启动，并经 `app.locals` 停止。
- 宿主受信的评审状态放在任何仓库工作区之外：`reviewTrustStateDir(repositoryRoot)`
  解析为 `<globalQwenDir>/review-state/<projectHash>`。
- `/verify-pr` 是项目级 skill（`.qwen/skills/verify-pr/`）。它的本地维护者轮次用
  `gh` 解析坐标（`scripts/verify-pr-prepare.mjs`）；今天没有 `--host` 旗标，也没有
  Aone 或 GitLab 后端。

## 目标

- 一轮干净的评审产出一条持久化、平台中立的事件。
- daemon 消费该事件并派生子会话执行
  `/verify-pr <number> --publish --repo <owner>/<repo>`，不依赖模型记得这次交接。
- 该机制默认可用、可关闭，且仓库不能替它的评审者改这条策略。
- 以后新增平台时，事件 schema 与消费者的控制流都不需要改。
- 以后新增生产者时，消费者完全不需要改：任何 agent、脚本或人都能记录同一条
  事件，且一条不指向 qwen-code 会话的事件仍然是可行动的。

## 非目标

- 不做 GitHub Actions 触发，不新增工作流，不改 CI。
- 不实现 `/verify-pr` 的 Aone 或 GitLab 后端。事件携带平台；消费者拒绝它当前还
  无法验证的目标，并说明原因。
- 不新增 hook 事件、不做公共事件总线、不新增 REST 路由。事件就是一条由单个内置
  自动化消费的持久化记录，而 CLI 就是它的入口：本地生产者不需要 daemon socket、
  不需要 token、也不需要 daemon 正在运行。路由只会为「另一台机器上的生产者」
  增加可达性，而这里没有这种场景。
- 不自动观测 qwen-code 没做过的评审（下文 E2）。契约保持开放，以便日后加上观测
  时不必搬动任何东西。
- 不改评审裁决、ledger 标记或发布规则。

## 方案

### 1. 事件

`packages/cli/src/commands/review/lib/review-events.ts` 拥有 schema、目录、写入器
与读取器。

```jsonc
{
  "schemaVersion": 1,
  "eventId": "<去重键的 sha256，16 位十六进制>",
  "createdAt": "<ISO-8601>",
  // 可选：只有 qwen-code 自己的管线才有会话可指。没有它时，消费者派生的是
  // 顶层自动化会话，而不是子会话。
  "sessionId": "<QWEN_CODE_SESSION_ID，若已导出>",
  // 谁断言这个 head 是干净的——一个会发布公开评论的动作必须可归因。
  "reviewedBy": "qwen-code/save-artifact",
  "target": {
    // 普通字符串，不是今天的 provider 联合：以后新增的 provider 仍必须可读。
    // 由消费者决定它能服务哪些平台。
    "platform": "github",
    "host": "github.com",
    "ownerRepo": "QwenLM/qwen-code",
    "number": 15846,
    "headSha": "<评审实际读到的 head>",
  },
  "round": 3,
  "verdict": { "event": "APPROVE", "critical": 0, "suggestion": 2 },
  // 可选：外部生产者没有 qwen-code 产物。
  "artifactPath": "<已保存评审产物的工作区相对路径>",
}
```

读取端强制执行契约，而不是信任写入端：`verdict.event` 必须是 `APPROVE` 或
`COMMENT`，`verdict.critical` 必须是 `0`（这条记录本身就是「干净」的断言），
`headSha` 必须是十六进制，`ownerRepo`/`host` 必须落在一个无法把第二个旗标带进
prompt 的字符集内。任何一条不满足的记录被报为不可读，绝不会被派生。

位置：`<reviewTrustStateDir(root)>/verify-events/pending/<eventId>.json`。放在
宿主受信目录、仓库之外，理由与 `review-state` 的其余部分相同：一条待处理事件会让
daemon 派生一个执行 PR 代码并发表评论的会话。能写这条事件的仓库，就能挑选那个
prompt。事件文件名是去重键的摘要，因此同一 head 的重复产出会覆盖同一个文件，而不是
排出第二轮。

去重键：`platform:host:ownerRepo:number:headSha`。刻意不含 round——同一 head 的
两轮干净评审是一次验证，不是两次。

### 2. 生产者

两个入口写同一条记录。除了 `reviewedBy` 与是否带 `sessionId`，消费者分辨不出
它们，而且下面没有任何一道闸门依赖这两者。

**E1 —— `qwen review verify-event`，面向任何生产者。** 别的 agent、脚本或人
显式记录这次交接：

```bash
qwen review verify-event --pr 15846 --repo QwenLM/qwen-code \
  --head <评审读到的 sha> --reviewed-by codex
```

构造上就是离线的：它不读平台、不需要凭据，因此生产者没有 GitHub token 也能交接，
而且 daemon 当时不必在运行——记录是持久的，等它下次运行时自会被取走。非 GitHub
目标必须给 `--host`（没有默认 host，与 `review meta` 的拒绝一致）；`--session-id`
默认取 `QWEN_CODE_SESSION_ID`，对外部调用者通常不存在。用法错误退出 2，写入失败
退出 1，stdout 只输出一个 JSON 对象。调用者断言两件它自己负责的事实：读的是哪个
head，以及本轮没有发现 Critical。

**E3 —— `saveReviewArtifact`，面向 qwen-code 自己的轮次。** 零配置：产物写完后
产出事件，尽力而为——产出失败只在 stderr 披露，绝不使命令失败，与 Step 8 里
`record_artifact` 的姿态一致。

内部触发谓词由该命令本来就要读的输入算出：

1. `counts.bySeverity.critical === 0`。
2. composed body 的 ledger 标记可解析（`parseLedger`）且带有 `sha`。这就是模块
   自己「本轮认证了它的范围」的决定，它求值时用到的输入（`scopeUnproven`、
   `dimensionGapsAreDepthOnly`）并未全部持久化——只凭 `cappedBy` 重新推导会得到
   第二个更弱的谓词，并与第一个漂移。
3. composed 输入旁边的 plan 报告能解析出 PR 身份（`planPrIdentity` 的形状：
   `ownerRepo`、正的 `prNumber`、hostname 形状的 `host`）。路径是确定性兄弟文件
   `.qwen/tmp/qwen-review-<target>-fetch.json`，与 `compose-review` 处理
   `qwen-review-pr-<n>-prev-ledger.json` 用的是同一套约定。不加新旗标、不发网络
   请求、不改 skill prose。

`verdict.event` 必须是 `APPROVE` 或 `COMMENT`；一个计数 Critical 为 0 的
`REQUEST_CHANGES` 轮次是矛盾态，消费者不得据此行动。

平台用 `detectPlatformKind({ host })` 解析——只读、绝不抛错、不做认证——因此
Aone 目标产出的是 Aone 事件。

### 3. 消费者

`packages/cli/src/serve/review-verify-automation.ts` 仿照
`startScheduledTaskKeepalive`：周期 tick（60 s 兜底）加对 pending 目录的
`fs.watch` 与 500 ms debounce，同一时刻只跑一趟，定时器 `unref`，向工作区生命周期
暴露 `activeWork`，`stop()` 幂等。

每一趟对每条待处理事件：

| 闸门                                                             | 拒绝原因               |
| ---------------------------------------------------------------- | ---------------------- |
| `review.autoVerify` 打开（仅 operator 作用域）                   | `disabled`             |
| `target.platform === 'github'` 且 `target.host === 'github.com'` | `unsupported-platform` |
| 工作区内存在 `.qwen/skills/verify-pr/SKILL.md`                   | `skill-unavailable`    |
| `sessionId` 存在，**或**已接好可用于无父派生的 bridge            | `no-session`           |
| 去重键不在 `spawned.json` 中                                     | `already-verified`     |

被拒绝的事件从 `pending/` 移除并记录原因，不重试。此刻无法行动的事件，不会在没有
新一轮评审的情况下变得可行动，而新一轮评审会写出新事件。

被接受的事件按 write-ahead 处理：

1. 把去重键追加进 `spawned.json`（有界、FIFO、200 条）。
2. 按「是哪个生产者写的事件」派生：
   - **带会话** → `launch({ prompt, completion: 'sent', callerSessionId, name })`，
     走该工作区自己的子会话 launcher，因此 per-caller 与工作区两级并发闸、
     depth-1 闸都生效，UI 也能把这一轮链回评审。
   - **不带会话** → `spawnReviewVerifySession`，经 bridge 派生一个**顶层**会话
     （`spawnOrAttach` thread scope → 命名 → `sendPrompt`），与 launcher 自己的
     非 standalone 路径同一套顺序，只是去掉父 lineage。launcher 服务不了这种
     情况：`callerSessionId` 是必需的，且它的并发桶与嵌套闸都以它为键。这条路的
     并发由 bridge 的 `maxSessions` 准入与上游的按 head 去重约束；prompt 派发被拒
     会被报出来，而不是吞掉。
3. 删除 pending 文件。

先记录再派生是刻意的：在两步之间死掉的 daemon 绝不能重放一轮可能已经发过评论的
验证。代价是派生失败不重试——失败连同原因一起记日志，操作者可以手工跑
`/verify-pr`。对于一个输出是公开评论的功能，「绝不重复发布」优先于「绝不错过一轮」。

两条路的 prompt 都是 `/verify-pr <number> --publish --repo <ownerRepo>`。会话在
同一工作区运行，因此项目级 skill 与操作者的 `verifyPr.assetsRepo` 坐标原样适用，
daemon 既有的 `/verify-pr` prompt 准入也会把 PR 徽标绑到新会话上。
`completion: 'sent'`（以及无父路径的 fire-and-forget 派发）让评审会话不被阻塞。
派生日志会带上 `reviewedBy`，因此由别的 agent 的断言触发的公开评论在 daemon 日志
里是可归因的。

### 4. 策略

`review.autoVerify`，布尔，默认 `true`，加入 `review` 设置组，并经
`operatorReviewSettings()` 读取——该加载器带 `skipWorkspaceSettings: true`，因此
由 User、System、SystemDefaults 决定，仓库自己的 `.qwen/settings.json` 被忽略。
消费者只在「有待处理事件」的那一趟重新读取，所以关掉它无需重启即生效，而安静的
工作区完全不会去读设置。

一处刻意的不对称：当设置**完全无法加载**时，该字段降级为 `false`，而不是它的
schema 默认值。该加载器既有的契约是「降级不产生任何公开写入」（`comment` 出于
同样理由降级为关），而这次交接会发布一条报告评论。一个可读文件里写了非布尔的
乱值仍然默认开——那种情况是操作者从未表达过策略，而不是丢失了策略。

### 5. 装配

`server.ts` 在 `startKeepaliveForWorkspace` 里紧挨 keepalive 启动该自动化，使用
同一个受信工作区谓词与同一个 `WorkspaceRuntime`；既有的 keepalive 命名的
`app.locals` start/stop 钩子同时治理两者。`run-qwen-serve.ts` 不需要新增调用点：
已经为「新增 runtime」与「正在排空 runtime」启停 keepalive 的那两处，现在也覆盖
这个自动化。

`WorkspaceRuntime` 新增可选的 `subSessionLauncher`，在全部三个构造点（primary、
secondary、动态工作区）都赋值，因此自动化调用的是该 runtime **自己的** launcher
——也就是接进它 bridge 作为 `onCreateSubSession` 的那一个——并继承它的并发闸与
depth-1 闸。没有 launcher 的 runtime 得到的是「没有自动化」，而不是借用别人的。

与 keepalive 不同，这个自动化**不接收 runtime base dir**。它的目录挂在
`Storage.getGlobalQwenDir()` 之下——后者只读 `QWEN_HOME`（或 home 目录），从不读
runtime-base 上下文——以及规范化后的仓库根。工作区 `.env` 无法重定向 `QWEN_HOME`
（它是硬编码的项目排除项），因此评审会话的 CLI 子进程与 daemon 在构造上就解析到
同一个目录。把这一趟包进 `Storage.runWithResolvedRuntimeBaseDir` 只会暗示一个并不
存在的依赖。

整段逻辑位于 `deps.manageScheduledTaskSessions` 之下，而 `run-qwen-serve.ts` 把它
设为 `opts.profile !== 'hosted-harness'`。因此这次交接在普通 daemon 中运行，在
hosted-harness profile 中关闭——它属于同一类「后台派生会话」的自动化，受同一个
开关治理。

## 设计决定

- **入口是一份契约，不是一个管线钩子。** 第一版只从 `save-artifact` 产出，等于
  默认评审是 qwen-code 做的。事实并非如此：可能是别的 agent、CI bot 或人。所以
  记录本身才是接口，`review verify-event` 是任何人都能调的生产者，内部产出降级为
  众多调用者之一。消费者的任何闸门都不读生产者是谁。
- **无父事件派生顶层会话，而不是被拒绝。** launcher 的 `callerSessionId` 是必需
  的，且它的并发闸与嵌套闸都以它为键，外部事件用不了它。拒绝这类事件（第一版的
  `no-session`）会让这个开放入口形同虚设。bridge 路径就是 launcher 自己用的那套
  派生顺序，去掉 lineage。
- **内部生产者选 `save-artifact`，不选 `compose-review` 或 `submit`。** compose-review 跑在
  Step 6B 可能修发现并重新 compose 之前，那里产出的事件可能描述一个本轮随后改掉的
  裁决。`submit` 只在发布轮次运行。`save-artifact` 是每一轮 medium/high（无论是否
  发布）最终裁决的终态持久化。
- **用 ledger 锚点，不新造 cap 清单。** 干净轮次的决定已经存在于代码中且已被持久化。
  在 `cappedBy` 之上再造一个谓词，会在第一次新增 cap 时静默地与它分叉。
- **宿主受信目录。** 仓库可写的状态绝不能挑选一个由 daemon 执行的 prompt。
- **write-ahead 去重，失败即丢弃。** 失败方向是少一轮验证，绝不是多一条公开评论。
- **暂时只接 `github.com`。** `/verify-pr` 没有 `--host` 旗标，GHE 目标无法在
  prompt 里表达；从环境里猜 `GH_HOST` 会验证到错误的实例。事件仍然记录 host，
  所以以后放开这道闸是消费者改动，不是 schema 改动。
- **不新增 hook 事件。** hook surface 需要一条今天还不存在的「子进程→会话」事件
  通道。持久化记录加一个内置消费者就是全部机制，以后可以在同一条记录上再叠一个
  hook 事件，而无需搬动生产者。

## 约束与风险

- 走子会话那条路时，父会话必须在事件被消费时仍驻留。内部事件在回合中途（Step 8）
  写出，因此 watch 会在评审会话仍活跃时点火；daemon 重启后的重放可能发现它已被
  回收，此时 `launch` 失败并记日志。无父那条路没有这个约束。
- 派生的会话执行 untrusted PR 代码。它继承手工调用 `/verify-pr` 轮次的隔离姿态；
  本次改动不削弱它，也不自带沙箱。外部生产者断言的「干净」没有被独立复核——这是
  E1 的信任模型：调用者与操作者同权限，且记录里带 `reviewedBy` 可归因。
- 事件文件很小且由去重键约束，但 `pending/` 只由运行中的 daemon 排空。一个从不运行
  daemon 的工作区会按干净 head 逐个累积文件；没有消费者时这些文件是惰性的。
- 该自动化是工作区作用域、且受受信工作区闸门约束，与它旁边的 keepalive 一致。它
  绝不回退到另一个 runtime。
- `ownerRepo` 与 `host` 会被插进 daemon 执行的 prompt。生产端按平台语法校验它们
  （`isOwnerRepo`、`HOSTNAME_RE`），读取端再独立把它们约束在一个无法携带第二个
  旗标或 shell 元字符的字符集内——派生的一侧不从「写文件的那一侧」继承自己的
  边界。这样的事件被报为不可读，绝不会被派生。

## 验证计划

单元测试（与源码同目录，vitest）：

- `review/lib/review-events.test.ts` —— 谓词的三个输入及其否定态（critical > 0；
  标记缺失；标记无 `sha`；`REQUEST_CHANGES`；plan 缺失或不指向 PR）、去重键跨轮次
  的稳定性、重复产出时的原子覆盖、宿主受信位置、读取端对注入形状坐标的拒绝、
  以及「后来新增 provider 的事件仍可被读取」。
- `review/save-artifact.test.ts` —— 一轮干净 PR 评审产出一条事件；被 cap 的轮次、
  local 目标、low-effort 拒绝都不产出；产出失败不使命令失败。
- `review/verify-event.test.ts` —— 外部生产者的一轮被记录、并能被消费者的读取器
  读回；归因与会话默认值；显式 Aone host 在不联网的情况下被记为 Aone；大写 head
  归一化后收敛到同一个去重键；每一种畸形坐标都是「什么都不写」的用法错误；
  Aone origin 的 cwd 且无 `--host` 时被拒绝而不是被标成 github.com；写入失败是
  运行时错误；handler 的 stdout JSON 与退出码。
- `serve/review-verify-automation.test.ts` —— 每一道拒绝闸门；接受路径的
  write-ahead 顺序（键先于 `launch` 记录，pending 文件在其后移除）；`launch` 失败
  时键仍被记录且事件被丢弃；同一 head 的重复事件只派生一次；`stop()` 幂等并关闭
  watch。无父路径：一条不带会话的事件派生**顶层**会话（thread scope、无
  `parentSessionId`），prompt 与标题逐字正确，完全不碰 launcher，去重与其他 head
  一致，并会报出 prompt 派发被拒；未接 bridge 时同一条事件以 `no-session` 拒绝。
- `review/lib/review-settings.test.ts` —— `autoVerify` 默认开、只以布尔存活、
  设置读不出来时降级为关、且从 operator 作用域读取。
- `commands/review.test.ts` —— 子命令清单与其 `demandCommand` 枚举都包含
  `verify-event`。

手工/E2E（`.qwen/e2e-tests/review-clean-auto-verify.md`）：在 daemon 会话里对一个
干净 PR 跑真实 `/review`，产出事件并派生一个执行 `/verify-pr --publish` 的子会话；
外部 `review verify-event` 派生一个顶层会话；关掉 `review.autoVerify` 后产出事件
但不派生会话。

## 验收标准

- daemon 会话里一轮干净 PR 评审，在宿主受信 review-state 目录下恰好写出一条 pending
  事件，携带 platform、host、owner/repo、number、被评审 head sha、round 与裁决计数。
- daemon 派生一个子会话，其 prompt 为
  `/verify-pr <number> --publish --repo <owner>/<repo>`，且事后 pending 文件已消失。
- 任何外部生产者跑
  `qwen review verify-event --pr <n> --repo <o/r> --head <sha> --reviewed-by <agent>`
  写出同一条记录，daemon 随之派生一个 prompt 相同的**顶层**会话——不需要
  qwen-code 会话，也不要求写入时 daemon 正在运行。
- 带 Critical 的轮次、fail-closed 被 cap 的轮次、local/file 目标、非 github.com
  平台，都不派生。
- 同一 head 的两轮干净评审只派生一次验证，无论是哪个生产者写的。
- User 设置里的 `review.autoVerify: false` 停止派生但不停止事件产出；工作区作用域
  里无论 true 还是 false 都被忽略。
- `npm run build`、`npm run typecheck` 与所改包的单元测试通过。

## 后续工作

- **E2 —— 观测 qwen-code 没做过的评审。** 生产者中立的入口仍然需要对方主动调用。
  自动化的一面是平台上已发布的评审——任何评审者都会留下它：给
  `autofix-pr snapshot --gate` 探针加一个 `verify` 转移，产出同一条事件。两条约束
  已经明确：
  - 探针**每个 PR 只有一个 cursor**，而 `verify-pr-watch-gate.mjs` 拒绝共存，因为
    第二个消费者会饿死第一个。E2 必须是既有 gate 转发的一个新 action，或者一个
    独立的 cursor 命名空间——绝不能在同一 cursor 上再挂一个 watcher。
  - 干净判定必须读**当前**批准态，而不是某条评审正文：新 head 会把先前的 APPROVE
    降为 DISMISSED，而正文仍写着「Approving」。已定口径：
    `reviewDecision === 'APPROVED'` **且**没有未决、未过期的阻塞线程
    （`reviewThreads` 中 `isResolved: false`、`isOutdated: false`）。探针今天不读
    `reviewDecision`，由 E2 补上。
- `/verify-pr` 的 Aone 与 GitLab 后端，然后放开消费者的平台闸门。探针今天是
  GitHub GraphQL，因此其他平台上的 E2 要走 review 的 provider 注册表。
- 给 `/verify-pr` 加 `--host` 旗标，使 GitHub Enterprise 目标可以被表达。
- 按会话解析 skill 的方式去找它（user 与 extension 作用域），而不只找工作区的项目
  副本。今天把 `verify-pr` 装在 user 作用域的操作者，会得到一条已披露的
  `skill-unavailable` 拒绝，而不是派生。
- 在同一条记录上提供一个可选 hook 事件，供想用自己消费者替代内置消费者的操作者。
