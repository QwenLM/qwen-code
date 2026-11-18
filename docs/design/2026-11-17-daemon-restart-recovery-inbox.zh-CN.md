# Daemon 重启恢复收件箱

[English](2026-11-17-daemon-restart-recovery-inbox.md) | [简体中文](2026-11-17-daemon-restart-recovery-inbox.zh-CN.md)

状态：本次改动已实现。包含只读扫描、两个恢复路由、daemon SDK 客户端方法、
Web Shell 面板以及 REST 参考/协议条目。下文代码引用使用符号名，不使用行号。

## 问题与范围

daemon 重启后，正在运行的会话会留下被中断的最后一轮。Web Shell 可以继续它，
但必须先打开该会话：恢复摘要由冷加载时按会话构建的 context 产生，提供操作的横幅
又位于聊天界面内部。当存在多个工作区和多个被中断会话时，用户需要在侧边栏里逐个
找到会话并点击“继续执行”。

本设计增加一个重启恢复收件箱：用只读扫描列出最后一个 prompt 被中断的会话，并用
批量继续接口恢复选中的集合，既不打开也不切换任何会话。扫描复用已有的 prompt
终端 ledger，继续复用已有的恢复分类器和 `continueSession` 准入路径，不引入新的
恢复算法。

范围为 workspace 会话。standalone 会话不在本次范围内，记录在“待定问题”中。

## 现状

- 恢复摘要按会话在冷加载后构建。`Session` 从最后一轮推导它，见
  `packages/cli/src/acp-integration/session/Session.ts`。ACP 状态类型只暴露
  `kind`、`canContinue` 和可选的 `cancellationConfirmationId`，见
  `packages/acp-bridge/src/status.ts`。
- Web Shell 只在已加载的会话内显示操作。`SessionRecoveryBanner` 读取
  `connection.context.recovery`，并调用绑定会话的 `continueSession`，见
  `packages/web-shell/client/components/SessionRecoveryBanner.tsx`。
- 会话列表无法回答哪些会话被中断。live state 是内存快照：能力清单的注释已说明
  这一点，见 `packages/sdk-typescript/src/daemon/capabilities.ts`；
  `DaemonSessionLiveState` 只包含活跃标记，见
  `packages/sdk-typescript/src/daemon/types.ts`。重启后快照为空。
- 继续操作要求会话已有内存条目。HTTP 路由 `POST /session/:id/continue` 见
  `packages/cli/src/serve/routes/session.ts`，它进入 `continueSession`，
  当 `byId` 中没有该会话时抛出 `SessionNotFoundError`，见
  `packages/acp-bridge/src/session-control-plane.ts`。因此必须先冷加载。
- 现有 Web Shell 续接设计明确排除了自动续接和新 daemon 路由
  （`docs/design/web-shell-interrupted-session-continue.zh-CN.md`）。
- core 已经能表达安全的自动续接，但没有任何地方启用它：`canAutoContinue` 只由
  `allowAutoContinue` 赋值，而没有调用方传 `true`，见
  `packages/core/src/core/session-recovery.ts`。
- prompt 终端 ledger 已经持久化了查找中断会话所需的证据。每个会话在 transcript
  旁边有一个只追加的 `<sessionId>.ledger.jsonl`，见
  `packages/core/src/services/sessionService.ts` 的 `getPromptLedgerPath`。记录有两种
  形状：进行中（`{ v, promptId, state: 'in_flight', at, tailUuid? }`）或终态
  （`{ v, promptId, terminal: 'completed' | 'cancelled' | 'error' | 'interrupted',
code?, stopReason?, at }`）。两种形状都不包含 prompt 内容，见
  `packages/acp-bridge/src/prompt-ledger.ts`。
- daemon 正常停机时会为待处理的 prompt 写入 `code: 'daemon_shutdown'` 的终态记录，
  见 `packages/acp-bridge/src/bridge-prompt-ledger.test.ts`。崩溃会留下没有终态的
  `in_flight` 记录；冷加载时由 `reconcileDanglingPromptTerminals` 对账，见
  `packages/cli/src/serve/prompt-terminal-ledger.ts`。

## 目标

1. daemon 重启后，无需加载或打开会话，就能看到哪些 workspace 会话被中断。
2. 用一次操作继续选中的会话集合，并为每个会话返回结果。
3. 不改变当前已打开的会话。
4. 证据缺失或存在歧义时按失败关闭处理，且永不继续历史缺失的会话。
5. 恢复列表不包含 prompt 内容。

## 非目标

- 启动时不自动续接。本次改动不启用 `allowAutoContinue`。
- 不新增持久化恢复文件。扫描读取已有 ledger。
- 不修改 core 恢复分类器，也不修改合成工具结果的修复逻辑。
- 不重放工具。`interrupted_turn` 的续接仍沿用现有行为：用合成错误结果关闭悬空调用。
- 不修改 daemon 停机 drain，也不修改单会话横幅的行为。
- 本次不覆盖 standalone 会话。

## 设计

### 扫描数据源

对每个选中的 workspace runtime，枚举活跃 chats 目录，读取每个
`<sessionId>.ledger.jsonl` 的 64 KiB 有界尾部。会话枚举复用已有的按项目列举逻辑，
它通过受控的 transcript 记录读取确认项目归属，再读取有界创建 metadata 来识别来源；
扫描从不回放 transcript 或加载会话。机器拥有的 `agent` 和 `agent-host` 来源类型会被省略，
与普通会话列表的隐藏规则一致。ledger 很小（每个 prompt 约两条记录），且在准入和停机时
已经写入，因此每个枚举会话在 metadata 扫描之外只需一次有界 ledger 读取。
扫描只能分类最新记录位于该有界尾部的 prompt；早于尾部的
`in_flight` 记录不会被本次扫描恢复（失败关闭）。

在产出条目前，路由会检查 runtime 的内存会话摘要，跳过 prompt 正在执行或排队的
会话。该检查不加载会话；这样 Web Shell 在回合运行中打开时，不会把活动回合误标为
重启中断。

把每个 ledger 按 `promptId` 归约到该 prompt 在尾部内最新的记录。只要尾部内任一
prompt 仍为 `in_flight`，会话就算中断，即使另一个 prompt 的终态在文件里更晚追加。
否则由尾部内最新的终态决定：

- `in_flight`：`interruption: 'in_flight'`。这覆盖崩溃，也覆盖前一个 prompt 已结算、
  后一个 prompt 仍在排队的会话。
- 终态为 `interrupted`：`interruption` 取记录的 `code`（如 `daemon_shutdown`、
  `daemon_lost`、`channel_closed`），`code` 不存在或不是不超过 64 个字符的小写标识符时
  取 `interrupted`。
- 终态为 `error` 且 `code` 为 `daemon_shutdown`、`daemon_lost` 或 `channel_closed`：
  daemon 或其子进程在 prompt 完成前结束，按该 code 列出。其他 `error`、`completed`
  和 `cancelled` 不列出。已完成或已取消的轮次不需要恢复，无关的报错轮次已经发布了
  结果。

不可读的 ledger 跳过（失败关闭）。尾部截断只丢失不完整的行：更早的有效记录仍能
决定结果，因此崩溃在写入中断前留下 `in_flight` 记录时仍会列出。被跳过的会话绝不
用猜测替代。跳过归档目录，丢弃早于请求时间窗的条目。每个 workspace 最多保留 200 条，
按时间倒序；超过时返回 `truncated: true`。枚举还沿用项目列表的 10,000 个会话文件上限：
达到上限后遍历停止，因此 `truncated` 不能证明所有中断会话都已被枚举。

扫描只报告 ledger 能证明的事实：某个 prompt 要么从未到达终态，要么到达了
`interrupted` 终态，要么以 `daemon_shutdown`、`channel_closed` 等 daemon 生命周期错误
结束。时间戳无法形成 ISO 值的记录按不可读处理并省略。它不断言该会话可以继续。
恢复类型和 `canContinue` 判定仍在加载后由已有分类器给出。

### 只读批量路由

沿用 `POST /sessions/live-state` 已有的 workspace 批量形状
（`packages/cli/src/serve/routes/session.ts`）：1–20 个 workspace 选择器、
逐成员结果，以及相同的 `workspace_not_found`、`untrusted_workspace`、
`workspace_runtime_unavailable` 错误。该路由由 `restart_recovery` 能力标签公布，
该标签同时覆盖续接路由。

`POST /sessions/recovery`

```json
{
  "workspaces": ["qwen-code-x9", "/home/user/Work/other"],
  "sinceMs": 86400000
}
```

```json
{
  "workspaces": [
    {
      "workspace": "qwen-code-x9",
      "workspaceId": "…",
      "cwd": "/home/user/git/qwen-code-x9",
      "items": [
        {
          "sessionId": "…",
          "lastActivityAt": "2026-11-17T09:12:31.000Z",
          "interruption": "daemon_shutdown"
        }
      ],
      "truncated": false
    }
  ]
}
```

`sinceMs` 可选，默认 24 小时，服务端上限为 30 天。响应刻意不包含 prompt 文本、
工具名和 `canContinue`。已经持有会话 catalog 的调用方可以从 catalog 解析标题；
本面板按 workspace 和缩短的会话 id 标识每一行。

### 批量继续路由

`POST /sessions/recovery/continue`

```json
{
  "sessions": [{ "workspace": "qwen-code-x9", "sessionId": "…" }],
  "confirmToolTurn": false
}
```

服务端串行处理列表，每次请求最多 10 个会话。对每个条目：

1. 重新读取该会话的 ledger。如果没有 prompt 仍为 `in_flight`，且最新终态为
   `completed`、`cancelled` 或无关的 `error`，返回 `not_continuable` 和
   `code: 'already_moved'`。这覆盖扫描后被其他客户端继续到已结算轮次的会话。新的
   `in_flight` 记录表示轮次正在执行；第 5 步的 `canContinue` 检查会拒绝它。
   `daemon_shutdown`、`daemon_lost`、`channel_closed` 终态仍可恢复。
2. 只从请求指定的 workspace 选择器解析 runtime，应用 workspace 信任、runtime generation
   与 archive 协调守卫；不从会话 id 解析归属，也不回退到主运行环境。与
   `POST /session/:id/continue` 不同，本批量路由不把 standalone 会话转交
   `standaloneSessionService`。持有与该路由相同的 archive shared lock，使归档或删除不能
   与 ledger 重读、恢复或派发竞争。standalone 会话不在范围内，会在冷加载时失败。
   对持久化、已加载或刚恢复会话的来源 metadata 应用隐藏 `agent` / `agent-host` 规则，
   使续接不能绕过列表的排除规则。metadata 不可读时返回 `metadata_unreadable`，不进入恢复，
   不会把无法判定来源的会话当成普通的无来源会话。仅在 ledger 分类选出恢复候选后读取来源，
   不为每个已结清或没有 ledger 的会话做来源检查。
3. 会话不在内存时，运行与 `POST /session/:id/load` 相同的冷恢复核心。不引入第二套
   加载路径。恢复过程产生的临时客户端 attachment 在续接请求返回时释放，无论接受还是
   拒绝。接受时 prompt 已先进入 pending，因此会保持会话打开；在派发前释放才会让空闲
   关闭路径拆掉刚加载的会话。
4. 通过与横幅相同的 bridge 状态路径读取恢复摘要。
5. `canContinue` 为 false 时返回 `not_continuable` 和 `kind`。这包括
   `degraded_history` 以及仍在执行的会话。
6. 第 2 步的来源检查同时用于持久化创建 metadata 和已加载或刚恢复的会话摘要。ledger 仍为 interrupted 时，直接请求
   `agent` 或 `agent-host` 会话返回 `not_continuable` 与 `code: 'hidden_session'`，
   不能绕过扫描的排除规则。ledger 缺失或已结清时仍返回此前的结果。
7. 存在 `cancellationConfirmationId` 时返回 `confirmation_required`。批量操作绝不能
   自动确认一个可能被用户主动取消的轮次；该批量请求不携带此确认，因此客户端引导
   用户到会话内确认。
8. `kind` 为 `interrupted_turn` 且 `confirmToolTurn` 不为 `true` 时返回
   `confirmation_required`。调用方可以带 `confirmToolTurn: true` 重新提交这些会话。
9. 其余情况调用已有的 `continueSession` 路径，传入被授权的中断类型和所选 generation 的
   断言。bridge 在异步预检后只接受实际中断类型与授权相符的续接；如需另一种确认，
   返回新的分类。该断言还经排队 prompt 准入传递到 ACP 派发边界，避免 runtime 开始替换或
   draining 后仍继续向旧 runtime 派发。同一 fence 重读当前 live 来源，发现 agent 在等待期间
   接管会话时拒绝续接，不复用此前的普通来源快照。扫描侧先过滤来源，再应用可见结果
   200 条上限；最多 4 个来源检查并发执行，保持结果顺序。`truncated` 按过滤后的可见
   候选计算。批量路径要求 bridge 确认第一次 ACP 写入，派发 fence 失败会映射为逐会话错误，
   不会误报 accepted。确认止于写入开始，不等待模型回合结束。未请求该确认的既有续接保持
   原有异步接受语义。

结果按会话返回：

```json
{
  "results": [
    {
      "sessionId": "…",
      "workspace": "qwen-code-x9",
      "status": "accepted",
      "kind": "interrupted_prompt"
    },
    {
      "sessionId": "…",
      "workspace": "qwen-code-x9",
      "status": "confirmation_required",
      "kind": "interrupted_turn"
    },
    {
      "sessionId": "…",
      "workspace": "qwen-code-x9",
      "status": "not_continuable",
      "kind": "degraded_history"
    },
    {
      "sessionId": "…",
      "workspace": "qwen-code-x9",
      "status": "error",
      "code": "continue_failed"
    }
  ]
}
```

`status` 取 `accepted`、`not_continuable`、`confirmation_required`、`rejected` 或
`error`。`not_continuable` 携带 `already_moved`、`no_evidence`、`virtual_subagent`、
`invalid_session_id`（id 不符合持久化会话文件形状）、
`hidden_session`（来源为 `agent` 或 `agent-host`）或 `metadata_unreadable`
（创建 metadata 不可读，来源无法判定，直接拒绝而不加载）；`confirmation_required` 携带
`cancellation_confirmation` 或 `tool_turn`；`error` 携带 `workspace_not_found`、
`untrusted_workspace`、`workspace_runtime_unavailable`、`session_not_found`、
`daemon_draining`、`session_archiving`、`session_id_conflict`、
`session_workspace_conflict`、`session_id_admission_unavailable` 或
`continue_failed`。draining 和 archiving 是可重试的暂时冲突，不是永久续接失败。

单个失败不阻断其余条目。不保留客户端连接，也不建立 SSE 订阅；轮次在普通 prompt 准入
下运行，之后任何打开该会话的客户端都能读取其事件。

### Web Shell 界面

- daemon 可用性从不可用变为可用后，对当前 workspace 锁定范围内可见的受信任 workspace
  请求一次批量扫描，与侧边栏使用相同的清单范围。
- 有条目时，在会话列表上方显示横幅：“上次重启中断了 N 个任务”。展开后显示面板。
- 每行显示 workspace 标签、缩短的会话 id、最后活动时间和中断徽标。当前会话永不切换。
- 扫描结果达到上限并截断时，即使所有可见行已被接受，也保留提示和显式重扫操作。
  不自动继续因扫描上限而未显示的条目。
- 可用性、能力、workspace 范围或 client 变化会使旧的续接回调整体失效，不能用旧结果
  恢复或覆盖已禁用或刚重置的面板。
- 行内“继续”只提交该会话；“全部继续”按每批 10 个提交不需要工具确认的行。返回
  `accepted` 的行从面板移除；返回 `confirmation_required` 的行保留并显示确认操作；
  失败的行保留并显示原因。取消确认的行保留并提示到会话内确认；批量永不自动确认。
- 确认操作只重新提交工具轮次的行，并带 `confirmToolTurn: true`；同时说明未完成的
  工具调用会在模型继续前被标记为失败。

### 限制与安全

- 每次继续批量最多 10 个会话，每次扫描最多 20 个 workspace。
- 只串行加载。加载会话会占用每 workspace 的会话名额（默认 32）和内存；上限避免
  一次重启把所有旧会话同时拉入内存。
- 只扫描受信任的 workspace；不受信任和不可用的成员返回与 live state 相同的错误。
  有活跃或排队 prompt 的会话通过 runtime 的内存摘要跳过。
- 扫描不读取 prompt 内容，响应也不携带。
- 永不继续 `degraded_history`。
- 取消确认永不自动通过；该行保留并提示到会话内确认。
- 重复的批量请求不会重复入队：会话有活跃 prompt 时，bridge 准入检查会拒绝续接；
  ledger 重读也会丢弃已经前进的会话。
- “全部继续”把超过 10 个的合格行拆成连续批次。

### SDK 客户端

`DaemonClient.getRestartRecoveries` 封装 `POST /sessions/recovery`，
`DaemonClient.continueRestartRecoveries` 封装
`POST /sessions/recovery/continue`。两者都使用原生 REST 传输，接受
`{ signal, timeoutMs }`；旧版 daemon 会返回该路由的 HTTP 错误，而不是回退到其他
端点。

## 设计决策

- **使用 ledger，而不是 transcript 或 catalog 启发式。** ledger 已经区分中断的
  prompt 与正常结束、取消或无关报错的 prompt，而且体积很小。扫描 transcript 尾部会
  重复中断分类器；catalog 启发式完全看不到 prompt 结果。
- **批量查询沿用 live state 的形状。** 复用 workspace 批量形状可以让信任、归属和
  错误语义与已有路由保持一致，而不是另造一个全局扫描。
- **批量继续在服务端执行。** Web Shell 的 `loadSession` 和 `resumeSession` 操作会切换
  当前会话（见 `packages/web-shell/client/daemon/session/actions.ts`），客户端循环
  会把用户在不同会话之间来回拖动。服务端循环也让其他 SDK 客户端获得同样能力。
- **工具轮次需要显式批量确认。** 单会话横幅目前不询问；批量路径是无人值守的，且
  可能一次恢复多个会话，因此在关闭悬空工具调用并让模型重试之前先询问。
- **不自动续接。** 重启路径正是无人值守重试代价最高、最可能重复副作用的地方。
  未来的可选项可以建立在 `allowAutoContinue` 之上；本次不包含。

## 约束与风险

- 继续 N 个会话会消耗 N 轮模型 token。面板显示数量并要求用户选择；没有“开机全部
  继续”。
- 长会话在继续后会把上下文保留在内存中，直到现有空闲回收器关闭它。如果主机在意
  这一点，运维可以调低批量上限。
- ledger 是尽力而为的证据。缺失、截断或不可读的 ledger 按失败关闭处理：不列出该
  会话，而不是猜测。
- 批量执行期间崩溃会留下“前面的会话已继续、后面的未继续”的状态。逐会话结果是权威
  依据；重试会重读 ledger 并跳过已经前进的会话。
- 按设计列表没有 prompt 文本，也没有标题；面板按 workspace 和缩短的会话 id 标识
  每一行。已经持有 catalog 的调用方可以从 catalog 解析标题。
- 默认 24 小时窗口是产品选择，不是正确性规则。更早的中断会话仍可从它自己的聊天
  界面继续。

## 文件与边界

- `packages/cli/src/serve`：本次实现 ledger 扫描器和两个恢复路由。聚焦测试覆盖
  扫描、查询与续接路由。
- `packages/acp-bridge`：在续接准入时复核调用方已授权的中断类型与 generation，并传递
  已有的派发 fence。未提供这些续接上下文字段的已有调用行为保持不变；真实 bridge 测试覆盖
  延迟分类和排队派发边界。
- `packages/sdk-typescript/src/daemon`：请求/响应类型、客户端方法、导出及测试。
- `packages/web-shell/client`：恢复面板、可用性门控、国际化及测试。
- `docs/developers/daemon-rest-api-reference.md`、
  `docs/developers/qwen-serve-protocol.md`、SDK 客户端指南，以及能力 parity/契约测试。
  OpenAPI 只覆盖核心指南操作，因此恢复路由不加入其中。
- 不修改 core，不新增持久化文件。

## 验证计划

1. 用以下形状单测扫描器：悬空 `in_flight`；前一个 prompt 后来完成、后一个仍在排队的
   prompt；带 `daemon_shutdown` 的 `interrupted`；带 `daemon_lost` 的 `interrupted`；
   带 `daemon_shutdown`、`channel_closed` 的 `error` 终态；无关的 `error` 终态；
   正在执行的活动 prompt；最后一个 prompt 为 `completed`；最后一个 prompt 为
   `cancelled`；多个 prompt 中较早的一个被中断；ledger 缺失；尾部截断；ledger 尾部
   过大；尾部之外的陈旧 `in_flight`；归档会话；窗口之外的条目；以及恰好 200 条的上限。
2. 路由测试扫描批量：1–20 个选择器、超限批量、未知 workspace、不受信任 workspace、
   runtime 不可用、逐成员失败、稳定排序、`sinceMs` 的钳制、归档排除、活动 prompt
   排除、隐藏 `agent` / `agent-host` 排除，以及 transcript 记录 id 不符合持久化 id 的情况。
3. 路由测试继续批量：串行顺序、逐会话结果、`already_moved`、`degraded_history`、
   活跃轮次、取消确认、不带与带 `confirmToolTurn` 的 `interrupted_turn`、预检后工具轮次
   分类变化、ACP 派发前 generation 关闭、隐藏 `agent` / `agent-host` 会话、加载失败、
   非 accepted 路径的 detach，以及 10 个会话上限。
4. 端到端：启动真实 daemon，开始一轮，杀掉 daemon 进程，重启，查询恢复批量，继续
   一个会话，并断言其 transcript 出现新轮次。SIGKILL（`in_flight`）和 SIGTERM
   （`daemon_shutdown`）两种情形都已提交在
   `integration-tests/cli/qwen-serve-restart-recovery.test.ts`。
5. Web Shell 测试：横幅只在可用性恢复后出现，选择与确认路径可用，成功的行从面板
   移除，失败的行保留并显示原因，取消确认引导到会话内，未知 code 有本地化回退，
   “全部继续”按 10 条分批，当前会话不改变。
6. 运行相关包的单测、构建、类型检查和 REST 契约测试。

## 验收标准

1. 重启后，一个被中断的 workspace 会话无需打开或加载即可出现在恢复扫描中。
2. 继续选中的集合，每个被接受的会话产生一个新轮次，每个请求的会话产生一条结果。
3. 批量继续不改变当前已打开的会话。
4. 没有 `confirmToolTurn: true` 时，批量不继续 `interrupted_turn`。
5. `degraded_history`、归档会话、正常结束会话、已取消会话和不可读 ledger 永远不会
   被列为可继续。
6. 不受信任的 workspace、未知 workspace、未知会话和超限批量都按文档中的错误码拒绝。
7. 现有单会话 `POST /session/:id/continue` 行为不变。
8. 响应和日志不包含 prompt 内容。

## 待定问题

- standalone 会话是否使用同一个收件箱？它们的 chats 目录和归属规则不同，需要单独的
  归属决策。
- 扫描是否应按“本次 daemon 重启”而不是时间窗来判定？这需要持久化的停机/启动标记；
  仅靠 ledger 无法区分旧中断和最近一次中断。
- daemon 是否应随列表返回 catalog 标题，还是把标题解析留给客户端？本设计留给客户端，
  以避免在扫描路径上读取 catalog。
- 批量继续是在轮次结束后立即关闭已加载的会话，还是交给空闲回收器？首个版本交给
  回收器，这样用户可以打开结果而不触发冷加载。
