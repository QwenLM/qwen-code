# Agent 身份与团队协作投射（PR 13902 / #13785）

- [English version](./2026-10-11-agent-team-identity-projection.md)

## 问题

多 agent 会话的输出在 ACP/daemon 链路上无法归因。运行时存在两条本质不同的协作链路，但都缺少身份维度：

1. **子 agent 委派**（父 spawn 子）：运行时已投射思考/工具/消息帧，但没有一帧标明是哪个 agent 产的。reload 后 `task_execution` 工具结果里有 `subagentName`，transcript 帧上却没有。
2. **Agent Teams**（对等队友）：队友报告与花名册变更以纯文本进入 leader 的后台通知队列。持久化完全丢掉生产者，重放无身份可恢复，Web Shell 渲染匿名行。

## 设计

### 单一身份形状，两种 kind

每条投射帧都可携带 `_meta.agent`（SDK transcript block：`block.agent`）：

```ts
interface AgentIdentity {
  agentName: string; // 路径式：/root、/root/security
  depth: number; // 0 根，1 直接子 agent/队友
  kind: 'root' | 'subagent' | 'teammate';
}
```

形状镜像 OpenAI Responses multi-agent 契约（每个 item 带 `agent: { agent_name }`，路径式命名），遵循本仓库「借形状不借拼写」规则 —— 字段名 camelCase、落位本 wire 的 `_meta`。`kind` 区分两条链路：subagent 身份来自 `task_execution` display（重放）或 live spawn（线上）；teammate 身份在入队点由报告发送方或花名册成员铸造。

### 子 agent 链路

- **Live**：ACP bridge 给每条子 agent 投射帧（思考、消息、工具调用、工具更新）盖 `_meta.agent`。
- **Reload**：`transcript-replay.ts` 从持久化的 `task_execution` display 重建身份（`subagentName` → `/root/<type>`，`kind: 'subagent'`）。只有根挂靠 —— 持久化记录不携带类型名之外的谱系。

### 队友链路

- **报告与花名册变更**以 `kind: 'peer'` 后台通知入队，带 `agent`（生产者）与 `label`（发送方名字，渲染在 turn marker 上）。持久化保存在 `backgroundTask.agent` 内；重放提升到帧级 `_meta.agent`，live 与 reload 帧同形，SDK reducer 的 `block.agent` 路径两边一致。
- **活动与 agent 间消息**是独立的 display-only 投射（本 PR 新增）：
  - `TeamManager` 事件桥早已观察每个队友的工具调用/结果 —— 之前只当活跃度心跳用完即弃。新 `TEAMMATE_ACTIVITY` 事件转发 `{name, toolName, phase, description, success}`。
  - team sink 同时订阅 `MESSAGE_SENT`（`{from, to, message}`）—— 双向，含队友→队友。
  - Session 把两者发布为 `_meta.source = 'teammate_activity'` 的 `agent_message_chunk` 帧，**不入通知队列、不持久化**。理由：活动是观察性的 —— 每个入队的 peer 项都会把 leader 唤醒进一次自动轮次（每事件一个模型回合），而每个队友 turn 20+ 条工具事件会淹没队列。队友最终发出的报告才是 transcript 必须保留的；逐工具活动与 PR 已对状态/idle 事件的处理同理，是 ephemeral 的。
  - 方向跟随 OpenAI 的 `agent_message`：帧的 `agent` 标**接收方**（发给 leader 时为 `/root`），结构化 `backgroundTask.author` 携带发送方（leader 为 `/root`、depth 0、`kind: 'root'`）。`toolName`/`phase`/`success` 走同一结构化负载。

### Web Shell

- Peer 通知渲染为系统气泡，带从 `block.agent` 派生的 `@name` chip（仅 teammate kind）。
- `teammate_activity` 帧归类为带归因的通知而非 leader 文本；方向由行文（`writer → researcher: …`）表达，接收方 chip 承载归因，wire 的 `author` 字段服务程序化消费方。（试过 `from @x` 发送方 chip 后移除 —— 与行文重复。）

## 决策

1. **`block.agent` 是 peer 归因的唯一事实来源** —— 不解析文本，不搞平行的 `data.agent` 键（早期本地变体已弃，采用远端 prop 设计）。
2. **活动永不唤醒 leader、永不持久化。** 两者都是刻意的：队列语义使每个 peer 项都是自动轮次触发器，而 transcript 的职责是持久报告，不是逐工具噪音。
3. **Ephemeral 是文档化的，不是隐藏的** —— reload 后报告/花名册行保持归因；活动行消失。follow-up 清单记录了「按队友持久化活动摘要」为候选改进。
4. **同一 manager 实例的重复通知是 no-op**：`Config.setTeamManager` 对同一对象也触发变更回调，重复注册五个监听器会导致审批翻倍且 detach 泄漏（review 发现，已修并加回归测试）。

## 已知缺口（follow-up，不属本 PR）

- CJK 队友名在 `sanitizeName` 中塌缩（main 既有行为）：`研究员` 清洗为空，模型改用 ASCII 重试。身份投射本身对非 ASCII 路径无碍（拼音名 + 中文消息内容已验证）。
- 按队友的持久化活动摘要；队友颜色启用；活动折叠分组（业界调研：Claude Code 折叠空闲行、LangGraph 密度滑块、ChatGPT Active/Done 面板 —— 没有一家把工具行平铺进主视图）。

## 验收

- 单测：cli Session（1215）/ team-sink（11）；web-shell adapter（233）+ SystemMessage（71）；sdk agent-identity（13）；acp-bridge transcript-replay（153）；core team（356）。
- E2E：`.qwen/e2e-tests/pr13902-teammate-activity-projection.md` —— 真实 daemon 跑覆盖多队友归因、活动不唤醒 leader、结构化方向（接收方+author）、中文内容、reload 归因。
