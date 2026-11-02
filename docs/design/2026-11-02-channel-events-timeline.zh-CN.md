# Web Shell 中的渠道事件时间线

[English](2026-11-02-channel-events-timeline.md) | [简体中文](2026-11-02-channel-events-timeline.zh-CN.md)

状态：已实现。日期：2026-11-02。

## 问题

渠道的大量行为目前只能从 stderr 看出来。当 GitHub 渠道没有回复某条评论时，运维人员在 Web Shell 里无法判断：通知是被 `reasonFilter` 过滤了、因为评论没有 @ 机器人被丢弃、被发送方门禁拒绝、被去重跳过，还是已经回答但最终被抑制（suppressed）而没有发表。渠道管理页只显示配置和运行时徽标（`stopped` / `starting` / `connected` / `partial` / `error`），不显示渠道实际做了什么。

能回答这些问题的信息其实零散存在：preflight 拒绝和轮询失败写 stderr，发表结果写 `github-audit.jsonl`，入站任务状态写 `github-inbound-tasks.json`，通知原因过滤只写 debug payload。这些都没有 daemon 可读的出口，所以任何页面都拿不到。

## 目标

- 按渠道记录渠道做了什么，写入一个有上限、只追加的事件日志。
- 用工作区作用域的只读 daemon 路由暴露该日志。
- 在 Web Shell 以独立页面展示跨渠道时间线，支持按渠道和事件类型过滤。

## 非目标

- 日志不记录消息正文。运维人员看到的是路由决策和结果，不是会话内容。
- 不做实时推送（SSE）。页面用轮询，因为渠道 worker 与 daemon 是不同进程。
- 不新增能力位。页面复用 `channel_management` 门禁——事件日志本来就只在该能力存在的地方存在。
- 除一个轮转文件外不做保留策略。事件日志是诊断用的，`github-audit.jsonl` 仍然是发表记录。

## 现状

- `packages/channels/base/src/PollingChannelBase.ts` 负责轮询和退避，轮询失败只写 stderr。
- `packages/channels/base/src/ChannelBase.ts` 在 `preflightInbound` 中拒绝入站消息（消息路由、群门禁、私信门禁、发送方门禁），并通过 `logPreflightRejected` 打一行原因。
- `packages/channels/github/src/GithubAdapter.ts` 轮询 GitHub 通知，按 `reasonFilter` 过滤，用游标记账去重，把入站任务记在 `github-inbound-tasks.json`，把发表结果记在 `github-audit.jsonl`。
- `packages/cli/src/serve/routes/workspace-channel-management.ts` 提供渠道配置、生命周期和配对路由，没有任何读取运行时活动的接口。
- `packages/web-shell/client/components/channels/ChannelsManagerPage.tsx` 是 Web Shell 唯一的渠道界面。

## 设计

### 1. 事件日志（`packages/channels/base/src/channel-events.ts`）

渠道按事件追加一行 JSON。文件与其他工作区作用域的渠道状态文件放在一起：

```
~/.qwen/channels/<workspaceScopeDir>/<encodedName>-<nameHash16>-channel-events.jsonl
```

其中 `<workspaceScopeDir>` 为 `getWorkspaceScopeDirName(config.cwd)`，文件名沿用 GitHub 状态文件已有的 `encodedName` + `nameHash16` 规则，渠道名无法逃出该目录。

记录字段：

| 字段          | 含义                                                           |
| ------------- | -------------------------------------------------------------- |
| `at`          | ISO 时间戳                                                     |
| `channel`     | 渠道实例名，完整保留（见下方上限）                             |
| `type`        | `inbound` / `outbound` / `task` / `poll`                       |
| `outcome`     | `accepted` / `skipped` / `posted` / `failed` / `ok` / 任务状态 |
| `reason`      | 跳过原因的机器码（`sender_denied`、`reason_filter` 等）        |
| `triggerKind` | 渠道特定的触发类型（`mention`、`assign` 等）                   |
| `repository`  | 会话容器（GitHub 下为 `owner/repo`）                           |
| `thread`      | 线程标识（`issue:12`、`pr:34`）                                |
| `number`      | issue 或 PR 编号                                               |
| `actor`       | 发送方登录名                                                   |
| `sessionId`   | 处理该消息的会话                                               |
| `messageId`   | 来源消息标识                                                   |
| `durationMs`  | 轮询耗时                                                       |
| `error`       | 单行化错误信息，上限 200 字符                                  |
| `detail`      | 扁平原始类型映射，最多 12 个键                                 |

上限：自由文本字段与 `detail` 的值截断到 200 字符。渠道标识是例外：管理接口接受最长 255 UTF-8 字节的名字，而码点数不会超过字节数，因此标识保留到 255 个码点——任何合法名字都完整保留，并且仍能被 `channel` 过滤匹配。只有界面在展示时缩短它。

追加会超过 1 MiB 时轮转为 `<name>.1`，旧的 `.1` 被替换。目录权限 `0700`，文件权限 `0600`。任何写失败都吞掉并只打一行 stderr：诊断设施绝不能打断消息处理。

### 2. 记录点

| 位置                                                           | 事件                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ChannelBase.logPreflightRejected`                             | `inbound` / `skipped`，带拒绝原因                                                    |
| `ChannelBase.preflightInbound`（消息路由、`mention_required`） | `inbound` / `skipped`，原因 `message_route` 或 `group_mention_required`              |
| `ChannelBase.processPreflightedInbound`                        | `inbound` / `accepted`                                                               |
| `PollingChannelBase.runLoop`                                   | `poll` / `ok` 带 `durationMs` 与适配器详情；`poll` / `failed` 带 `consecutiveErrors` |
| `GithubAdapter` 原因过滤                                       | `inbound` / `skipped`，原因 `reason_filter`                                          |
| `GithubAdapter` 评论通道（`onlyMentioned` 未命中）             | `inbound` / `skipped`，原因 `mention_required`                                       |
| `GithubAdapter` 去重命中                                       | `inbound` / `skipped`，原因 `duplicate`                                              |
| `GithubAdapter.claimInboundTask`                               | `task` / `accepted`                                                                  |
| `GithubAdapter.transitionInboundTask`                          | `task` / `<state>`，带 `attempts` 与 `error`                                         |
| `GithubAdapter.recordPublicationAudit`                         | `outbound` / `<outcome>`（审计文件继续保留）                                         |

`PollingChannelBase` 增加 `setPollEventDetail` 挂点，适配器可以挂自己的计数（GitHub 报告本次轮询取到多少条通知），基类不需要知道这些字段。基类在轮询开始前清空该字段，并在本次轮询结束后才消费它，因此事件绝不会把上一次轮询的计数记到本次的时间戳上。

### 3. daemon 路由

```
GET /workspace/channels/events
GET /workspaces/:workspace/channels/events
```

查询参数：`limit`（1-500，默认 100）、`type`（逗号分隔）、`channel`（每个实例名重复一次该参数）、`since`（ISO 时间戳）。

响应：`{ "events": [...], "truncated": boolean }`，`Cache-Control: no-store`，并沿用其他工作区渠道路由的信任与客户端校验。

路由从不接受请求给出的路径。作用域目录由解析后运行时的 workspace cwd 经 `getWorkspaceScopeDirName` 推导；受管渠道的工作目录必须规范化到同一个工作区，因此它的日志就在那里。读取有上限：每个日志文件（当前与 `.1`）最多读尾部 2 MiB，每次请求最多读 32 个日志文件，最多返回 500 条记录。`channel` 过滤会先按名字推导出的标识收窄候选文件，**再**套用 32 个文件的上限，因此即使更繁忙的同伴有更新的文件，被显式请求的安静渠道仍然可达。

### 4. Web Shell

- `useChannelEvents` 在页面挂载期间轮询该路由（5 秒），页面另提供手动刷新。每份快照都带上产生它的查询（工作区、渠道、类型、limit），不匹配的数据会被遮蔽，做法与 `useDaemonChannels` 一致：底层 resource 在请求进行中或失败后仍保留旧数据，没有这个标记的话，上一个工作区的行——以及过滤选项里它的渠道名——就会显示在新选中的工作区下。
- `ChannelEventsPage` 渲染按时间倒序的时间线，带工作区选择器、渠道过滤、类型过滤，每行显示：时间、渠道、类型、结果、目标（`owner/repo#12`）、操作者、原因或触发类型、耗时、错误。工作区选择器与管理页一样列出已注册的非 live 工作区，因为 provider 的 cwd 是 daemon 全局的主工作区，否则在次工作区启动的渠道将无法查看。切换工作区会重置渠道过滤。
- 它是独立页面：`activePanel` 取值 `channel-events`，URL 为 `/channel-events`，侧边栏主导航项为 `channelEvents`。
- 由 `channel_management` 能力位与受信任工作区门禁，与管理页一致。

## 涉及文件

- `packages/channels/base/src/channel-events.ts`（新增）及其测试
- `packages/channels/base/src/ChannelBase.ts`
- `packages/channels/base/src/PollingChannelBase.ts`
- `packages/channels/base/src/index.ts`
- `packages/channels/github/src/GithubAdapter.ts`
- `packages/cli/src/serve/routes/workspace-channel-management.ts`
- `packages/sdk-typescript/src/daemon/types.ts` 及其 barrel
- `packages/web-shell/client/hooks/useChannelEvents.ts`（新增）
- `packages/web-shell/client/components/channels/ChannelEventsPage.tsx`（新增）
- `packages/web-shell/client/components/channels/channel-events-messages.ts`（新增）
- `packages/web-shell/client/App.tsx`、
  `components/sidebar/WebShellSidebar.tsx`、`utils/navigationUrl.ts`、
  `i18n.tsx`

## 设计决策

- **用文件日志而不是 IPC。** 渠道运行在 daemon fork 出来的 worker 进程里。文件让 daemon 路由保持只读、无状态，并在 worker 重启后仍然存在——而运维人员正是在重启前后查最近发生了什么。
- **一个通用日志，而不是 GitHub 专用。** 所有渠道类型都继承基类的记录点；页面本身是跨渠道的，只做 GitHub 会导致很快需要第二套实现。
- **不记录消息正文。** 日志不能变成第二份未脱敏的消息历史；发表事件只带结果，正文摘要仍由现有审计文件的 `bodySha256` 与 `bodyChars` 承担。
- **复用 `channel_management`。** 新增能力位要动三处注册表和漂移断言，却没有用户可见收益：事件日志只在渠道管理存在的地方存在。
- **保留 `github-audit.jsonl`。** 它回答的是另一个问题（发表了什么、正文摘要），恢复流程已经在读它。

## 风险

- 繁忙群渠道的环境消息跳过可能很频繁。日志靠轮转封顶，页面默认只显示最新 100 条，没有无界增长。
- 同步追加位于消息路径上。记录很小且失败被吞掉；改成异步队列会在崩溃时丢掉最后几条事件，而那时恰恰最需要它们。
- 路由每次请求都读磁盘。只读尾部窗口，页面仅在可见时每 5 秒轮询一次。

## 验证

- 单元测试：日志的追加/读取/过滤/轮转/上限与被吞掉的写失败；GitHub 的入站跳过、任务与发表事件；路由按渠道和类型过滤、夹在解析后的工作区内、支持 `since`。
- Web Shell：页面渲染行、两个过滤器生效、空态与错误态正确。
- 手工：用一个测试仓库跑 GitHub 渠道，确认页面能看到会话创建之前的过滤跳过，并按顺序看到接受的触发、任务状态变化与发表结果。

## 验收标准

- 运维人员能在 Web Shell 里查明某条 GitHub 通知为什么没有产生回复（原因过滤、未 @、门禁拒绝、去重），不必翻 stderr。
- 发表结果与入站任务失败出现在同一条时间线上。
- 轮询失败与恢复以 `poll` 事件出现，并带上连续错误次数。
- 日志不写消息正文，任何路由都无法读到解析工作区之外的渠道状态。
