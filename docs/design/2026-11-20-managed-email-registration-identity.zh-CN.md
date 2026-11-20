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
- **升级诊断** — `strandedLegacyLedger()` 报告同目录升级前 `managed-state.json`（路径 + pending/outbound 计数 + `readable` 标志），`archiveStrandedLegacy()` 在启动成功后把它改名为 `managed-state.json.stranded-<uuid>`（绝不删除）。探测**不**以身份键控账本缺失为门：回滚到升级前版本可能在键控账本已存在后又向 `managed-state.json` 暂存新认领，这些仍须被报告。旧账本**不接管**——接管会把一个注册的 pending 重放进另一注册，正是键控要防的跨所有权风险。

### 升级后果

账本文件从 `managed-state.json` 改名为 `managed-state-<ledgerKey>.json`，**不接管**：升级后第一次重启在全新身份键控账本上启动。一条已暂存（已持久化）但尚未准入的认领被滞留——控制面从未见过它（只有 `submitInbound` 使认领可见），故只有本客户端自己的账本能重驱动它，而新账本不含它。与 DingTalk 的已 ack 流不同，email 不向提供方 ack 帧；丢失来自游标：全新账本的 `openMailbox` 设 `lastUid = mailbox.uidNext - 1`（当前邮箱尖端），故被滞留认领的较旧 UID 低于全新搜索下限、绝不会被重新抓取。同一次重置还丢掉去重窗口（`recent`）、回复路由与未回执出站段。这是 WeCom / DingTalk / GitHub 设计记录的刻意滞留取舍。

通知分别点名入站与出站后果（仅出站滞留不谎报入站邮件丢失；静默 0/0 旧账本无丢失告警），不可读旧账本以 `unknown` 计数加一句「其所含任何已暂存认领均被滞留」的明确警告报告，绝不渲染成静默空账本。归档推迟到启动成功之后（邮箱打开、注册、ownership 复查之后），故首次启动失败会留下旧账本供回滚恢复；第二行日志点名归档路径。归档 rename 失败会打日志并留下旧账本（降级，绝不启动失败）。

## 涉及文件

- `packages/channels/email/src/managed-state.ts` — 存储构造函数：不变的 Legacy 邮箱目录内的身份键控账本文件；`load()` 拆臂；`strandedLegacyLedger()` + `archiveStrandedLegacy()`。
- `packages/channels/email/src/managed-email-adapter.ts` — 传 `destinationKey` 给存储；`connect()` 滞留通知 + ownership 复查 + 延迟归档 + 归档路径/归档失败日志。
- `packages/channels/email/src/managed-state.test.ts` 与 `managed-email-adapter.test.ts` — 键控、隔离、滞留、损坏旧账本、归档见证。
- 本设计文档与其中文版。

## 范围边界

- email IMAP 轮询、准入/出站纪律、邮箱 epoch 重键控、实例级 stall 不变。仅账本文件名与升级诊断改变。
- 锁刻意保持共享的 Legacy 邮箱锁：身份键控增加跨注册账本隔离，但不收窄「每邮箱单一所有者」锁、也不拆分托管与 Legacy。
- 无控制面（Java）改动；无 `channel-base` 契约/API 改动。
- email 存储无 PR-watch，故无 episode 携带（不同于 GitHub）。

## 开放问题

- 无：形状由 WeCom P1-D/E、DingTalk #17742、GitHub #17775 先例与共享 `destinationKey` 契约确定。
