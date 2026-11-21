# verify-pr 的 watch 模式

[English](verify-pr-watch.md) | [简体中文](verify-pr-watch.zh-CN.md)

Status: implementing with this change.

## 问题

维护者跑完一轮 `/verify-pr <n> --publish` 后，得自己盯着有没有新提交，再手动开下一轮。仓库其实已经把自动触发的两半都做出来了——一个只打印"自上次以来的变化"的 PR 探针，和一个 gate 跑在模型之外的定时任务——但没有任何东西把它们接到验证轮次上，于是每个维护者都要自己重新拼一遍 cron，并重新踩一遍它的坑。

## 现状

- `qwen autofix-pr snapshot <n> --gate --repo <owner>/<repo>`（PR #15057）带游标，只输出新的转变：head 变了给 `head_moved_externally`、每个 attempt 一次的 `ci_failed`、他人评论、merged/closed。**静默表示没变化。**
- `cron_create` 接受 `gate`（PR #15211）：调度器在每次 fire 前于**模型之外**跑这段 shell。无输出则整次 fire 跳过；有输出则把 JSON 作为数据投给会话。gate 必须 recurring，current-session 任务必须 durable。
- 这两半都不认识 `/verify-pr`；skill 里也从没提过 watch，于是维护者要一个 watch 时只能临时拼 cron：gate 可能指向一个没有探针的二进制，prompt 可能在重启后重验同一个 head，任务在 PR 合并后还活着。

## 方案

给 skill 加 `--watch` 模式。它是**组合**而非新管线：探针仍是 CLI 命令，触发仍是带 gate 的定时任务。

- `/verify-pr <n> --watch` 为该 PR 建一个 recurring gated 任务，随后本身仍按普通轮次执行。被触发的轮次默认按 `--publish` 走（维护者要的是长期观察，不是只发一条评论）。
- 任务形态：cron 每 2 分钟；gate = `node <clone>/scripts/verify-pr-watch-gate.mjs <n> --repo <owner>/<repo> --cli <绝对路径 qwen>`；`recurring: true`、`durable: true`、`sessionMode: "current"`。包装脚本在派发探针前先验证已解析根确实为 git worktree（孤立非 worktree 副本或非 git 的显式 `--state-root` 直接以 exit 2 拒绝而不派发探针，绝不回退 `cwd`），将探针子进程的 `cwd` 对齐至该 worktree 根（保证游标、claim 与状态文件落在同一仓库树），只转发 `resync`（head 移动）与 `stop`，并在输出唤醒模型前于状态锁内把 `resync` 的 `headSha` 预记入 `deferredHeads`——将游标推进至 `--start` 的静默丢失窗口收窄到探针写游标至预记录这一跳（`deliverGateOutput` 本身在遇到锁竞争、repo 不匹配或状态损坏时仍保持 fail-open 告警不吞事件）；评论或 CI 失败是 `action: "fix"`，会被丢弃——调度器只要看到非空输出就开一轮，prompt 无法"取消"已经开始的那一轮。
- prompt 消费包装转发的输出：`head_moved_externally` → 对该 sha 开一轮；`stop`（merged/closed）→ 删除任务并停止。
- 包装脚本的 `--check` 在 `.qwen/tmp` 已存在 `autofix-pr-<n>-gate.json` 或 `autofix-pr-<n>-state.json` 时拒绝安装：一个游标只服务一个消费者，第二个 watch 会抢走第一个需要的 head 移动与 `stop`。
- 去重写在状态文件（`.qwen/tmp/verify-pr-watch-<n>.json`），自 PR #17185 起由 `scripts/verify-pr-watch-state.mjs`（`--start` / `--complete` / `--release`，后续 #17371 跟进新增 `--restart`）接管——轮次不再手写 JSON：PR #16866 的连续两个轮次跳过了手写完成写入，让文件落后了两个 head。文件保存三个列表 `verifiedHeads`、`inFlightHeads` 与 `deferredHeads`，每项自带 head、轮次、产物目录与时间戳；deferred 项与在飞标记还带单调递增的 `seq` 与重试计数（见下）。顶层 `verifiedHead`/`previousHead` 是最近完成记录的兼容视图。已验 head **按列表去重**：任何已验过的 sha 的重复 fire 都被拒绝，不只是最近一个——绑定投递设计正是用它对重投递的 head-change 事件去重。去重**仍花掉该轮的模型 turn**——它发生在 `--start` 内部，此时调度器已经投递了 fire——但该 turn 不做任何验证工作：helper 拒绝该 head，轮次即停。watch 省的是轮次，不是 turn。**同一 PR 同时只跑一轮**：任何轮次在飞时，另一个 head 的 fire 被拒绝——并**记为 deferred**，而不是丢弃。探针游标在发出转变的同一次调用里就前进到新 head，所以不会有第二次事件；deferred 列表就是这个 head 唯一的投递。`--complete` 与 `--release` 都打印 deferred heads，watch prompt 把其中最新的一个作为下一轮启动。推送顺序由单调 `seq` 表达，而非写入时钟：真正新 head 的 start 与每次首次 deferral 消耗下一个序号（高水位持久化在状态里，已完成轮次的 seq 绝不复用）；回答已 deferred head 的 start 保留该条目的 `seq`（释放后的恢复重启同样保留），使其后更新的推送不被取代。列表按 `seq` 排序（队尾是最新推送），一次 start 会取代所有 `seq` 更小的项——无论被启动的 head 自己是否曾被 deferred：事件按推送顺序到达，更旧的 deferred head 只会把整轮花在一个已被启动 head 包含的提交上。没有 `seq` 的遗留项排在最前，绝不被取代，且在重投递、启动与重入 deferred 时保持无 seq——给它最高 seq 会把旧 head 当成最新推送。重投递原位更新条目并**保留原 `seq`**——被重投递的旧 head 不能压过更新的推送。在飞 head 自身的重投递直接跳过：在跑的轮次会回答它。本地配方的克隆、base 副本、代理文件与容器名都按 PR 划分，重叠轮次会互相踩踏；CI 车道用按 PR 的 concurrency group 同样串行化。每次读-改-写都持有状态文件旁的排他锁文件，两个并发调用不会各自基于同一旧文件构造状态而互抹条目。锁带归属令牌，只由创建者释放——锁被手动删除又被他人重建时，原持有者的清理不会删掉新持有者的锁；被杀调用留下的 `.lock` 手动删除，绝不按时间戳回收。状态根从脚本自身所在克隆（其主 worktree）解析，而非调用方 cwd——会话目录是 PR clone 的轮次也写可信克隆的状态；`--state-root` 可覆盖，且必须是绝对路径。默认根若不被 git 承认为仓库——用 `rev-parse --git-dir` 验证，而非 stat `.git` 条目：bare 主 worktree 是合法根，git 本身失败的检出则绝不能通过；容器配方的 `/trusted-scripts` 挂载会解析成 `/`——直接拒绝（exit 2），不写宿主机永远读不到的影子状态；显式 `--state-root` 接受任意目录。**每个动词**都拒绝与已记录仓库不同的 `--repo`——PR 号只在仓库内唯一——一旦记录了仓库，省略 `--repo` 不会解除该守卫；空 `--repo` 是 usage 错误。`--complete` 必须重复 `--start` 的轮次：只移除自己**那一轮**的 in-flight 项（按 head **加轮次**匹配）并更新自己的已验项。轮次与在飞标记不符的完成被拒绝；早于已回答该 head 的轮次的完成按陈旧拒绝——两者都不会搁浅真实标记，也不会覆盖更新的判定与评论 id。完成必须有在飞标记或既有判定：deferred 条目不是登记——deferred head 是因另一轮在飞而被拒绝的，必须先 start（清掉其条目）才能完成，否则会把一个没有任何轮次审过的提交永久去重。重放的 inconclusive 完成（标记已释放）同样在此拒绝，而不是计第二次重试。`inconclusive` 释放标记但不把 head 记为已验，并**按原 `seq` 把该 head 重新记入 deferred**，使完成输出再次点名它——start 调用已消耗了它唯一的事件——且重入 deferred 的 head 不会压过它之后推送的 head。重入 deferred 计数重试：watch prompt 重试一次，第二次 inconclusive 使该 head 终态——输出把它点名为"重复 inconclusive 后未覆盖"，而非等待轮次，prompt 记入 _Not covered_，不循环。更新的推送会像取代任何更旧 deferral 一样取代终态项：新轮次覆盖该提交。已保有更早判定的 head 不再重入 deferred：它保留该判定与去重。_另一个_ head 的晚到完成只改变顶层视图，不抹掉任何验证。损坏的状态体被拒绝（exit 1），绝不从空列表静默重写；拒绝覆盖不可解析 JSON、非对象、数组，以及迁移梯无法消费的良构对象——守卫从梯实际消费的内容推导。当无可消费的承载条目时，`*Heads` 键持裸字符串、或无遗留标记的空列表都 fail closed，而非被接纳后抹掉（遗留 `inFlight`/`inFlightHead` 仅按非空字符串 head 计）。独立地，一个存在但持非数组值的 `*Heads` 键即使整数 `seqCounter` 已接纳该文件也被拒，使该标记不会在下一次 `--start` 被抹掉（R6-1）；空列表是合法的 resting 形状，经 `seqCounter` 仍被接纳。早于列表/seqCounter 格式的遗留 resting 正文——只含身份键与前列单标记 head 键，全持 null/空/false——按无状态接纳，因为梯把它消费为 resting，拒绝它会让一个状态不含去重历史的 PR 再也无法开轮（R7-1）；该分支限定于遗留单标记键，故无承载条目的空 `*Heads` 列表仍被拒。身份键加一个拼错（未知）的 head 标记同样不会被读作「无状态」。裸 `inFlightHead` 即使在 resting 的空 `inFlightHeads: []` 旁也被消费，阻挡在该 head 上开第二轮。拒绝消息点名该条件（无梯可消费的承载状态条目）并警示先检查再移除，因为移除会丢弃已验/deferred 去重历史。列表本身是惰性校验的——每个列表在读取时过滤，没有可用 head 的项被丢弃——所以畸形列表会静默降级去重，而不是被拒绝。`--start` **先写 sha 再开轮次**，中途死掉的轮次不会重放同一个 head。`--start` 之后死掉的轮次可用 `--restart --head <oid> [--from-round <r>] --round <r+1>` 在单次锁内原子替换在飞标记（完整保留其他 deferred 条目——含在飞期间因 force-push 回退而按原低 seq 重投递的提交——以及其他 `retiredSeqs` 墓碑，且拒绝 `--round <= entry.round`），也可用 `--release --head <oid>` 恢复（head 必填）：只移除具名 head 的 in-flight 项、不记录判定、点名 deferred heads，无此项的 head 会被拒绝——完全没有标记时同样拒绝，指向错误状态根的 release 不能读作成功。提供 `--round` 时必须与标记的轮次一致：对死轮次的重试恢复不能删掉重启同一 head 的新轮次的活标记。同一 PR 只跑一轮时，阻塞标记可能属于另一个 head：恢复要释放拒绝消息点名的那个 head。这与 gate 对死锁声明的恢复（及 `--release --reset-cursor` 先删游标再释放声明、汇报末次 `headSha`、遇 `autofix-pr` 状态时以 exit 3 拒绝并提示调用方改用普通 `--release` 的清理流程，以及 gate 全部动词与探针子进程 `cwd` 统一按脚本自身克隆主 worktree 解析状态根、要求 `--state-root` 为绝对路径、非 worktree 下对 `--check`/`--release` 与探针 tick 退出 2 而 `--check`/`--release` 显式传入任意绝对目录时仍保留接受）同形。

## 设计决策

1. **做在 skill 里，不新增 CLI。** 探针与 gate 都已存在，缺的是两者之间的约定，而这份约定就是 agent 要遵守的 prose。新增命令只会重复它无法拥有的调度那一半。
2. **gate 用绝对路径。** gate 在新 shell 里跑，而 `PATH` 上的 `qwen` 可能早于探针。skill 要求先用 `which qwen` 取路径并确认 `autofix-pr snapshot --help` 能跑；没有该能力的二进制意味着任务永远不会触发，此时必须拒绝而不是排一个坏 gate。
3. **安静时零模型 turn。** gate 静默即跳过本次 fire，这正是重点：每次 tick 只花一次 `gh api`，110 分钟的轮次只在 head 真的变了时发生。
4. **`merged`/`closed` 时停。** 活得比 PR 久的 watch 会一直探一个死端点，还可能白唤醒模型；`stop` 事件删除任务。
5. **过滤做在包装里，不做在 prompt 里。** gate 的输出决定是否开一轮；等到 prompt 读到它，轮次已经开始。所以 `scripts/verify-pr-watch-gate.mjs` 是可测试的代码，skill 指向它而不是裸探针。
6. **共存直接拒绝，不假装多路复用。** 探针每个 PR 只有一个游标，而 `autofix-pr prepare` 过的 watch 还会通过 `knownHeads` 抑制 head。要"验证自有状态"需要探针提供当前不存在的开关，因此 watch 直接拒绝：明确说"不支持共存"，好过两个 watcher 静默互相饿死。只读检查本身有竞态——两个会话可以在任何探针跑之前都通过——所以安装时用 `wx` 原子地写下 `.qwen/tmp/verify-pr-watch-<n>.owner.json`，停止或建任务失败时释放。已存在的 claim **绝不自动抢占**：用时间戳判定过期本身就是同一类竞态，死掉的安装要用 `--release` 显式释放。

## 范围边界

- 不改 GitHub Actions：CI 的 verify lane 仍然由评论触发。
- 不做 webhook：不订阅仓库事件，不引入转发进程。
- 不新增 daemon 路由或设置项，`cron_*` 与探针按现状使用。
- 仓库级观察（`qwen review watch-repo`）作为"盯所有 open PR"的方式写进文档，但 `--watch` 本身仍是**按 PR**：验证轮次天然按 PR。

## 影响文件

- `.qwen/skills/verify-pr/SKILL.md` —— `--watch` 的契约与护栏。
- `scripts/verify-pr-watch-gate.mjs` —— gate 包装：只转发 `resync` 与 `stop`，唤醒前先将 `resync` head 预记入 `deferredHeads`，支持 `--release --reset-cursor` 清理游标与声明，并在别的消费者已占用探针状态时拒绝安装。
- `scripts/verify-pr-watch-state.mjs` —— 自 PR #17185 起状态文件的持有者：按 head 的 `verifiedHeads`/`inFlightHeads`/`deferredHeads` 列表、原子写、UTC 时间戳、gate 预投递登记，以及 `--start` / `--complete` / `--release` / `--restart` 契约。
- `scripts/tests/verify-pr-watch-state.test.js` —— 去重、完成、释放与迁移用例，含并发 head 见证。
- `scripts/tests/verify-pr-watch-gate.test.js` —— 过滤的几种结果与共存检查。
- `scripts/tests/qwen-triage-workflow.test.js` —— 钉住包装命令、过滤、归属检查与二进制能力拒绝。
- `docs/design/verify-pr-watch.md` + `.zh-CN.md` —— 本文档。
- `.qwen/e2e-tests/verify-pr-watch.md` —— 测试计划与结果。

## 风险

- watch 会活得比创建它的会话更久（durable），所以状态文件与 `stop` 规则就是防止它变成僵尸的东西。
- gate 要跑 `gh` 且必须已认证；未认证的 runner 会让 gate 失败，调度器按 streak 报一次。skill 要求排任务前先确认 `gh auth status`。
- 每次 fire 花一次探针；2 分钟节奏约 720 次/天/PR，远在 API 预算内但并非免费——skill 明说这个代价，而不是藏起来。

## 验证计划

- 真实 PR 上的探针行为：不变时静默、head 变化后输出 `head_moved_externally`、再跑静默。
- 有能力的构建上的任务创建：`cron_create` 接受该 gate、拒绝 one-shot、拒绝超过 2048 字符的 gate。
- 降级：没有 `autofix-pr` 的二进制必须让 skill 拒绝并说明升级什么。
- stop 规则：merged 的 PR 产出 `stop`，任务被删除。

## 验收标准

- `/verify-pr <n> --watch` 产生的任务在 PR 安静时 gate 无输出，head 变化时输出一行 JSON。
- 同一 sha 的第二次 fire 不产生第二轮。
- 轮次在飞时推送的 head 被拒绝、记为 deferred，并由在跑轮次的 `--complete` 输出点名；启动被点名的最新 head 即可验证它，无需手动探针或第二次事件。
- `inconclusive` 完成后 head 仍可按原推送顺序位置启动；第二次 inconclusive 使其终态，点名为未覆盖而非等待轮次。对无标记 head 的 release 被拒绝，而非静默成功。
- `merged`/`closed` 后任务被移除，或可用 `cron_delete` 手动停止。
- 探针或 `gh` 不可用时什么都不排。
