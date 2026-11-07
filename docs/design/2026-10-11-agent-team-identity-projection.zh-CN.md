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

第一层建立这一共享形状及 subagent 生产者。第二层增加报告、成员通知及审批的 teammate 生产者。

- Live 跟踪使用运行时 `start` 事件解析后的名字给思考、消息、工具调用及更新帧盖身份，保留定义名的大小写。
- 重放从经过验证的 `task_execution` display 名重建深度为 1 的 `/root/<type>`。被阻止的原始名字及非法路径段保持无归因；已准入的失败、取消及后台结果保留身份。
- SDK 通过 normalizer 和 transcript reducer 传递身份，包括结束结果为最初无归因的工具块补齐身份的情况。live journal 压缩接受 agent stamp。
- Web Shell 在子 agent 面板名字的 `title` tooltip 中提供路径。

## 决策与约束

`agentName` 是可读的角色路径，不是唯一执行 ID。同类型并发子 agent 共享路径；消费方使用 `parentToolCallId` 区分执行。持久化结果不包含类型名之外的谱系，因此重放只重建根挂靠身份。前台嵌套帧投射及谱系持久化仍是独立工作。

## 验收

配套测试覆盖 live 实际名字、默认身份、重放名字与状态边界、SDK 归一化与补齐、journal 压缩，以及无可见路径 chip 的 tooltip。测试、类型检查及构建需要针对本次拆分提交重新执行；原 PR 的历史结果不能验证这个新候选。

## Team 协调

第二层消费共享身份契约。ACP Team sink 挂接当前 TeamManager，通过现有 peer 通知队列传递持久报告及成员加入/退出通知。发送者使用规范名归因，经过验证的身份通过录制与重放保留；Web Shell 在报告、成员通知及关联的轮次开始行标注队友。成员通知与报告共享投递及持久化路径；状态/idle 脉冲不进入 sink。

队友审批直接到达 host，独立于 leader 权限队列。每个请求具有 UUID 和会话范围；会话生命周期、binding epoch、manager 替换及队友退出负责撤回过期请求。host 请求失败与答复后队友响应失败分开处理，bridge 所有权策略控制会话边界。

未排空的 peer 报告保持待处理工作。可逆关闭、队列溢出及关机 flush 保存未投递报告，重复 flush 不重复录制。冷录制和暖通知 envelope 保留 peer 语义、XML 转义、rewind 与恢复行为。删除 Team 会发送剩余成员退出事件。

## 决策与约束

Team sink 依赖共享身份形状，不依赖 subagent 运行时。本层注册 approval、joined 和 exited 三个监听器；同一个 manager 重复通知不能重复注册。报告和成员通知可以唤醒 leader 并会被持久化；逐工具进展尚未进入本层。

## 新增验收

配套测试覆盖投递、持久化、可逆关闭、溢出、flush 幂等、成员变更、规范发送者、审批策略及生命周期、host 所有权、rewind/恢复及界面归因。新拆分仍需执行测试、类型检查与构建；本文档不宣称这些检查已通过。

## 后续层

第三层增加仅展示的队友工具活动及 agent 间消息方向，再增加两个监听器，并把这些临时帧留在持久 peer 队列之外。
