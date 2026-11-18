# 托管 DingTalk 账本注册身份键控

- **状态：** 提议中
- **日期：** 2026-11-18
- **范围：** `packages/channels/dingtalk`（状态存储 + 适配器）、测试
- **相关：** WeCom 适配器的 P1-D/E 修复（PR #17441）；`channel-base` 的共享 `destinationKey` 契约；[英文版](2026-11-18-managed-dingtalk-registration-identity.md)

## 问题

托管 DingTalk 状态存储仅按配置条目键控其单一账本文件——渠道 name + 机器人 `clientId`，按工作区范围。一条在一个控制面注册（租户 A）下暂存为 pending 认领的私聊消息，因此会在同一配置条目改对另一注册（租户 B，或同租户内不同 actor/workspace/cwd-relative）重启时被加载。持久化事件携带完整文本而无租户身份；`resubmitPending()` 经 HTTP 客户端转发它，客户端供给新注册的租户头与渠道 id，于是已被 A 准入但应答丢失的事件可能在 B 下创建一个输入。这正是 WeCom 适配器在 P1-E 关闭的跨所有权重放。

## 现状

`ManagedDingtalkStateStore(name, cwd, clientId)` 把 `name\0clientId` 哈希成按条目的目录 `~/.qwen/channels/<workspace-scope>/dingtalk-<hash>`，并在其下存单一 `managed-state.json`。目录锁（`proper-lockfile`）串行化该机器人应用的并发托管实例。适配器用三个参数构造存储，从不传控制面目的地。

共享 `ManagedChannelControlPlane.destinationKey`（为 WeCom 而加）已绑定完整注册身份——base URL + tenant + channel + actor + workspace + cwd-relative——且 `HttpManagedChannelControlPlane`（唯一生产实现，由所有托管渠道共用的 `createManagedChannelCommand` factory 构造）在每条真实路径都填充它。base 接口注释点名 DingTalk 存储为尚未绑定它的兄弟。

## 提议改动

逐字镜像 WeCom P1-D/E 形状：

- **存储构造函数**加第四参 `identityKey = ''`。锁目录仍按配置条目（`name\0clientId`）按工作区范围键控——不按目的地——故同一机器人应用的两个实例即便目标控制面目的地不同也争同一把连接锁。目录下的账本文件另按 `sha256(identityKey)` 键控：`managed-state-<ledgerKey>.json`。一个注册下暂存的 pending 账本绝不会被同一条目的另一注册加载或重放。
- **适配器构造函数**传 `options.controlPlane.destinationKey ?? ''` 作第四参。`?? ''` 回退仅用于省略该可选字段的非持久化测试替身；生产 HTTP 客户端恒供给它。

锁刻意保持按条目：按目的地的锁会让一个配置机器人应用的两个注册各拿一把锁并发运行，重复入站处理。账本键控在不收窄锁的前提下加跨注册隔离。

`channel-base` 的共享 `destinationKey` 注释更新为点名 WeCom **与 DingTalk** 为绑定注册身份的适配器，并指 GitHub（仅 name+endpoint）与 email（独立变体）为剩余后续，使契约文档不再把 DingTalk 列为缺乏键控的兄弟。

## 涉及文件

- `packages/channels/base/src/managed-channel.ts` —— `destinationKey` 注释：点名 WeCom 与 DingTalk 为绑定者；GitHub/email 仍为后续。
- `packages/channels/dingtalk/src/managed-state.ts` —— 存储构造函数：条目键控目录 + 身份键控账本文件。
- `packages/channels/dingtalk/src/managed-dingtalk-adapter.ts` —— 传 `destinationKey` 给存储。
- `packages/channels/dingtalk/src/managed-state.test.ts` —— 更新文件路径期望；加键控与隔离见证。
- `packages/channels/dingtalk/src/managed-dingtalk-adapter.test.ts` —— `fakeControlPlane` 加 `destinationKey`；加目的地/工作区隔离与共享锁见证。
- 本设计文档及其中文版。

## 升级后果与诊断

账本文件从 `managed-state.json` 改名为 `managed-state-<ledgerKey>.json`，**不接管**：升级后第一次重启在全新的身份键控账本上启动。一条已暂存（已持久化并向 DingTalk 流 ack `SUCCESS`，而流不重投已 ack 的帧）但尚未准入的认领被滞留——控制面从未见过它（只有 `submitInbound` 使认领可见），故只有本客户端自己的账本能重驱动它，而新账本不含它。同一次重置还丢掉未回执的出站段、去重窗口与 webhook 回复目标表。这是 WeCom 设计记录的刻意滞留取舍：接管旧账本会把一个注册的 pending 重放进另一注册，正是键控要防的跨所有权 hazard。

为使丢弃显式而非静默，`connect()` 在身份键控文件缺失且同目录存在 `managed-state.json` 时探测旧账本，打一行日志指明该路径及其 pending/outbound 条数（`strandedLegacyLedger()`），但不接管它。`load()` 亦点名 `this.file` 并以 `{ cause }` 保留 fs 错误，拆分 I/O 失败与 JSON 损坏，使面对多个 `<hash>.json` 账本的操作者能判断哪个注册坏了。

webhook 回复目标缓存（`state.webhooks`）位于身份键控账本内，故现按注册作用域：身份变更后，先前已知会话的无 webhook 帧没有缓存的回复目标而被丢弃（ack + 去重），旧共享账本本仍会准入它。这是分区的代价，由测试钉住；若跨身份变更的无 webhook 帧常见，把缓存提升到条目作用域是可能的后续。

## 范围边界

- DingTalk 流连接与准入/出站纪律不变。webhook 回复*机制*不变，但 webhook 缓存现按身份作用域（见升级后果）：身份变更后的无 webhook 帧被丢弃，而非从跨注册缓存准入。
- `disconnect()` 的行注销门控是独立 concern，本次不动。
- 无控制面（Java）改动；无 `channel-base` 契约/API 改动——仅更新 `destinationKey` 注释以点名 WeCom 与 DingTalk 为绑定注册身份的适配器。
- email 与 GitHub 存储不在范围。GitHub 仅按 name + endpoint（`baseUrl`）键控其单一账本，email 是独立变体；两者都未绑定完整注册身份，故各自是独立后续而非本 DingTalk 改动的一部分。

## 开放问题

- 无：形状由 WeCom P1-D/E 先例与共享 `destinationKey` 契约定案。
