# 回收空闲渠道会话

[English](channel-session-idle-reclaim.md) | [简体中文](channel-session-idle-reclaim.zh-CN.md)

**状态：** 已实现
**日期：** 2026-11-07
**范围：** `packages/acp-bridge/src/session-control-plane.ts`、
`packages/web-shell/client/**`

## 1. 问题

一个工作区可能在所有 live 会话都空闲时达到 `maxSessionsPerWorkspace`。此时
daemon 会对每个新会话返回 HTTP 503 和 `code: "session_limit_exceeded"`，直到
操作者手动关闭会话。

在长时间运行的 daemon 上这不是异常，而是常态：每个 GitHub 渠道事件都会创建一条
按 route 隔离的会话，渠道 bridge 会为它保持一个 SSE 事件泵。现有 idle reaper
拒绝关闭任何 `events.subscriberCount > 0` 的会话，于是这个事件泵会把会话永久钉住。
2026-11-07 `qwen-code` 就这样达到了 64/64；64 条全是空闲渠道会话，用户无法再创建
新会话。

## 2. 当前行为

- 对任何带有 live SSE 订阅者的会话，`entryIsAutoCloseCandidate` 都返回 false，
  不区分订阅者属于谁。
- 渠道 bridge 为每条缓存会话启动一个事件泵，并在 turn 结束后继续保留。
- 因此 reaper 永远看不到可回收的渠道会话，每个工作区的名额一直被执行到 daemon
  重启才释放。
- 释放对话框能力已经存在（`/release`），但只能通过输入命令打开，而且一次只能
  释放一条会话。

## 3. 目标

- 即使渠道自己持有的 SSE 事件泵仍挂着，也能回收空闲的渠道会话。
- 绝不关闭有本地工作、或被 child 报告为持有的会话。
- 对用户会话保留严格的 SSE 订阅者保护。
- 当上限仍然被触及时，给用户一个可见的恢复入口。

## 4. 非目标

- 在 `maxSessions` 边界做 LRU 驱逐。本设计不改准入；没有可回收会话时，工作区
  满仍然返回 503。
- 修改渠道 route 保留策略，或新增按渠道的会话上限。
- 在 turn、后台任务或待答交互仍活跃时释放会话。

## 5. 设计

### 5.1 渠道会话的 reaper 例外

`entryIsAutoCloseCandidate` 增加一个内部选项：

```ts
entryIsAutoCloseCandidate(entry, { allowChannelSubscribers: true });
```

订阅者保护改为：

```ts
if (
  entry.events.subscriberCount > 0 &&
  !(opts?.allowChannelSubscribers === true && entry.sourceType === 'channel')
) {
  return false;
}
```

只有会话 reaper 传入 `allowChannelSubscribers: true`。detach 关闭路径保留原
保护，因此仍有其他订阅者的用户会话不会因为一次部分 detach 被关闭。

其他保护全部不变：

- `entryCanStartConditionalClose` 仍会拒绝活跃 prompt、本地工作、进行中的
  restore，以及 active-work 上报不完整的 child。
- `childReportsHeldWork` 和 child 自己的条件关闭探针仍决定 child 是否持有工作。
- idle TTL 仍从 `sessionLastSeenAt` 起算，因此持续收到 turn 的渠道会话不会被回收。

reaper 关闭渠道会话后，渠道事件泵会收到终止事件并解除绑定。该 route 的下一条
消息会调用 `loadOrReplaceSession`，重新加载 transcript 或创建替代会话。

### 5.2 可见的恢复入口

workspace 创建失败时，`dispatchActionError` 现在把 `session_limit_exceeded`
作为 notice code 带出。Web Shell 观察到该 notice 后，在输入框上方渲染一个横幅，
提供「释放空闲会话」按钮。按钮会为当前锁定的工作区打开已有的
`ReleaseSessionDialog`。

对话框在有当前会话客户端时走该客户端释放；没有时回退到工作区 daemon
客户端。这个回退是必要的：横幅最常出现在空白的新会话页，此时还没有创建任何
会话客户端。

对话框不能复用侧栏默认的 source 过滤：该过滤会排除 `sourceType: "channel"`，
而这正是能占满名额的会话群体。恢复列表不带 source 过滤地查询工作区目录，再保留
default、channel、qwen-live 三类行；这既保留原有 live 会话行为，也暴露出渠道
会话。

会话或工作区变化、或用户关闭横幅时，横幅清除。这条路径只作为剩余 503 场景的
兜底（例如所有名额都被活跃工作占用），不替代自动回收。

## 6. 被否决的替代方案

| 替代方案                   | 不选的原因                                           |
| -------------------------- | ---------------------------------------------------- |
| 调大 `maxSessions`         | 只是推迟失败，并增加每工作区的内存占用。             |
| 准入时做 LRU 驱逐          | 行为改动更大；idle-reaper 设计里仍列为 P1 后续工作。 |
| 渠道侧 idle TTL            | 需要新增跨包的 bridge close 方法和按渠道配置。       |
| reaper 一律忽略 SSE 订阅者 | 会关闭用户仍开着标签页的会话，不可接受。             |

## 7. 风险与缓解

| 风险                                      | 缓解                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| 渠道会话在等待权限答复时被关闭            | child 的持有探针在工作未结束时拒绝关闭。                               |
| 后续消息丢失对话上下文                    | `loadOrReplaceSession` 会重新加载已持久化的 transcript，或创建新会话。 |
| 用户会话被新分支错误回收                  | 例外仅限 `sourceType === 'channel'`，并有对照测试钉住。                |
| 用户在 Web Shell 打开渠道会话后长时间空闲 | 会话会关闭，transcript 保留；重新打开时重新加载。                      |
| reaper 在 turn 进行中关闭渠道会话         | `entryCanStartConditionalClose` 在探针前就拒绝活跃 prompt。            |

## 8. 验证

- `packages/acp-bridge/src/bridge.test.ts`：
  - 渠道订阅者仍挂着时，空闲渠道会话会被回收；
  - 带订阅者的非渠道会话超过 TTL 后仍保留。
- `packages/web-shell/client/daemon/session/httpErrors.test.ts`：能识别
  `session_limit_exceeded`，并拒绝无关的 503 body。
- `packages/web-shell/client/daemon/session/actions.test.ts`：创建失败会发布
  一条 `create_session` notice，code 为 `session_limit_exceeded`；从空白新会话页
  释放时走工作区 daemon 客户端。
- `packages/web-shell/client/components/SessionLimitBanner.test.tsx`：横幅暴露
  释放和关闭两个动作。
- `packages/web-shell/client/hooks/useScopedSessions.test.tsx`：释放查询可以
  省略 source 过滤；侧栏默认仍应用过滤。
- `packages/web-shell/client/components/dialogs/ReleaseSessionDialog.test.tsx`：
  渠道会话会被列出，qwen-live 保留原有位置，agent 会话被排除。
- 在构建版 Web Shell 上对 `--max-sessions 1` 的 daemon 做真实浏览器验证：用
  真实 `sourceType: "channel"` 会话占满名额，提交 prompt 出现横幅、释放该
  渠道会话、再次创建成功。

## 9. 验收标准

1. 渠道会话空闲超过 `sessionIdleTimeoutMs` 后，即使渠道事件泵仍订阅，也会被关闭。
2. 带 live 订阅者的非渠道会话不会被 reaper 关闭。
3. 因工作区上限被拒绝的创建会显示可见的释放入口。
4. 释放一条空闲会话（包括工作区只被渠道会话占满的情况）后名额释放，下一次创建成功。
5. 现有 reaper 测试和 web-shell 类型检查通过。

## 10. 后续工作

- 在 `maxSessions` 边界实现 LRU 驱逐，使工作区满时可以回收空闲会话而不是返回
  503（已在 `docs/design/session-idle-reaper/README.md` 中列为 P1）。
- 如果渠道会话量超过共享 idle TTL 的承受范围，再考虑按渠道的保留策略。
