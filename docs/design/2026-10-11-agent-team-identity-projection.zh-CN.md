# Agent 身份投射（PR 13902 / #13785）

- [English version](./2026-10-11-agent-team-identity-projection.md)

## 问题

子 agent 的思考、消息和工具帧在 ACP/daemon 链路上缺少生产者身份。持久化的 `task_execution` 结果保留了 `subagentName`，但重放没有把它恢复到 transcript 帧。

## 设计

每条投射帧都可携带 `_meta.agent`；SDK 将其保留为 `block.agent`：

```ts
interface AgentIdentity {
  agentName: string;
  depth: number;
  kind: 'root' | 'subagent' | 'teammate';
}
```

这一共享形状为下一层预留 teammate kind。本层仅实现 subagent 生产者及其消费方。

- Live 跟踪使用运行时 `start` 事件解析后的名字给思考、消息、工具调用及更新帧盖身份，保留定义名的大小写。
- 重放从经过验证的 `task_execution` display 名重建深度为 1 的 `/root/<type>`。被阻止的原始名字及非法路径段保持无归因；已准入的失败、取消及后台结果保留身份。
- SDK 通过 normalizer 和 transcript reducer 传递身份，包括结束结果为最初无归因的工具块补齐身份的情况。live journal 压缩接受 agent stamp。
- Web Shell 在子 agent 面板名字的 `title` tooltip 中提供路径。

## 决策与约束

`agentName` 是可读的角色路径，不是唯一执行 ID。同类型并发子 agent 共享路径；消费方使用 `parentToolCallId` 区分执行。持久化结果不包含类型名之外的谱系，因此重放只重建根挂靠身份。前台嵌套帧投射及谱系持久化仍是独立工作。

## 验收

配套测试覆盖 live 实际名字、默认身份、重放名字与状态边界、SDK 归一化与补齐、journal 压缩，以及无可见路径 chip 的 tooltip。测试、类型检查及构建需要针对本次拆分提交重新执行；原 PR 的历史结果不能验证这个新候选。

## 后续层

下一层增加持久 Team 报告、成员变更通知及会话级审批。第三层增加仅展示的队友活动及 agent 间消息方向。本层尚未交付这两类行为。
