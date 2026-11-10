# 绑定投递的活跃 watch 门

[English](2026-11-09-bound-delivery-active-watch-gate.md) | [简体中文](2026-11-09-bound-delivery-active-watch-gate.zh-CN.md)

状态：提案（2026-11-09）

## 问题陈述

GitHub channel 开启 `deliverToBoundSessions` 后，每个绑定了某 PR 的 daemon
会话都会收到该 PR 的事件：通知评论、默认开启的评论监视（`prCommentWatch`，
同账号评论）、`prWatchEvents` 状态迁移，以及（配置了模板时的）role-aware
扇出。绑定由 backfill 自动铸造——任何跑过
`/review <n>` 或 `/verify-pr <n>` 的会话都会被绑上，而这两个一次性命令的会话
事后并不监视该 PR。它们持续收到自己从未要求的事件：验证会话跑完一轮后仍被
之后的每条评论和 CI 迁移唤醒；legacy 模式（未配 `boundSessionActions`）下
还会收到它不该执行的 fix 式指令。

操作者的意图：`/review` 或 `/verify-pr` 会话只有在对该 PR 持有**活跃 watch**
——它自己安装的 `/autofix-pr` watch 或 `/verify-pr <n> --watch` 常驻触发器——
时才接收绑定事件。没有 watch 的会话保持绑定（徽章与绑定关系仍在），但不再是
投递目标。

## 现状

- 绑定存于 `<chatsDir>/<sessionId>.pr.json` sidecar
  （`packages/core/src/services/session-pr-service.ts`）：条目携带
  `number`、`url`、`state?`、`role?`（`review` | `verify` | `fix`）、`source?`。
  没有 watch 标记。backfill
  （`packages/cli/src/serve/routes/session-pr-backfill.ts`）为 `/review` 铸造
  role `review`、为 `/verify-pr` 铸造 `verify`；metadata 路由显式设置的 role
  优先于 backfill。
- `GET /sessions/pr-bindings`
  （`packages/cli/src/serve/routes/session-pr-bindings.ts`）扫描每个
  trusted/primary workspace 的 sidecar，返回 `PrBindingSummary` 行；channel
  worker（`packages/cli/src/commands/channel/daemon-worker.ts` 的
  `listPrBindings`）校验后转发给适配器。
- 适配器（`packages/channels/github/src/GithubAdapter.ts`）以两种模式选目标：
  legacy 单赢家（路由 map `boundSessionByPr`，每 PR 取最近更新的跟随者）与
  role-aware 扇出（配置了 `boundSessionActions`；每个模板链匹配事件的 role
  组取一个赢家）。`resolveBoundTargets` 返回 `followed`，区分「无人绑定该 PR」
  （公共 absence 门）与「有跟随者但无 role 匹配」（私下 retire，
  `no_role_matched`）。
- 会话级 watch 以两种实体存在，目前都没有暴露给 channel：
  - `/autofix-pr` watch：制备 worktree 下的状态文件
    `.qwen/tmp/autofix-pr-<n>-state.json`，记录 owning `sessionId`、`host`、
    `owner/repo`、`prNumber`，以及 `ended` 终态标记；`stopped`（merged/closed）
    标记在独立的 gate cursor 文件里。daemon 已有纯文件列举
    `listAutofixPrWatches(cwd)` 把两者合成暴露
    （`packages/cli/src/serve/routes/autofix-pr-watches.ts`，基于
    `runStatus`）。
  - `/verify-pr <n> --watch`：绑定到会话的 durable 周期调度任务
    （`sessionMode: "current"`），其 gate 运行
    `scripts/verify-pr-watch-gate.mjs <n> --repo <owner>/<repo> --cli <qwen>`。
    gate 的 claim 文件不记录 session id，因此任务是唯一能归属到会话的实体。
    任务存于按项目隔离的 durable cron 文件，由 core 的
    `readCronTasks(projectRoot)` 读取。

## 目标

- 新增 opt-in channel 选项：role 为 `review`/`verify` 的绑定，仅当同一会话对
  同一 PR 持有活跃 watch 时才接收投递。
- 没有合格目标的事件私下退役——绝不回退公共 channel 路径（操作者决策，
  2026-11-09）。
- 不新增持久化状态：watch 信号在扫描时从 watch 流程本就写入的实体推导。

## 非目标 / 范围边界

- role `fix` 与无类型绑定不受影响。
- sidecar schema 不变；不新增 watch 开关 UI。
- PR 状态 watch 的轮询集合不变：不合格绑定仍被轮询（保留基线与终态观察），
  其事件在 drain 处经既有无候选路径退役。省掉它们的 `pulls.get` 是可能的
  后续优化，不属于本次改动。
- 评论监视（`prCommentWatch`，默认开启）经同一目标解析覆盖：其扇出消费
  `resolveBoundTargets`，所有绑定目标都不合格（或评论由它们全部发出）的
  评论走既有 `comment_watch_no_target` 日志行跳过并推进游标——私下退役，
  绝不公开回复。
- 检测是尽力而为且 fail-open（决策 D3）：它是噪音门，不是安全边界。

## 提议的改动

### 1. watch 检测（daemon，`packages/cli/src/serve`）

新 helper `routes/session-pr-watches.ts`（测试同目录）：

`collectActivePrWatches(workspaceCwd): Promise<Map<string, Set<string>>>` —
键为 `sessionId` → PR 键集合，取并集：

1. **autofix-pr watch** — `listAutofixPrWatches(workspaceCwd)`；保留 `session`
   非空、`stopped === null`、`ended === null` 的条目。覆盖 in-place watch 与
   任务活在 session-only 调度器里的 watch，并承认 takeover（状态文件的
   `sessionId` 是权威）。
2. **verify-pr watch** — `readCronTasks(workspaceCwd)`；保留
   `enabled !== false`、`recurring === true`、`sessionId` 非空、且 `gate`
   指名 `verify-pr-watch-gate.mjs` 的任务。gate 先按 shell 自身的语义分词
   （`shellWords`：单引号字面、双引号 POSIX 反斜杠转义、引号外的反斜杠转义
   与反斜杠换行续行——续行整体消除两个字符且**不启动新词**，续行的缩进
   不会 push 出空 argv 元素——以及词首 `#` 注释终止命令；词中 `#` 保持
   字面）。引号外的 glob/brace 字符（`*?[]{}`）与 `$`/反引号同属无法确定：
   shell 可能把它们展开成不同的 argv（如 `--repo acme/*`），因此 fail-open
   而非确认「无 watch」。空白切分会与真实 argv 不一致，例如
   `--state-root '/tmp/pr 16772' 42` 是一个参数后跟 PR 号，而非名为 16772
   的 PR。分词后镜像脚本自身的 `parseArgs`：`--repo`/`--cli`/`--state-root`
   消费后一个词，第一个非旗标位置参数是 PR 号（空串即 `Number('') === 0`，
   脚本会拒绝），带 `--check`/`--claim`/`--release` 的 gate 是一次性探针
   调用（安装/收尾），绝不是常驻 watch。结果为三态：`watch`（repo + PR）、
   `none`（确认非常驻 watch——不是该脚本、一次性调用、或脚本自身会拒绝的
   参数，这样的 gate 永不触发）、`unknown`（gate 指名该脚本但 argv 无法
   确定：未闭合引号、`$`/反引号展开、glob/brace 展开、shell 操作符）。
   任一 `unknown` 任务使整个 workspace 的
   答案为 `undefined`（fail-open）——无法确定的 gate 绝不能变成已知的
   「无 watch」，给可能正在被 watch 的 PR 盖上 `watching: false`。

键推导：两个来源都用 `prWatchKey(url, number)` = `repoKeyFromWebUrl(url)#number`
给 watch 建键——与绑定路由对绑定 URL 用的是同一个函数，因此 host 拼写
（非默认端口、前导 `www`、大小写）在两侧归一一致。autofix 来源用 watch 自身
的 `url`；verify-pr 来源构造 `https://github.com/<repo>/pull/<number>`
（gate 脚本不接受 host）。

失败语义：任一来源抛错时 helper 返回 `undefined`（检测不可用）；列举的
非抛错失败形态同样返回 `undefined`：`available: false`（clone 的 worktree
无法枚举——git 失败或非仓库）与 `unreadable` 非空（个别 state 文件读取失败）。
部分列举绝不能给活跃 watch 盖上 `watching: false`。路由按每次 workspace
扫描写一行日志——与既有绑定扫描诊断同形。

### 2. 绑定路由（`session-pr-bindings.ts`）

一个 workspace 的行构建完成后（sidecar 行与 live 合并行同样处理），对该
workspace 调用一次 helper。对每个 PR 条目，用
`prWatchKey(entry.url, entry.number)` 在该会话的 watch 集合里查表并置
`watching: true/false`（URL 不可解析则留缺省）。helper 返回 `undefined` 时，
该 workspace 的条目不带 `watching`（未知）。`watching` 对每个条目都计算，
不只 review/verify——策略归适配器所有。

路由的 `partial` 语义不变：watch 检测失败不使快照 partial（只降级新字段，
fail-open）。

### 3. 传输类型与 worker 校验

- `packages/channels/base/src/types.ts`：`PrBindingEntry.watching?: boolean`，
  附文档注释（缺省 = 未知；适配器必须把未知视为合格）。
- `daemon-worker.ts` 的 `listPrBindings`：仅当严格 boolean 时接受 `watching`；
  其他值丢弃该字段（不丢条目）——未知值即「未知」，丢条目会伪造缺席。核心
  字段既有的 drop+partial 规则不变。

### 4. channel 选项（`packages/channels/github`）

`requireBoundWatch?: boolean`，默认 `false`，由 `validateBoundSessionConfig`
校验：必须 boolean；要求 `deliverToBoundSessions: true`（与 `prWatchEvents`
同模式）。`src/index.ts` 描述符条目（boolean，默认 `'false'`）、Web Shell
i18n 文案（en + zh）与编辑器字段顺序。适配器在 `deliverToBoundSessions` 旁
把它解析进 `requireBoundWatch` 字段（standalone 模式随 `deliverToBoundSessions`
一并置 false）；合格性谓词 `watchGateExcludes` 读取该字段，因此门仅在两者皆真
时生效，既有部署不受影响。

### 5. 适配器过滤（`GithubAdapter.ts`）

合格性谓词（门开启时）：条目不合格当且仅当其 role 为 `review` 或 `verify`
且 `entry.watching === false`。`watching` 缺省（未知）与其他 role 均合格。

过滤放在目标解析层，绝不放在快照层——原始绑定列表必须继续列出不合格跟随者，
以保持 `followed`/absence 语义正确（决策 D4）：

- **路由 map 构建**（`refreshBoundSessions`，新扫描与 partial 保留两个循环）：
  选每 PR 赢家时跳过不合格条目。map 从此持有最近的合格赢家；
  `resolveBoundDelivery`（watch 冻结、legacy drain、恢复重解析、legacy 复核）
  无需再改即继承过滤。
- **`resolveBoundTargets`**：legacy 分支——map 无赢家时，门开启下 `followed`
  改取 `boundFollowersOf(...).length > 0`（原始存在性），使仅有不合格绑定的
  PR 读作「有跟随者、无目标」而非「未绑定」。role-aware 分支——按 role 分组
  前丢弃不合格跟随者；`followed` 保持原始计数。
- **`resolveBoundDeliveryExcluding`**（Gone 回退迭代器）：跳过不合格跟随者。
- **`revalidateBoundTarget`** role-aware 分支：在任务 role 组内选赢家前丢弃
  不合格跟随者。

「有跟随者、零合格目标」在完整新鲜快照下的私下退役出口：

- `dispatchEnvelope`：既有 `no_role_matched` retire 分支扩展到 legacy 门模式。
  role-aware 模式下 reason 保持 `no_role_matched`；legacy 门模式以新 reason
  `bound_watch_required` 退役。partial/失败扫描下该分支不触发（未扫到的跟随者
  可能合格）——无目标 claim 照旧经 absence 门推迟。
- `deliverToBoundSession` 投递时复核：legacy 评论今天复核无候选时保留冻结
  目标；门开启下 `!current` 仅在门控确实排除了目标时才私下退役
  （`bound_no_candidate`）——原始跟随者仍在且无一合格（claim 与投递之间
  停掉了 watch）。绑定被移除（无原始跟随者）则保留 legacy 冻结目标契约，
  门绝不改变其豁免的 fix/无类型会话的行为；该回退由下方 Gone 路径负责。
- Gone 回退耗尽：`siblings_still_follow` retire 分支扩展到门模式——原始列表
  仍有跟随者（那些不合格的）即私下退役，而非公共回退。
- 恢复的 legacy 背压重解析：门开启下过滤后的 map 无 delivery、但完整快照上
  原始跟随者存在时，退役（`retireBoundTask`）而不是把任务留给公共 absence
  门——与既有 role-aware「no role matched」退役对齐。

`processCommentLane` 的 mention 豁免探针消费
`resolveBoundTargets(...).targets`，无需改动：仅有不合格绑定的 PR 失去豁免，
其普通评论被 lane 丢弃而非先认领再退役——可观察结果相同（不投递、不公开回复）。

watch 事件无需新代码：检测冻结 `resolveBoundDelivery`（已过滤），两种 drain
本就无候选即退役（`watch_no_target` / `watch_no_candidate`，role-aware drain
退役）。

评论监视（`watchPrComments`）也无需新代码：它经同一个已门控的
`resolveBoundTargets` 解析目标，对原始跟随者集合（而非仅目标）查询已发评论
归属（保证 Gone 回退的排除集完整），其可投递过滤本就把无剩余目标的评论经
`comment_watch_no_target` 日志行跳过、再推进游标。门开启时，全不合格的跟随者
集合落入同一跳过——私下退役、游标推进、无公开回复。

## 关键设计决策

- **D1 — 按 role 门控，按 (会话, PR) 判定。** 用户把门限定在 `/review` 与
  `/verify-pr` 会话；role 是绑定对该来源的记录。对 PR A 的 watch 绝不让同一
  会话对 PR B 的绑定合格。
- **D2 — 推导，不持久化。** 不加 sidecar 字段、不加新写路径、没有要保持正确
  的同步：扫描读取 watch 流程本就维护的实体。装/停 watch，下一个完整快照即
  反映。
- **D3 — fail-open。** 未知 `watching`（检测失败、旧 daemon、畸形值）即合格。
  门用于降噪；降级回今天的投递比饿死一个正在 watch 的会话更安全。
- **D4 — 过滤目标，不过滤绑定。** 把不合格绑定从快照中删掉会污染
  `followed`/absence，为确实有绑定的 PR 打开不可逆的公共路径。原始列表保留
  它们；只有目标选择做过滤。
- **D5 — opt-in。** `requireBoundWatch` 默认关闭；既有部署行为字节级不变。
  要求 `deliverToBoundSessions`。
- **D6 — 轮询集合不变。** 不合格绑定保留 watch 基线与终态观察；事件在 drain
  退役。成本受 `prWatchLimit` 约束；优化轮询集合是后续工作。
- **D7 — 退役要呈现。** 每条新退役路径都写既有的 stderr 行 + channel-event
  日志行（带 reason 的 skip/retire），被门控掉的事件绝不静默。

## 受影响文件

| 文件                                                                    | 改动                        |
| ----------------------------------------------------------------------- | --------------------------- |
| `packages/cli/src/serve/routes/session-pr-watches.ts`（+ 测试）         | 新增：watch 检测            |
| `packages/cli/src/serve/routes/session-pr-bindings.ts`（+ 测试）        | 把 `watching` 接进条目      |
| `packages/cli/src/commands/channel/daemon-worker.ts`（+ 测试）          | 校验/透传 `watching`        |
| `packages/channels/base/src/types.ts`                                   | `PrBindingEntry.watching?`  |
| `packages/channels/github/src/GithubAdapter.ts`（+ 测试）               | 选项、过滤、退役路径        |
| `packages/channels/github/src/index.ts`（+ 测试）                       | 描述符 + 校验               |
| `packages/web-shell/client/i18n.tsx`                                    | en + zh 文案                |
| `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx` | 字段顺序（parity 套件覆盖） |
| `docs/design/…`（本双语文档）                                           | 设计                        |

## 风险

- **gate 解析脆弱性。** verify-pr 的 gate 字符串由模型按 skill 契约撰写；
  解析器无法确定的拼法一律 fail-open（会话继续接收事件），绝不落成确认的
  「无 watch」。token 解析接受旗标顺序变化、脚本路径带引号、续行与尾注释。
- **扫描成本。** 每次绑定轮询（默认 60s）每 workspace 一次 `git worktree list`
  （10s 超时）+ cron 文件读取。与 Web Shell watches 页面按需使用的机制相同。
- **partial 快照下 `watching` 陈旧。** 保留行沿用最后已知值；永久 partial
  期间安装的 watch 要到完整快照才被看见。与既有 fail-closed 保留模型一致；
  自愈。
- **Visuals。** 新编辑器字段可能移动 channel-editor 截图；diff 属实则更新
  visuals 基线。

## 验证计划

- 单元：检测（两个来源、终态标记、禁用任务、畸形 gate、失败 → undefined）；
  路由接线（已知/未知、live 合并行）；worker 校验（非 boolean 只丢字段）；
  适配器——legacy 赢家跳过、role-aware 组跳过、Gone 回退跳过、复核退役、
  dispatch 退役（两种模式）、恢复退役、partial 快照推迟、关门字节兼容、
  未知 `watching` 合格。
- E2E（测试计划在 `.qwen/e2e-tests/`）：daemon + github channel 对测试仓库；
  一次性 verify 会话 vs `--watch` 会话；评论与 `ci_failure`/`head_change`
  事件；断言投递/退役日志行，且无公开回复。

## 验收标准

1. 门关闭（默认）：所有既有测试原样通过；投递行为字节级一致。
2. 门开启：`watching === false` 的 role `review`/`verify` 绑定在两种模式、
   任何路径（新派发、Gone 回退、恢复、watch drain、评论监视、复核）下都不是
   投递目标。
3. 门开启：同一会话对该 PR 有活跃 watch（`watching === true`）时照旧接收。
4. 门开启：PR 有跟随者但无合格目标的事件私下退役并留日志行；绝不为它产生
   公开回复。
5. `fix`/无类型绑定与未知 `watching` 不受影响。
6. 检测失败降级回今天的行为（fail-open）并写诊断行；不使快照 partial。

## 开放问题

无阻塞项。后续（非本次改动）：在活跃轮询集合中跳过不合格绑定，省掉它们的
`pulls.get` 预算。
