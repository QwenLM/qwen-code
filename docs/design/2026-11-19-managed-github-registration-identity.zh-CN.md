# 托管 GitHub 账本注册身份键控

- **状态：** 提议中
- **日期：** 2026-11-19
- **范围：** `packages/channels/github`（状态存储 + 适配器）、`channel-base` 契约注释、测试
- **相关：** WeCom 适配器的 P1-D/E 修复（PR #17441）与 DingTalk 键控（PR #17742）；`channel-base` 的共享 `destinationKey` 契约；[英文版](2026-11-19-managed-github-registration-identity.md)

## 问题

托管 GitHub 状态存储仅按配置条目键控其单一账本文件——渠道 name + 端点 `baseUrl`，按工作区范围。一条在一个控制面注册（租户 A）下暂存为 pending 认领的评论，因此会在同一配置条目改对另一注册（租户 B，或同租户内不同 actor/workspace/cwd-relative）重启时被加载。持久化事件携带完整文本而无租户身份；`resubmitPending()` 经 HTTP 客户端转发它，客户端供给新注册的租户头与渠道 id，于是已被 A 准入但应答丢失的事件可能在 B 下创建一个输入。这正是 WeCom 适配器在 P1-E、DingTalk 适配器在 #17742 关闭的跨所有权重放。

## 现状

`ManagedGithubStateStore(name, cwd, baseUrl)` 把 `name\0baseUrl` 哈希成按条目的目录 `~/.qwen/channels/<workspace-scope>/github-<hash>`，并在其下存单一 `managed-state.json`。目录锁（`proper-lockfile`）串行化该 name + endpoint 的并发托管实例。适配器用三个参数构造存储，从不传控制面目的地。`load()` 把 I/O 失败与内容损坏折叠成一个不点名文件的错误。

共享 `ManagedChannelControlPlane.destinationKey` 已绑定完整注册身份——base URL + tenant + channel + actor + workspace + cwd-relative——且 `HttpManagedChannelControlPlane`（唯一生产实现）在每条真实路径都填充它。base 接口注释点名 GitHub 存储为尚未绑定它的兄弟。

## 提议改动

逐字镜像 WeCom / DingTalk 形状：

- **存储构造函数**加第四参 `identityKey = ''`。锁目录仍按配置条目（`name\0baseUrl`）按工作区范围键控——不按目的地——故同一 name + endpoint 的两个实例即便目标控制面目的地不同也争同一把连接锁。目录下的账本文件另按 `sha256(identityKey)` 键控：`managed-state-<ledgerKey>.json`。一个注册下暂存的 pending 账本绝不会被同一条目的另一注册加载或重放。
- **适配器构造函数**传 `options.controlPlane.destinationKey ?? ''` 作第四参。`?? ''` 回退仅用于省略该可选字段的非持久化测试替身；生产 HTTP 客户端恒供给它。
- **`load()`** 拆分 read / parse / validate 三臂，点名 `this.file`，并以 `{ cause }` 保留 fs 错误，使面对多个 `<hash>.json` 账本的操作者能判断哪个注册不可读、哪个 merely 无效。

锁刻意保持按条目：按目的地的锁会让一个配置 name + endpoint 的两个注册各拿一把锁并发运行，重复入站处理。账本键控在不收窄锁的前提下加跨注册隔离。

`channel-base` 的共享 `destinationKey` 注释更新为点名 WeCom、DingTalk **与 GitHub** 为绑定注册身份的适配器，留 email（独立变体）为剩余后续。

## 升级后果与诊断

账本文件从 `managed-state.json` 改名为 `managed-state-<ledgerKey>.json`，**不接管**：升级后第一次重启在全新的身份键控账本上启动。一条已暂存（已持久化）但尚未准入的认领被滞留——控制面从未见过它（只有 `submitInbound` 使认领可见），故只有本客户端自己的账本能重驱动它，而新账本不含它。与 DingTalk 的流不同，GitHub 不向提供方 ack 帧；丢失来自通知窗口：持有认领的线程从不标已读并冻结水位，但全新账本的 cursor 为 null，故首次轮询的 `since` 是 connect 时刻，旧通知不再被列出。同一次重置还丢掉 cursor（通知水位 + 已派发评论环）与未回执的出站段。这是 WeCom / DingTalk 设计记录的刻意滞留取舍：接管旧账本会把一个注册的 pending 重放进另一注册，正是键控要防的跨所有权 hazard。

为使丢弃显式而非静默，`connect()` 探测同目录的 `managed-state.json`（`strandedLegacyLedger()`），打一行日志指明该路径及其 pending/outbound 条数，但不接管它。探测刻意**不**以身份键控账本缺失为门：回滚到升级前版本可能在键控账本已存在后又向 `managed-state.json` 暂存新认领，这些认领仍须被报告，而非无声消失。记录带 `readable` 标志：内容无法读取或解析的旧账本以 `unknown` 计数加一句「其所含任何已暂存认领均被滞留」的明确警告报告，绝不渲染成静默的空账本。对可读旧账本，入站与出站后果分别点名——仅当 `pending > 0` 才输出入句子句，仅当 `outbound > 0` 才输出出站子句——故仅出站滞留不会谎报入站评论丢失，静默升级（0/0）仍得到诊断行但无虚假数据丢失告警。损坏旧账本绝不抛出，故受损旧账本绝不会把升级变成硬性启动失败。归档推迟到启动成功之后：在客户端身份解析、注册与 ownership 复查完成后，`archiveStrandedLegacy()` 把旧账本重命名为 `managed-state.json.stranded-<id>`——绝不删除，使被滞留认领仍可查——并打第二行日志点名归档路径，使循通知而来的操作者能找到认领。首次启动失败则旧账本原样保留，使回滚到升级前版本仍能恢复它（提示仅在重试时重复）；回滚若再暂存新的 `managed-state.json`，下次升级会再次探测到。反向亦有界：成功升级后回滚到升级前版本会在全新账本上启动，因该版本只加载 `managed-state.json` 而新版本从不写它；认领并未销毁（身份键控账本保留、后续再升级重新加载），但回滚期间升级前版本不给任何信号表明先前注册正持有已暂存未准入的评论。

## 涉及文件

- `packages/channels/base/src/managed-channel.ts` —— `destinationKey` 注释：点名 WeCom、DingTalk 与 GitHub 为绑定者；email 仍为后续。
- `packages/channels/github/src/managed-state.ts` —— 存储构造函数：条目键控目录 + 身份键控账本文件；`load()` 拆臂；`strandedLegacyLedger()` + `archiveStrandedLegacy()`。
- `packages/channels/github/src/managed-github-adapter.ts` —— 传 `destinationKey` 给存储；`connect()` 滞留通知 + 延迟归档 + 归档路径日志。
- `packages/channels/github/src/managed-state.test.ts` —— 更新文件路径期望；加键控、隔离、滞留与损坏旧账本见证。
- `packages/channels/github/src/managed-github-adapter.test.ts` —— `fakeControlPlane` 加 `destinationKey`；加目的地/工作区隔离、共享锁与滞留诊断见证。
- 本设计文档及其中文版。

## 范围边界

- GitHub 通知轮询、准入/出站纪律、标已读/窗口冻结机制不变。仅账本文件名与升级诊断改变。
- `disconnect()` 的行注销门控是独立 concern，本次不动。
- 无控制面（Java）改动；无 `channel-base` 契约/API 改动——仅更新 `destinationKey` 注释。
- email 存储不在范围（独立变体）；它是剩余后续。

## 开放问题

- 无：形状由 WeCom P1-D/E 与 DingTalk #17742 先例及共享 `destinationKey` 契约定案。
