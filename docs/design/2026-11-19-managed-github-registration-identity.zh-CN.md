# 托管 GitHub 账本注册身份键控

- **状态：** 已合入 — PR #17775，squash `ceb421295f`（2026-11-20）。延后后续项跟踪于 #17769。
- **日期：** 2026-11-19
- **范围：** `packages/channels/github`（状态存储 + 适配器）、`channel-base` 契约注释、测试、PR-watch E2E rig
- **相关：** WeCom 适配器的 P1-D/E 修复（PR #17441）与 DingTalk 键控（PR #17742）；`channel-base` 的共享 `destinationKey` 契约；[英文版](2026-11-19-managed-github-registration-identity.md)
- **合入时验证：** github 套件 1090 绿；CI 钉住的 PR-watch E2E rig（`npm run test:e2e:managed-pr-watch`）全绿，含 P3 同目的地崩溃重放；rig CI 钉住套件 96 绿；`tsc --build` / ESLint / Prettier 干净；承重变异见证均被杀。episode 携带为非破坏性（绝不驱逐加载账本自己的计数、被携带值以 prs 基线下限、仅有空位才加入、溢出打日志）。

## 问题

托管 GitHub 状态存储仅按配置条目键控其单一账本文件——渠道 name + 端点 `baseUrl`，按工作区范围。一条在一个控制面注册（租户 A）下暂存为 pending 认领的评论，因此会在同一配置条目改对另一注册（租户 B，或同租户内不同 actor/workspace/cwd-relative）重启时被加载。持久化事件携带完整文本而无租户身份；`resubmitPending()` 经 HTTP 客户端转发它，客户端供给新注册的租户头与渠道 id，于是已被 A 准入但应答丢失的事件可能在 B 下创建一个输入。这正是 WeCom 适配器在 P1-E、DingTalk 适配器在 #17742 关闭的跨所有权重放。

## 现状

`ManagedGithubStateStore(name, cwd, baseUrl)` 把 `name\0baseUrl` 哈希成按条目的目录 `~/.qwen/channels/<workspace-scope>/github-<hash>`，并在其下存单一 `managed-state.json`。目录锁（`proper-lockfile`）串行化该 name + endpoint 的并发托管实例。适配器用三个参数构造存储，从不传控制面目的地。`load()` 把 I/O 失败与内容损坏折叠成一个不点名文件的错误。

共享 `ManagedChannelControlPlane.destinationKey` 已绑定完整注册身份——base URL + tenant + channel + actor + workspace + cwd-relative——且 `HttpManagedChannelControlPlane`（唯一生产实现）在每条真实路径都填充它。base 接口注释点名 GitHub 存储为尚未绑定它的兄弟。

## 提议改动

逐字镜像 WeCom / DingTalk 形状：

- **存储构造函数**加第四参 `identityKey = ''`。锁目录仍按配置条目（`name\0baseUrl`）按工作区范围键控——不按目的地——故同一 name + endpoint 的两个实例即便目标控制面目的地不同也争同一把连接锁。目录下的账本文件另按 `ledgerKey = sha256(identityKey).slice(0, 16)`（前 16 个十六进制字符，与存储一致）键控：`managed-state-<ledgerKey>.json`。一个注册下暂存的 pending 账本绝不会被同一条目的另一注册加载或重放。
- **适配器构造函数**传 `options.controlPlane.destinationKey ?? ''` 作第四参。`?? ''` 回退仅用于省略该可选字段的非持久化测试替身；生产 HTTP 客户端恒供给它。
- **`load()`** 拆分 read / parse / validate 三臂，点名 `this.file`，并以 `{ cause }` 保留 fs 错误，使面对多个 `<hash>.json` 账本的操作者能判断哪个注册不可读、哪个只是格式无效。

锁刻意保持按条目：按目的地的锁会让一个配置 name + endpoint 的两个注册各拿一把锁并发运行，重复入站处理。账本键控在不收窄锁的前提下加跨注册隔离。

`channel-base` 的共享 `destinationKey` 注释更新为点名 WeCom、DingTalk **与 GitHub** 为绑定注册身份的适配器，留 email（独立变体）为剩余后续。

## 升级后果与诊断

账本文件从 `managed-state.json` 改名为 `managed-state-<ledgerKey>.json`，**不接管**：升级后第一次重启在全新的身份键控账本上启动。一条已暂存（已持久化）但尚未准入的认领被滞留——控制面从未见过它（只有 `submitInbound` 使认领可见），故只有本客户端自己的账本能重驱动它，而新账本不含它。与 DingTalk 的流不同，GitHub 不向提供方 ack 帧；丢失来自通知窗口：持有认领的线程从不标已读并冻结水位，但全新账本的 cursor 为 null，故首次轮询的 `since` 是 connect 时刻，旧通知不再被列出。同一次重置还丢掉 cursor（通知水位 + 已派发评论环）与未回执的出站段。这是 WeCom / DingTalk 设计记录的刻意滞留取舍：接管旧账本会把一个注册的 pending 重放进另一注册，正是键控要防的跨所有权风险。唯一例外是持久的按 PR `watch.episodes` 计数表，按条目作用域携带进加载到的任何账本——全新账本，或回滚后再升级时已存在的键控账本。`entryWatchEpisodes()` 对条目目录内每份账本（存活旧账本、各注册的身份键控账本、以及 `.stranded-*` 归档）逐键取 `Math.max` 合并计数，净化为 >= 1 的安全整数；仅存于 `watch.prs` 基线的计数（其水位已被存活上限驱逐）也一并携带。携带来源本身不裁剪——适配器以非破坏方式把它并入加载账本，由后者承担校验器的 1024 上限（在来源处裁剪会在适配器安置之前就丢弃可恢复的计数）。读取归档正是携带能在首次启动改名后存活的原因：注册 A 取走计数并归档旧账本，注册 B 仍恢复它们，而非从 0 重启、重新推导已被准入的 input id。准入台账是永久的，重启计数会静默去重一次真正的升级后复发；计数单调且 input id 已绑定 tenant/channel，故携带只会偏向新 id。无法读取的计数来源被跳过——绝不导致启动失败——但其路径会被返回并打日志，使操作者知道携带可能不完整，而非静默丢失。携带是**非破坏性**的：`persist()` 会把该 map 写回加载账本，故绝不驱逐加载注册自己的计数（否则那次丢失即永久）；只抬升已有计数、并在有空位时才加入被携带计数，且每个都以其 `watch.prs` 基线为下限——种子是 `episodes ?? prs.episode ?? 0`，水位会遮蔽基线，陈旧归档绝不能把有效种子拉低到已准入的 id。按排序遍历，结果与目录枚举顺序无关。到达硬上限时，溢出的被携带计数是**有界且接受**的取舍（与存活水位驱逐相同）：其来源文件持久存在、下次启动复读，但本次启动不承诺给它们空位。`watch.prs` 静默重基线，其排队迁移**不**被接管——把一个注册检测到的事件在另一注册下注入正是键控要防的跨所有权重放——故它们是被滞留的工作，由通知点名（见下）。「fresh window」丢失子句仅在加载的键控账本自身无水位时输出——回滚后再升级时键控 cursor 从自身水位重列，此时声称跳过窗口会谎报不存在的丢失。

为使丢弃显式而非静默，`connect()` 探测同目录的 `managed-state.json`（`strandedLegacyLedger()`），打一行日志指明该路径及其 pending/outbound 条数，但不接管它。pending 计数并入旧 `watch.prs` 队列（`watchPending`，即检测到但未投递队列非空的 PR 条目数）：这些排队的 PR-watch 迁移也是被滞留的工作，故仅持有一条排队迁移的旧账本绝不能渲染成静默的「0 pending」，并以专门子句点名它们未被接管。该子句按每个被滞留 PR 由加载的基线（`watchPendingKeys`）决定，而非仅看窗口：有加载 `watch.prs` 基线的 PR 在其边复发时可能以新 episode 重新推导，无基线的 PR 被丢弃（既不重放也不重新推导）；混合队列分别点名两个子集，而非读成整体丢失或整体可重新推导。重新检测以边**复发**为条件——已越过该边的基线不会再次触发它，故仅凭基线存在绝不承诺重新推导。全新账本，或「有 cursor 但对被滞留 PR 无基线」的回滚后再升级（该 PR 仅在回滚窗口内被绑定，或先前运行从未完成 watch pass），走丢弃臂：此时首次观测按设计检测不到任何边、只记录基线，故承诺重新检测会就永不到来的工作向操作者告警。探测刻意**不**以身份键控账本缺失为门：回滚到升级前版本可能在键控账本已存在后又向 `managed-state.json` 暂存新认领，这些认领仍须被报告，而非无声消失。记录带 `readable` 标志：内容无法读取或解析的旧账本——或虽能解析但不是账本形状（`{}`、`[]`、`null`、或缺 pending/outbound 数组的对象）——以 `unknown` 计数加一句「其所含任何已暂存认领均被滞留」的明确警告报告，绝不渲染成静默的空账本（可解析的非账本是一份无法识别的文件，而非无丢失的 0/0）。对可读旧账本，入站与出站后果分别点名——仅当 `pending > 0` 才输出入句子句，仅当 `outbound > 0` 才输出出站子句——故仅出站滞留不会谎报入站评论丢失。出站计数只含**投递状态未知**的段：确定性回执（accepted/rejected）证明结果，但无回执——或回执 outcome 为 `unknown`——都不证明，故两者都计入未知状态子句（`{outcome:'unknown'}` 的回执不是已知结果）。即便 0/0，若旧账本带非空通知水位，仍单独点名「水位之后、本次启动之前的未读通知从未被列出，故其间收到的 mention 未被准入」的离线积压丢失——这是独立子句，不放宽 pending 门；真正无水位的 0/0 才无丢失告警。损坏旧账本绝不抛出，故受损旧账本绝不会把升级变成硬性启动失败。归档推迟到启动成功之后：在客户端身份解析、注册与 ownership 复查完成后，`archiveStrandedLegacy()` 把旧账本重命名为 `managed-state.json.stranded-<id>`——绝不删除，使被滞留认领仍可查——并打第二行日志点名归档路径，使循通知而来的操作者能找到认领。首次启动失败则旧账本原样保留，使回滚到升级前版本仍能恢复它（提示仅在重试时重复）；回滚若再暂存新的 `managed-state.json`，下次升级会再次探测到。反向亦有界：成功升级后回滚到升级前版本会在全新账本上启动，因该版本只加载 `managed-state.json` 而新版本从不写它；认领并未销毁（身份键控账本保留、后续再升级重新加载），但回滚期间升级前版本不给任何信号表明先前注册正持有已暂存未准入的评论。

## 涉及文件

- `packages/channels/base/src/managed-channel.ts` —— `destinationKey` 注释：点名 WeCom、DingTalk 与 GitHub 为绑定者；email 仍为后续。
- `packages/channels/github/src/managed-state.ts` —— 存储构造函数：条目键控目录 + 身份键控账本文件；`load()` 拆臂；`strandedLegacyLedger()`（pending/outbound/`watchPending`/水位/readable）+ `archiveStrandedLegacy()` + `entryWatchEpisodes()`（跨旧账本、键控账本与归档的条目作用域 `Math.max` 合并）。
- `packages/channels/github/src/managed-github-adapter.ts` —— 传 `destinationKey` 给存储；`connect()` 滞留通知（pending 计数并入 `watchPending`，附排队迁移丢失子句）+ 把条目作用域 episode 合并进加载态 + 延迟归档 + 归档路径日志。
- `packages/channels/github/src/managed-state.test.ts` —— 更新文件路径期望；加键控、隔离、滞留与损坏旧账本见证；`entryWatchEpisodes()` 净化（含非安全整数）、归档存活、兄弟 `Math.max` 合并（两种读取顺序）、不裁剪的携带来源、仅存 prs 基线的携带、越过不可读来源继续的见证；`watchPending` 计数 + unknown 回执出站见证。
- `packages/channels/github/src/managed-github-adapter.test.ts` —— `fakeControlPlane` 加 `destinationKey`；加目的地/工作区隔离、共享锁与滞留诊断见证；双注册 episode 恢复（episode 6 而非被去重的 1）、回滚后再升级 episode 合并、排队 PR-watch 通知计数见证，以及非破坏性携带见证（上限处自己的计数保留、有空位才加入被携带计数、基线下限、溢出打日志）。
- `scripts/run-managed-pr-watch-e2e.mjs` —— `stateFile()` 发现身份键控存活账本（精确 16 进制匹配、旧账本回退）；场景 P3 的替换控制面复用 cp1 端口，使崩溃重启是同一目的地（账本文件按目的地键控），保住幂等重驱动可达。
- `docs/design/2026-11-16-managed-channel-github-adapter.md`（及中文版）—— 「State and ownership」更新为条目键控目录 + `managed-state-<sha256(destinationKey)[:16]>.json`，注明 `managed-state.json` 为升级前文件、归档为 `.stranded-<uuid>`，并链接本设计文档。
- `docs/design/2026-11-18-managed-dingtalk-registration-identity.md`（及中文版）—— 修正「GitHub 仅按 name+endpoint 键控、为剩余后续」的过时表述。
- 本设计文档及其中文版。

## 范围边界

- GitHub 通知轮询、准入/出站纪律、标已读/窗口冻结机制不变。除账本文件名与升级诊断外，唯一的行为新增是条目作用域 episode 携带：`connect()` 以**非破坏**方式把条目的持久 PR-watch 计数并入加载的 `watch.episodes`——绝不驱逐加载账本自己的计数、绝不把计数降到其 `watch.prs` 基线之下、仅在 1024 上限内有空位时才加入被携带计数（溢出为有界且接受，与存活水位驱逐同一取舍）。PR-watch 检测/注入逻辑本身不变。
- `disconnect()` 的行注销门控是独立问题，本次不动。
- 滞留诊断仅覆盖升级前的 `managed-state.json`。升级后若 `destinationKey` 变更，前一注册的身份键控账本（`managed-state-<hash>.json`）被废弃而无提示——这与 DingTalk 兄弟相同，已并入 #17769 第 1 项跟踪，不在本次实现；故本诊断不应被读作覆盖一切滞留情形。
- 无控制面（Java）改动；无 `channel-base` 契约/API 改动——仅更新 `destinationKey` 注释。
- email 存储不在范围（独立变体）；它是剩余后续。

## 开放问题

- 无：形状由 WeCom P1-D/E 与 DingTalk #17742 先例及共享 `destinationKey` 契约定案。
