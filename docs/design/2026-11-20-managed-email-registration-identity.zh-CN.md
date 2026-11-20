# 托管 email 账本注册身份键控

- **状态：** 提议中
- **日期：** 2026-11-20
- **范围：** `packages/channels/email`（托管状态存储 + 适配器）、测试
- **相关：** WeCom P1-D/E 修复（PR #17441）、DingTalk 键控（PR #17742）、GitHub 键控（PR #17775）；`channel-base` 的共享 `destinationKey` 契约；[英文版](2026-11-20-managed-email-registration-identity.md)

## 问题

托管 email 状态存储在邮箱目录里保留单一账本文件 `managed-state.json`，仅按配置邮箱（name + IMAP host/port/user/folder/address）键控。一条在一个控制面注册（租户 A）下暂存的认领，因此会在同一配置邮箱改对另一注册（租户 B，或同租户内不同 actor/workspace/cwd-relative）重启时被加载。持久化 pending 事件携带 UID 与事件文本而无租户身份；`resubmitPending()` 经 HTTP 客户端转发它，客户端供给新注册的租户头与渠道 id，于是已被 A 准入但应答丢失的事件可能在 B 下创建一个输入。这正是 WeCom 适配器在 P1-E、DingTalk / GitHub 适配器在 #17742 / #17775 关闭的跨所有权重放。

## 现状

`ManagedEmailStateStore(name, cwd, settings)` 复用 Legacy `EmailStateStore` 目录（`email-<digest(邮箱)>`），使锁按邮箱保持单一所有者（托管或 Legacy），并在其下写 `managed-state.json`。`load()` 在 ENOENT 时返回 `undefined`，否则抛单一opaque「unreadable or invalid」错误。无升级诊断：账本改名后，旁边遗留的升级前 `managed-state.json` 会被静默忽略。

## 设计

精确镜像 WeCom / DingTalk / GitHub 形状，并带 email 特有的锁与游标语义：

- **存储构造函数**加第四参 `identityKey = ''`。锁目录**不变**——仍是 Legacy 邮箱目录（`email-<digest(邮箱)>`），故锁仍按邮箱保持单一所有者（托管或 Legacy）；身份键控不得收窄该锁或把托管与 Legacy 拆分。目录下的账本文件另按 `ledgerKey = sha256(identityKey).slice(0, 16)` 键控：`managed-state-<ledgerKey>.json`。一个注册下暂存的 pending 账本绝不会被同一邮箱的另一注册加载或重放。凭据绝不定义身份。
- **适配器构造函数**传 `options.controlPlane.destinationKey ?? ''` 作第四参。`?? ''` 回退仅豁免省略该可选字段的非持久化测试替身；生产 HTTP 客户端总会提供它。
- **`load()`** 拆 read / parse / validate 三臂，点名 `this.file`，保留 fs `{ cause }`，使面对多个 `managed-state-<hash>.json` 账本的操作者能分辨哪个注册不可读、哪个 merely invalid。
- **升级诊断** — `strandedLegacyLedger()` 报告同目录升级前 `managed-state.json`（路径 + pending/outbound 计数 + `readable` 标志 + 旧账本 `lastUid`；generation 播种来自 `highestSiblingGeneration()`，而非本记录），`archiveStrandedLegacy()` 在启动成功后把它改名为 `managed-state.json.stranded-<uuid>`（绝不删除）——但只归档可读旧账本；不可读者留在原地，使修复指示仍有效、损坏文件不致成为永久的不可读 generation 来源。探测**不**以身份键控账本缺失为门：回滚到升级前版本可能在键控账本已存在后又向 `managed-state.json` 暂存新认领，这些仍须被报告。旧账本**不接管**——接管会把一个注册的 pending 重放进另一注册，正是键控要防的跨所有权风险。outbound 计数只含投递状态为 UNKNOWN 的段：确定的 accepted/rejected 回执证明结果，但缺失回执——或 outcome 为 `unknown` 的回执——不证明，故两者仍计入。可解析的非账本（`{}`、`[]`、`null`、或缺 pending/outbound 数组的对象）也被标记为不可读——是一份无法识别的文件，而非无丢失的 0/0。通知在 `openMailbox` 钉住游标之后发出，故其丢失子句查问真实窗口（已钉住的 `this.state.lastUid`，全新账本即邮箱尖端）。入站「does not re-fetch them」子句在全新升级、或已钉游标位于旧游标之上/相等（`pinned >= legacy.lastUid`）时发出：已暂存认领位于该游标处/下，落在「游标 + 1」的搜索下界之下。离线窗口子句用严格 `>`（`pinned > legacy.lastUid`）：窗口始于旧游标 + 1，故尖端等于旧游标的静默升级未跳过任何邮件、不报离线丢失，加载账本相等时下一次轮询即准入该邮件。回滚后再前进若其键控游标仍低于旧游标，会重新抓取窗口、不被告知丢失；首次启动失败后的重试（账本已钉到尖端）仍会报告。游标本身绝不从旧账本播种。
- **generation 播种** — 全新账本从 `generation: 1` 起步，但控制面的 `account_generation` 永不回退（`JdbcChannelInstanceStore` 对更低值抛 `channel_generation_stale`），且其栅栏按邮箱的每个注册身份共享的 `(tenant_id, channel_id)` 行。一个已重键控过的邮箱（UIDVALIDITY 变更递增并持久化了 `generation`）升级后会注册更低的 generation 并在每次启动被拒，托管 email 再也起不来。该计数器被治愈到邮箱目录内任何持久来源的最高安全整数 `generation`——活旧账本、每个同级身份键控账本、以及 `.stranded-*` 归档（`highestSiblingGeneration()`，镜像 GitHub 存储的条目范围 `entryWatchEpisodes` 携带）——且治愈发生在任何注册之前、在确立 generation 的两处都进行。`openMailbox()` 把全新账本 clamp 到 `max(1, 高水位)`、把 epoch 变更账本 clamp 到 `max(generation + 1, 高水位)`，故下线期间错过多次 epoch 变更的账本会跳到行值，而非注册一个仍低于行的 `+1`、在任何后续播种来得及运行前就被拒。`connect()` 再治愈「epoch 已匹配但 generation 仍落后于行」的加载账本。读归档与同级而非仅字面旧账本，使同一邮箱的第二注册在第一注册归档旧账本后仍能触及高水位。治愈只抬高、不降低，故对当前账本幂等。由于行单调且 `>=` 每个同级 generation，低于高水位的已暂存认领已然死亡——其 generation 永不能被注册——故治愈显式丢弃它（一行日志点名条数，镜像 epoch 分支），而非在被抬高的 generation 下重新提供它（那会改变其去重键）；这也给「带暂存认领的落后账本」一个出口，而非永久的 `channel_generation_stale` 楔死。非整数或超范围值不携带：状态校验器要求安全整数 `>= 1`，播种这样的值会持久化一个下次 `load()` 拒绝的账本，把它损坏。不可读的 generation 来源对数值无贡献，但其路径被返回并记录，绝不静默丢弃。这是「不接管」的唯一例外：generation 是控制面已知的计数器，而非 pending/游标状态，故治愈它不接管任何活认领，全新账本仍从邮箱尖端、空 pending 起步。

### 升级后果

账本文件从 `managed-state.json` 改名为 `managed-state-<ledgerKey>.json`，**不接管 pending 或游标状态**（单调 `generation` 计数器是唯一例外，播种回去使已重键控的邮箱仍能注册——见设计）：升级后第一次重启在全新身份键控账本上启动。一条已暂存（已持久化）但尚未准入的认领被滞留——控制面从未见过它（只有 `submitInbound` 使认领可见），故只有本客户端自己的账本能重驱动它，而新账本不含它。与 DingTalk 的已 ack 流不同，email 不向提供方 ack 帧；丢失来自游标：全新账本的 `openMailbox` 设 `lastUid = mailbox.uidNext - 1`（当前邮箱尖端），故被滞留认领的较旧 UID 低于全新搜索下限、绝不会被重新抓取。同一次重置还丢掉去重窗口（`recent`）、回复路由与未回执出站段。这是 WeCom / DingTalk / GitHub 设计记录的刻意滞留取舍。

通知分别点名入站与出站后果（仅出站滞留不谎报入站邮件丢失），不可读旧账本以 `unknown` 计数加一句「其所含任何已暂存认领均被滞留」的明确警告报告，绝不渲染成静默空账本。游标低于邮箱尖端的静默 0/0 旧账本会得到一句独立子句点名被跳过的离线窗口——在旧 `lastUid` 之后、本次启动之前收到的邮件从未被列出、也不会被准入；尖端等于旧游标的静默升级未跳过任何邮件、不报离线丢失，真正无游标的 0/0 旧账本也无丢失告警。通知在游标钉住后发出：入站子句在全新升级、或已钉游标位于旧游标之上/相等（`>=`）时发出，离线窗口子句要求已钉游标严格越过它（`>`），故回滚后再前进若其键控游标仍会重新抓取旧窗口，不会被告知一个并不发生的丢失；而首次启动失败后的重试（其账本已钉到尖端）仍会重复这些子句。归档推迟到启动成功之后（邮箱打开、generation 治愈、注册、ownership 复查之后），故首次启动失败会留下旧账本供回滚恢复；第二行日志点名归档路径。只归档可读旧账本——不可读者留在原地供修复（归档它会使恢复指示失效、并使损坏文件成为永久的不可读 generation 来源）。归档 rename 失败会打日志并留下旧账本（降级，绝不启动失败）。

反向同样受限，且对 email 比全新启动更糟：成功升级后 `archiveStrandedLegacy()` 已把 `managed-state.json` 改名移走，而升级前构建只读那个字面名。故回滚会新建 `generation: 1` 账本，只要共享 `(tenant_id, channel_id)` 行高于 1 就每次启动被 `channel_generation_stale` 拒绝——回滚期间渠道一直起不来，而代数只存在于 `.stranded-<uuid>` 归档里，没有任何构建会读这个名字。恢复办法是把归档账本还原为 `managed-state.json`（或重置控制面行）。认领本身并未销毁——身份键控账本保留它们，后续再升级会重新加载。

## 涉及文件

- `packages/channels/email/src/managed-state.ts` — 存储构造函数：不变的 Legacy 邮箱目录内的身份键控账本文件；`load()` 拆臂；`strandedLegacyLedger()`（计数 + `readable` 含非账本形状 + `lastUid`，未知状态 outbound 过滤）+ `archiveStrandedLegacy()` + `highestSiblingGeneration()`（返回高水位与其跳过的不可读来源）。
- `packages/channels/email/src/managed-email-adapter.ts` — 传 `destinationKey` 给存储；`connect()` 滞留通知（全新窗口门 + 离线窗口子句）+ generation 播种 + ownership 复查 + 延迟归档 + 归档路径/归档失败日志。
- `packages/channels/base/src/managed-channel.ts` — 共享 `destinationKey` 文档注释现将 email 列入绑定它的适配器（仅注释；无契约/API 改动）。
- `packages/channels/email/src/managed-state.test.ts` 与 `managed-email-adapter.test.ts` — 键控、隔离、滞留、离线窗口、generation 播种、损坏旧账本、归档、连接中 ownership 丢失、失败启动归档见证。
- 本设计文档与其中文版。

## 范围边界

- email IMAP 轮询、准入/出站纪律、邮箱 epoch 重键控、实例级 stall 不变。仅账本文件名、generation 播种与升级诊断改变。
- 锁刻意保持共享的 Legacy 邮箱锁：身份键控增加跨注册账本隔离，但不收窄「每邮箱单一所有者」锁、也不拆分托管与 Legacy。
- 无控制面（Java）改动；无 `channel-base` 契约/API 改动（仅更新 `destinationKey` 文档注释以列入 email）。
- email 存储无 PR-watch，故无 episode 携带（不同于 GitHub）。
- 滞留诊断只覆盖升级前 `managed-state.json`。升级后，注册身份变更（同一邮箱的新 actor/workspace）会遗弃上一注册的身份键控账本（`managed-state-<hash>.json`）——含 pending 认领——且无任何通知，因为 `strandedLegacyLedger()` 只 stat 字面 `managed-state.json`。这与 WeCom / DingTalk / GitHub 兄弟是同一缺口，作为 #17769 的 item 1 跟踪、此处不实现；该诊断不应被读作覆盖所有滞留情形。
- generation 高水位携带是目录作用域（邮箱目录按邮箱配置 + cwd 键控），而控制面栅栏按 `(tenant_id, channel_id)` 行作用域。同一行内携带与显式丢弃认领是正确的；跨共享目录的行（同一邮箱配置 + cwd 注册到不同 tenant/channel）携带可能读到外来行的计数，而同级 cwd 目录对它不可见。把携带收敛到栅栏身份需要 `channel-base` 契约中的行作用域键——波及全部四个提供方与 client 的跨切面改动——作为 #17769 的后续跟踪、此处不实现。维护者接受该边缘配置的残余风险（R4-1）。

## 开放问题

- 无：形状由 WeCom P1-D/E、DingTalk #17742、GitHub #17775 先例与共享 `destinationKey` 契约确定。
