# ACP 宿主回合输入

[English](2026-11-13-acp-host-turn-inputs.md) | [简体中文](2026-11-13-acp-host-turn-inputs.zh-CN.md)

- **状态**：为 #17045 的 ACP 第二行准备了实现和测试更新。更新后的测试在本地通过。
- **日期**：2026-11-13。
- **关联**：#17045，以及 [统一 Agent loop 设计](2026-10-23-unified-agent-loop.md)。

## 问题

统一 loop 仍通过 `SendMessageOptions.userTurnRecordedByHost` 和 `interactionSpanByHost` 表达 ACP 的宿主所有权。这些开关隐藏了已完成的阶段，使 prompt 身份匹配变得隐式，并可能把宿主所有的 trace 当成 client 所有。

## 目标与范围

- 用 `userTurn: UserTurnInput` 替换 `userTurnRecordedByHost`。
- 用 `interactionSpan: Span` 替换 `interactionSpanByHost`。
- 保留 ACP 的时机、记录元数据、阶段独立处理，以及未传入这些输入的普通调用方的原有行为。

范围外：其他 ACP 工具批次、完整的逐轮 `runAgentLoop` 迁移、修改默认值、M block，以及 provider 或 session 层。

## API

```ts
type UserTurnInput = {
  promptId: string;
  todoWorkChain?: { promptId: string; continuedFrom?: string };
  fileHistory?: {
    promptId: string;
    outcome: 'attempted' | 'restore-omitted';
  };
};
```

`UserTurnRecord` 是带类型的数据联合，覆盖 `user`、`goal`、`cron` 和 `notification` 记录。它不属于该输入：宿主按自己的语义决定何时经 `recordUserTurn` 写入——发送前，或者对延迟的 cron 轮到该 block 到达历史之后——`userTurn.promptId` 只用来告知 core 不要自行记录该回合。输入上的回执会是 core 从不读取的值。

## 记录与阶段所有权

移除 `userTurnRecordedByHost` 意味着两件事：宿主经 core 的 `recordUserTurn` 在既有时间点写入记录，并以 `userTurn.promptId` 告知 core 不再自行记录该回合。`recordUserTurn(config, record)` 写入记录后不返回任何值；旧 writer 仍然是 best effort。

`todoWorkChain` 和 `fileHistory` 描述 ACP 已完成的准备工作；todo 与快照何时执行仍由 ACP 负责。只有对应阶段的 `promptId` 匹配时，core 才分别跳过记录、链创建和快照；一个阶段匹配不会抑制其他阶段，普通调用方继续使用原有默认行为。

## Span 所有权

`interactionSpan` 由调用方所有。Core 加入或触碰已有 trace，并把它传递给 continuation，但绝不关闭它。这样明确了所有权，同时保留 ACP 的 span 生命周期。

## 保留的行为

- slash 命令处理前的原始 user 记录继续保留显示文本、附件、资源引用和 `daemonPromptId`；`/clear` 仍会替换 recorder，同时保留已解析的 `/advisor` 例外。
- 文件历史快照仍在发送前尝试，即使该回合已取消。
- Retry、continue 和 restore 不再新增记录：它们的消息已在历史中，或在发送前已记录，因此该回合只带 `promptId`。Goal permit 行为保持不变。
- 延迟 cron 记录仍只在内容进入模型后执行，并且仍仅在保留历史时执行，包括保留未发送输入的情况。
- Notification 记录继续保留任务元数据和此前的持久化行为；已经持久化的后台通知不会被重复记录。

## 验证与验收

实现和测试均已就位，并在本地通过：core `client.test.ts` 640 passed、core `client-goal.test.ts` 59 passed、`Session.test.ts` 1447 个测试无失败。本次改动前的基线运行相同的测试数，因此不是靠删测试换绿。

验收要求保留记录元数据，独立处理 recording/chain/snapshot 阶段，并证明外部 span 绝不会由 client 关闭。上述测试覆盖了这些行为。
