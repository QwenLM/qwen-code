# Web Shell：首条 prompt 在会话切换后仍然执行

[English](web-shell-first-prompt-navigation.md) | [简体中文](web-shell-first-prompt-navigation.zh-CN.md)

状态：已实现（2026-11-08）

## 问题

Web Shell 的新聊天是草稿态：首条 prompt 提交时才真正创建 daemon 会话。
如果用户提交 prompt 后、创建尚在途时快速点击另一个会话，会话会在 daemon
上创建成功（出现在侧边栏），但 prompt 永远不会被派发。用户看到一个空转
的会话，以及一条被静默丢弃的 prompt。

## 现状

三层守卫叠加导致提交被丢弃：

1. `packages/web-shell/client/daemon/session/actions.ts` — `createSession`
   在 detached create 返回后计算 `userMovedAway`。当连接已移动（或会话被
   手动清除）时，detach 已创建的客户端并抛出
   `AbortError('Session creation interrupted')`。daemon 侧会话存活但空转。
2. `packages/web-shell/client/utils/sessionPreparation.ts` —
   `createAndAttachSessionForPrompt` 在 attach 前后校验当前会话身份，
   身份变化即中止。
3. `packages/web-shell/client/App.tsx` — `sendPrompt` 在
   `ensureSessionForPrompt` 之后复查 `admissionSourceIsCurrent`；用户已
   离开时直接返回、不派发。`submitPromptFromEditor` 的 catch 又因 admission
   owner 不再匹配而吞掉错误。

这些守卫的存在是为了让慢创建不能劫持导航（`actions.test.ts` 的
"does not replace navigation after a slow detached create" 钉住了该行为）。
该目标保留；改变的是已提交 prompt 的命运。

## 目标

- 首条 prompt 一旦提交，即使用户在创建期间导航离开，也要派发到为它新建
  的会话。turn 在 daemon 后台运行，与"在已有会话发送后切走"完全一致。
- 导航绝不阻塞、绝不劫持：用户停留在点击的会话；新建会话不抢占连接。
- 派发成功后草稿输入被消费（走 `commitAccepted` 已有的 `sourceChanged`
  分支）；失败则保留，prompt 既不重复也不静默丢失。

## 非目标

- 不改变非 prompt 的 `createSession` 调用方（如 `resolveSessionForWorkspace`）
  的 `userMovedAway` 行为：它们仍在导航时中止。
- detached prompt 不写乐观 transcript 块：可见 transcript 属于另一个会话。
  打开新建会话时从 daemon 回放已准入的 prompt。
- detached 路径不等待 turn 完成；准入（admission）即交付保证。

## 方案

### `createSession` 为 prompt 流保留已创建的客户端

新增选项 `keepOnNavigation?: boolean` 与结果容器
`navigationOutcome?: { bound: boolean }`。在 detached-create 分支中，当
`manualSessionClearRef.current || userMovedAway` 且设置了 `keepOnNavigation`
时，`createSession` 返回已创建的客户端但不绑定（跳过 `sessionRef`、
`setConnection`、stable-client-id 持久化），并置
`navigationOutcome.bound = false`。其余路径不变。

### `createAndAttachSessionForPrompt` 增加 detached 准备路径

该 helper 只被首条 prompt 流使用，因此总是传 `keepOnNavigation: true`。
当结果表明客户端未绑定时：

- `onSessionAllocated` 照常触发（catalog 临时标题、分配记账）。
- `onSessionCreated` 收到第二个参数——已创建的客户端；App 回调改用
  `client.updateMetadata` 改名，而不是 `sessionActions.renameSession`
  （后者指向当前会话），catalog/host 通知不变。
- 跳过 attach 与身份校验。模型、Plan 模式、推理强度通过已创建的客户端
  应用（`setModel`、`client.setSessionApprovalMode`、
  `setConfigOption('reasoning_effort')`），失败语义与 attached 路径一致
  （仅当存在模型绑定的推理选择时，模型切换失败才致命）。
- 结果携带 `detachedSession`（已创建的客户端）。准备失败通过该客户端
  （`close()`）释放会话，而不是走指向当前会话的
  `sessionActions.releaseSession`。

### `ensureSessionForPrompt` 返回分配结果

返回形状从 `string | undefined` 变为
`{ sessionId: string; detachedSession?: DaemonSession } | undefined`。
各调用点：

- `sendPrompt`：存在 `detachedSession` 时，通过新的 `sendDetachedPrompt`
  action（见下）派发，然后走导航安全的 `commitComposerAccepted` 消费草稿、
  发出 host 的 `submit` 会话变更、调用
  `sessionCatalogController.promptAdmitted`。失败无论当前 owner 是谁都
  toast 报错，并将 catalog 准入标记为不确定；草稿文本保留。
- `!cmd` shell 流：通过 `detachedSession.shellCommand` 派发，随后 detach
  客户端。
- `/goal` 与 Goals 对话框：`createGoalForAllocatedSession` 本就按 id 定位
  会话，detached 分配直接继续；客户端立即 detach（按 id 派发根本不使用
  它）；detached 时跳过本地 transcript 回显。
- `ensureAgentMentionSession`：只消费 `sessionId`，并立即 detach 客户端；
  mention 通过 workspace 级路由按 id 发送。

每个收到 unbound 客户端的调用方都必须释放它：客户端是 daemon 侧的活注册，
`POST /session/:id/detach` 是唯一的释放方式。prompt 与 shell 在派发落定后
detach；goal 与 mention 在分配时即 detach，因为它们的派发不经过客户端。

两条导航不变式约束 detached 路径：

- **分配复用按草稿作用域。** 在途创建只被同一 composer source generation
  的提交复用；新草稿（New session 会 bump generation）创建自己的会话，
  不继承在途分配，因此两个草稿的 prompt 不会落到同一会话。
- **detached goal 状态不向本地发布。** detached goal 按 id 在自己的会话
  创建；本地 goal strip 发布（把无会话连接当作即将成为的草稿）对
  detached 分配被抑制，无关新草稿不会显示别的会话的 goal。

### `sendDetachedPrompt` action

`actions.ts` 中新增的"仅准入"action，在 `types.ts` 中声明类型：

- 复用 `normalizePromptFiles`、`discardsSlashCommandAttachments`（注入
  当前会话谓词，使 detached 客户端可以通过；初始命令快照按客户端身份
  取值，detached 派发只按新建会话自己的命令表分类，绝不读导航去的
  会话）、`promptContentWithUploadedAttachments` 上传附件。
- 构造与 `sendPrompt` 相同的 prompt 请求（`eventDetailMode`、
  `_meta.qwen.submittedPrompt`、`inputAnnotations`、`retry`），通过
  `session.submitPrompt`（非阻塞准入）提交。
- 绝不写 transcript store、prompt status 或 connection 状态。
- 触发 `onAdmissionStarted` / `onAdmitted`；明确拒绝时移除已上传附件；
  `finally` 中 detach 客户端。daemon 保留会话并运行 turn；之后的
  `loadSession` 会重新 attach。

## 设计决策

- **在准入时派发，而非等 turn 完成。** 与已有会话语义一致：daemon 一旦
  接受 prompt，切走就是安全的。
- **用结果容器，而不是在 create 后读连接。** actions 工厂拿到的是原始
  React `setConnection`；连接 ref 可能落后一次渲染，只有 `createSession`
  自己知道是否绑定了客户端。
- **detached 路径不写 store。** 可见 transcript 属于用户导航去的会话；
  往里注入 user 块会污染它。
- **派发失败保留会话。** 准入可能不确定；会话留在 catalog，用户可以查看
  或重发。只有准备失败（尚未派发）才释放会话。

## 约束与风险

- detached 客户端在每条流里都是短命的：prompt 与 shell 在派发落定后
  detach，goal 与 mention 在分配后立即 detach。turn 的事件流在用户打开
  会话时接上（或经 background-turn live state）。
- 后台 turn 通知的对等性是后续工作：provider 的 `turnNotifications.admit`
  受当前会话门禁限制，其观察器只观察当前会话的事件，因此 detached 首条
  prompt 不会登记"后台 turn 完成"通知。prompt 本身已交付并运行；通知对等
  需要单独改动准入门禁与 scope 生命周期。
- `registerAcceptedAttachmentSources` 自带 `sessionRef.current` 守卫，
  对 detached 客户端是 no-op；source 装饰本就是尽力而为。
- 斜杠命令附件分类仅在客户端是当前会话时读连接的命令快照；detached
  客户端从未解析状态起步、从自身读 `supportedCommands`，因此导航去
  会话命令表里的同名命令不会丢弃新建会话的附件。结果绝不发布到
  当前连接。
- 残余窗口：点击落在 create 已返回并绑定连接之后、导航尚未发布之前，
  仍走 attached 路径的身份校验（行为不变）。被报告的竞态——create 在途
  时点击——走 detached 路径。

## 验证计划

- E2E（mock daemon，确定性）：`client/e2e/web-shell.first-prompt-switch.spec.ts`
  扣住 `POST /session`，提交 prompt、点击另一个会话、放行 create；断言
  prompt 到达新建会话且 URL 停留在被点击的会话。修复前已复现红灯。
- 单元：`actions.test.ts`（未绑定 create 结果、detached 派发的准入与清理）、
  `sessionPreparation.test.ts`（detached 准备跳过 attach、经客户端应用设置、
  失败时释放）、`App.test.tsx`（草稿提交 + 导航走 detached 派发、消费草稿、
  当前 transcript 保持干净）。
- 既有导航守卫测试对非 prompt 创建必须保持绿灯。

## 验收标准

- 提交首条 prompt 并在创建期间切换会话，prompt 派发到新建会话；turn 后台
  运行。
- 用户的导航目标绝不被新建会话替换。
- 派发失败时草稿文本保留，并向用户报错。
- 非 prompt 的 `createSession` 导航行为不变。
