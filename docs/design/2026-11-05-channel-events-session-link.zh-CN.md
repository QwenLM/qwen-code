# 频道事件页的会话跳转链接

[English](2026-11-05-channel-events-session-link.md) | [简体中文](2026-11-05-channel-events-session-link.zh-CN.md)

状态：已实现（2026-11-05）

## 问题

Web Shell 的频道事件页展示频道做了什么（入站、出站、任务、轮询），但指向
具体会话的事件行没有提供打开该会话的入口。排查 bound-session 投递（PR 事件
注入绑定了该 PR 的会话，#16117）或已发表回复的操作者，必须手工复制会话 id
再去寻找会话。

## 现状

- 日志记录（`packages/channels/base/src/channel-events.ts` 的
  `ChannelEventRecord`）与 SDK 形状（`packages/sdk-typescript/src/daemon/types.ts`
  的 `DaemonChannelEvent`）已带可选 `sessionId`，daemon 路由
  `GET .../channels/events` 原样透传记录。
- GitHub 出站（发表审计）行已记录频道自身回复会话的 `sessionId`。
- GitHub 任务行不记录会话，即使任务投递进了 PR 绑定会话（每次流转时
  `task.delivery.sessionId` 都是已知的）。
- 页面只渲染 GitHub web 链接，没有会话导航。
- 应用壳已有会话导航路径：`qwen:open-session` window 事件，detail 为
  `{ sessionId, workspaceCwd? }`，markdown 的 `qwen-session://` 链接与
  turn 通知都在用。

## 目标

- 每条点名了会话的日志行都提供一键跳转。
- bound-session 投递的任务行点名目标会话及其所属工作区，跨工作区目标也能
  正确打开。

## 非目标

- 不改投递、去重、恢复语义。
- 没有会话身份的行（入站跳过、轮询、回复会话尚不存在的公共路径任务）不加
  会话链接。
- 不新增 daemon 路由；日志仍是唯一数据源。

## 方案

1. 日志：给 `ChannelEventRecord` 增加可选字段 `sessionWorkspaceCwd`（与其
   他文本字段一样归一化，上限 1024 字符），并同步到 SDK 的
   `DaemonChannelEvent`。
2. GitHub 适配器：
   - `claimInboundTask`（accepted）与 `transitionInboundTask`（其后每个状
     态）通过共用的 `boundJournalIdentity` 辅助方法，为 bound-session 投递
     附上 `sessionId`，并在绑定快照知道时附上 `sessionWorkspaceCwd`。身份
     取自更新后的任务记录，改绑与 gone 回退记录的才是该次流转真正指向的
     会话。
   - `recordPublicationAudit` 将 `sessionWorkspaceCwd` 写为频道自身工作区
     （`config.cwd`）——回复会话就属于该工作区。
3. Web Shell `ChannelEventsPage`：带 `sessionId` 的行渲染图标按钮（"Open
   session" / "打开会话"），点击派发 `qwen:open-session`，detail 为
   `{ sessionId, workspaceCwd: event.sessionWorkspaceCwd ??
selectedWorkspaceCwd }`。应用壳关闭面板并经现有导航路径加载会话。

## 设计决策

- 工作区归属随记录携带，而不是客户端反查：bound 投递明确支持跨工作区，而
  daemon 的会话加载路由在不带工作区时解析到 primary 工作区，缺少归属的链
  接对次级工作区目标会失败。绑定快照（`PrBindingSummary.workspaceCwd`）在
  记录日志时已在 worker 内存中，不产生额外 I/O。
- 无 `sessionWorkspaceCwd` 的旧记录回退到日志自身的工作区：对频道回复会话
  （旧记录唯一会点名的会话种类）是正确的。
- 冻结的投递可能比绑定活得更久（恢复的任务、gone 会话）；这类行保留
  `sessionId` 而不带工作区，不做猜测。
- 跳转复用 `qwen:open-session` 而不是 URL：与 markdown 会话链接同一条应用
  内路径，尊重锁定工作区模式，无需改路由。

## 约束与风险

- 仅新增可选字段；旧 daemon/客户端互操作不受影响。日志归一化会丢弃非法值。
- 工作区查询是尽力而为的装饰；未命中只回退工作区，绝不影响投递。
- 锁定工作区的壳会忽略跨工作区跳转，与既有会话链接行为一致。

## 验证

- 单测：`channel-events.test.ts`（新字段的往返与归一化）、
  `GithubAdapter.test.ts`（bound 任务行携带绑定的会话与工作区；公共路径任
  务行两者皆无）、`ChannelEventsPage.test.tsx`（仅有会话时渲染按钮；点击
  派发导航事件并带记录的工作区，缺失时回退所选工作区）。
- 构建与类型检查：`npm run build && npm run typecheck`。

## 验收标准

- bound-session 投递产生的任务行，其"打开会话"按钮能打开目标会话，目标在
  另一工作区时亦然。
- 出站行的按钮能打开频道的回复会话。
- 无会话的行不渲染按钮；既有 GitHub 链接与 visuals 夹具不变。
