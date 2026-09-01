# 钉钉工具类型精细阶段实施计划

> **供执行 Agent 使用：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐项执行本计划。所有步骤使用复选框（`- [ ]`）跟踪进度。

**目标：** 将钉钉对标准 ACP 初始 `tool_call` 工具类型的粗粒度兜底展示改为精确、本地化的生命周期阶段，同时保留现有的最新状态优先机制和旧 Bridge 兼容性。

**架构：** 分类逻辑继续留在钉钉展示层。先精确匹配封闭的 ACP `ToolKind` 值，仅对第三方或旧版 Bridge 保留当前正则兼容逻辑；得到有限的阶段枚举后，继续复用现有 reaction 和互动卡片投影链路。

**技术栈：** TypeScript、Vitest、钉钉互动卡片和消息 reaction、Agent Client Protocol 工具调用生命周期事件。

**设计文档：** `docs/design/dingtalk-dynamic-lifecycle-tags.md`

## 全局约束

- 本次作为独立的后续变更，不扩大已经评审收敛的生命周期交付 PR。
- 不修改 Provider 流式响应、模型行为、ACP Schema、`ChannelTaskLifecycleEvent`、`ChannelBase.ts`、`AcpBridge.ts` 生产代码或跨包接口。
- 本版本不改变工具 title 的展示策略，也不展示 description、路径、命令、参数、输出或模型推理。
- 保留最新阶段优先、终态抢占、来源标签组合和状态卡终态收敛行为。
- 保留现有正则兼容逻辑所支持的旧版和第三方 Bridge 输入。
- Core `Kind.Agent` 会被标准化为 ACP `other`，因此本版本不区分 `Agent` 和 `Other`，两者仍映射为 `working`。
- 有效展示语言以 `zh` 开头时使用中文标签，否则使用英文标签。
- 除设计文档和被 Git 忽略的 E2E 报告外，实现改动仅限 `packages/channels/dingtalk`。

## 信号可见性边界

- `qwen channel start` 使用 `AcpBridge`。标准初始 `tool_call` 携带 `kind`、`title` 和 `status`，现有链路会将其转成 `ToolCallEvent`，再由 `ChannelBase.dispatchToolCall` 投影为 `ChannelTaskLifecycleEvent`；因此本计划中的初始 kind 映射不需要修改 `ChannelBase.ts`。
- 本地 `AcpBridge` 当前不消费 `tool_call_update`。工具完成或失败后的 `completed`、`failed` 状态不能保证及时到达 ChannelBase；本版本不修复这一点，也不以它作为验收条件。
- `Kind.Agent` 在 ACP 层被标准化为 `other`，因此本版本不能将 Agent 映射为独立阶段。
- `TodoWrite` 使用 `plan` 更新而不是 `tool_call`，因此不会触发 `think` 工具阶段。
- 本版本增加只读契约测试，证明标准初始 kind 能穿过 `AcpBridge`；如果该测试不通过，应停止 DingTalk 映射实现并重新评估范围，不得用展示层猜测弥补上游信号缺失。

## 目标映射

| ACP kind | 内部阶段 | 英文标签 | 中文标签 |
| --- | --- | --- | --- |
| `read` | `reading` | `📖 Reading` | `📖 读取中` |
| `edit` | `editing` | `🛠️ Editing` | `🛠️ 编辑中` |
| `delete` | `deleting` | `🗑️ Deleting` | `🗑️ 删除中` |
| `move` | `moving` | `📦 Moving` | `📦 移动中` |
| `search` | `searching` | `🔎 Searching` | `🔎 搜索中` |
| `execute` | `running` | `🖥️ Running` | `🖥️ 执行中` |
| `think` | `thinking` | `🤔 Thinking` | `🤔 思考中` |
| `fetch` | `fetching` | `🌐 Fetching` | `🌐 获取中` |
| `switch_mode` | `switching` | `🔄 Switching mode` | `🔄 切换模式中` |
| `other` 或未知值 | `working` | `🛠️ Working` | `🛠️ 处理中` |

对于实际到达 DingTalk 层的生命周期事件，优先级保持不变：

1. `text_chunk` 映射为 `replying`。
2. 工具事件状态包含 `fail` 或 `error` 时，无论 kind 是什么都映射为 `retrying`；本地 `tool_call_update` 不在本版本的可见性保证内。
3. 工具事件状态包含 `complete` 或 `success` 时，无论 kind 是什么都映射为 `thinking`；本地 `tool_call_update` 不在本版本的可见性保证内。
4. 其他工具调用状态按上表进行精确匹配或兼容回退。

---

### Task 1：锁定 AcpBridge 初始 kind 透传契约

**文件：**

- 修改：`packages/channels/base/src/AcpBridge.test.ts:130-490`

**接口：**

- 输入：标准 ACP `session/update` 中的初始 `tool_call`。
- 输出：现有 `AcpBridge` 发出的 `ToolCallEvent`；本任务不修改生产实现。

- [ ] **步骤 1：增加标准初始 kind 透传契约测试**

在 `AcpBridge.test.ts` 中增加表驱动测试，直接向 `handleSessionUpdate` 输入标准初始工具事件：

```ts
it('forwards standard initial ACP tool kinds unchanged', () => {
  const bridge = new AcpBridge({
    cliEntryPath: '/tmp/qwen',
    cwd: '/tmp',
  }) as unknown as TestableAcpBridge;
  const toolCall = vi.fn();
  bridge.on('toolCall', toolCall);

  const kinds = [
    'read',
    'edit',
    'delete',
    'move',
    'search',
    'execute',
    'think',
    'fetch',
    'switch_mode',
    'other',
  ];
  for (const kind of kinds) {
    bridge.handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: `tool-${kind}`,
        kind,
        title: kind,
        status: 'in_progress',
      },
    });
  }

  expect(toolCall.mock.calls.map(([event]) => event.kind)).toEqual(kinds);
});
```

- [ ] **步骤 2：运行契约测试并确认现有实现直接通过**

执行：

```bash
cd packages/channels/base && npx vitest run src/AcpBridge.test.ts -t "standard initial ACP tool kinds"
```

预期：测试直接通过，证明下一任务不需要修改 `ChannelBase.ts` 或 `AcpBridge.ts` 生产代码。如果失败，停止执行后续任务并重新评估范围。

- [ ] **步骤 3：暂存契约测试，随下一任务一起形成一个行为提交**

本步骤不单独提交；契约测试将与任务 2 的 DingTalk 映射测试和最小实现一起提交，避免产生只有测试、没有用户可见行为的中间提交。

### Task 2：增加 ACP kind 精确分类

**文件：**

- 修改：`packages/channels/dingtalk/src/presentation-phase.ts:3-73`
- 新增：`packages/channels/dingtalk/src/presentation-phase.test.ts`

**接口：**

- 输入：来自 `@qwen-code/channel-base` 的 `ChannelTaskLifecycleEvent.toolCall.kind` 和 `.status`。
- 输出：`lifecyclePresentationPhase(event): DingtalkPresentationPhase | undefined`，新增 `deleting`、`moving`、`fetching` 和 `switching`。
- 输出：`presentationPhaseLabel(phase, language): string`，为每个阶段提供中英文标签。

- [ ] **步骤 1：为每个标准 ACP kind 编写失败的表驱动测试**

创建 `presentation-phase.test.ts`，使用辅助函数构造最小工具生命周期事件，并断言完整映射：

```ts
import { describe, expect, it } from 'vitest';
import type { ChannelTaskLifecycleEvent } from '@qwen-code/channel-base';
import {
  lifecyclePresentationPhase,
  presentationPhaseLabel,
} from './presentation-phase.js';

function toolEvent(
  kind: string,
  status = 'in_progress',
): ChannelTaskLifecycleEvent {
  return {
    channelName: 'dingtalk',
    chatId: 'chat-1',
    sessionId: 'session-1',
    identity: { id: 'channel:dingtalk', displayName: 'dingtalk' },
    memoryScope: {
      namespace: 'channel:dingtalk',
      mode: 'metadata-only',
    },
    type: 'tool_call',
    toolCall: {
      sessionId: 'session-1',
      toolCallId: `tool-${kind}`,
      kind,
      title: kind,
      status,
    },
  };
}

describe('lifecyclePresentationPhase', () => {
  it.each([
    ['read', 'reading'],
    ['edit', 'editing'],
    ['delete', 'deleting'],
    ['move', 'moving'],
    ['search', 'searching'],
    ['execute', 'running'],
    ['think', 'thinking'],
    ['fetch', 'fetching'],
    ['switch_mode', 'switching'],
    ['other', 'working'],
  ] as const)('maps ACP kind %s to %s', (kind, phase) => {
    expect(lifecyclePresentationPhase(toolEvent(kind))).toBe(phase);
  });
});
```

- [ ] **步骤 2：补充优先级、本地化和兼容性失败测试**

增加以下断言：

```ts
expect(lifecyclePresentationPhase(toolEvent('fetch', 'failed'))).toBe(
  'retrying',
);
expect(lifecyclePresentationPhase(toolEvent('delete', 'completed'))).toBe(
  'thinking',
);
expect(presentationPhaseLabel('fetching', 'zh-CN')).toBe('🌐 获取中');
expect(presentationPhaseLabel('deleting', 'en-US')).toBe('🗑️ Deleting');
expect(presentationPhaseLabel('moving', 'zh')).toBe('📦 移动中');
expect(presentationPhaseLabel('switching', 'en')).toBe(
  '🔄 Switching mode',
);

// 保留此前已支持的非标准 Bridge kind。
expect(lifecyclePresentationPhase(toolEvent('run_shell_command'))).toBe(
  'running',
);
expect(lifecyclePresentationPhase(toolEvent('web_search'))).toBe('searching');
expect(lifecyclePresentationPhase(toolEvent('write_file'))).toBe('editing');
expect(lifecyclePresentationPhase(toolEvent('read_file'))).toBe('reading');
expect(lifecyclePresentationPhase(toolEvent('custom_tool'))).toBe('working');
```

- [ ] **步骤 3：运行新增测试并确认 RED**

执行：

```bash
cd packages/channels/dingtalk && npx vitest run src/presentation-phase.test.ts
```

预期：测试失败，因为新增阶段和标签尚不存在，`delete`、`move`、`think`、`fetch`、`switch_mode` 当前都会回退到 `working`。

- [ ] **步骤 4：实现精确匹配优先、旧逻辑兜底的映射**

扩展 `DingtalkPresentationPhase` 和中英文标签表，然后将当前纯正则分类器替换为：

```ts
function toolPresentationPhase(kind: string): DingtalkPresentationPhase {
  switch (kind.trim().toLowerCase()) {
    case 'read':
      return 'reading';
    case 'edit':
      return 'editing';
    case 'delete':
      return 'deleting';
    case 'move':
      return 'moving';
    case 'search':
      return 'searching';
    case 'execute':
      return 'running';
    case 'think':
      return 'thinking';
    case 'fetch':
      return 'fetching';
    case 'switch_mode':
      return 'switching';
    case 'other':
      return 'working';
    default:
      if (/read/iu.test(kind)) return 'reading';
      if (/search|browser|web/iu.test(kind)) return 'searching';
      if (/shell|exec|command|run/iu.test(kind)) return 'running';
      if (/edit|write|patch/iu.test(kind)) return 'editing';
      return 'working';
  }
}
```

- [ ] **步骤 5：运行聚焦测试并确认 GREEN**

执行：

```bash
cd packages/channels/dingtalk && npx vitest run src/presentation-phase.test.ts
```

预期：所有映射、优先级、本地化和兼容性用例通过。

- [ ] **步骤 6：将上游契约和分类器作为一个独立评审单元提交**

```bash
git add packages/channels/base/src/AcpBridge.test.ts packages/channels/dingtalk/src/presentation-phase.ts packages/channels/dingtalk/src/presentation-phase.test.ts
git commit -m "feat(dingtalk): refine tool lifecycle phases"
```

### Task 3：验证两种钉钉展示表面并更新设计契约

**文件：**

- 修改：`packages/channels/dingtalk/src/DingtalkAdapter.test.ts:2480-2550`
- 修改：`packages/channels/dingtalk/src/status-card-controller.test.ts:175-205`
- 修改：`docs/design/dingtalk-dynamic-lifecycle-tags.md:9-27`
- 新增：`.qwen/e2e-tests/dingtalk-granular-kind-phases.md`（Git 忽略的验收材料）

**接口：**

- 输入：任务 2 扩展后的 `DingtalkPresentationPhase`。
- 输出：保持 `DingtalkInteractionPresenter.updateStatusCardPhase(runId, phase)` 接口不变，并继续通过 `presentationPhaseLabel` 生成 reaction 标签。
- 输出：证明同一个生命周期事件在 reaction 和互动卡片中呈现相同阶段的设计与 E2E 证据。

- [ ] **步骤 1：扩展 Adapter 投影测试**

更新现有生命周期投影测试，依次发送 `fetch`、`delete`、`move`、`think` 和 `switch_mode` 事件，并断言：

```ts
expect(updateStatusCardPhase.mock.calls).toEqual([
  ['run-1', 'fetching'],
  ['run-1', 'deleting'],
  ['run-1', 'moving'],
  ['run-1', 'thinking'],
  ['run-1', 'switching'],
  ['run-1', 'replying'],
]);
```

同时断言对应 emotion 请求依次使用 `🌐 获取中`、`🗑️ 删除中`、`📦 移动中`、`🤔 思考中` 和 `🔄 切换模式中`，并保持既有 emotion/background ID 不变。

- [ ] **步骤 2：扩展状态卡阶段更新测试**

依次调用 `StatusCardController.updateRunPhase`，传入 `fetching`、`deleting`、`moving` 和 `switching`。检查 `openOrUpdateStream` 调用，确认每次更新只替换首行阶段，同时保留已有正文、来源前缀、run 身份和 `finalize: false`。

- [ ] **步骤 3：运行钉钉展示相关测试**

执行：

```bash
cd packages/channels/dingtalk && npx vitest run src/presentation-phase.test.ts src/DingtalkAdapter.test.ts src/status-card-controller.test.ts src/interaction-presenter.test.ts
```

预期：所有测试通过；reaction 和卡片正文中的 title 展示行为与当前版本保持一致。

- [ ] **步骤 4：更新受版本控制的设计契约**

将本计划的“目标映射”表补充到设计文档，并明确：

- 先精确匹配 ACP kind，再执行兼容别名匹配；
- reaction 和活动状态卡正文投影相同的本地化阶段；
- `other` 继续作为最终兜底；
- 如果未来要区分 `Agent` 和 `Other`，需要增加协议元数据；
- 本版本不改变工具 title 的展示策略。

- [ ] **步骤 5：编写并试运行 E2E 计划**

创建 `.qwen/e2e-tests/dingtalk-granular-kind-phases.md`，覆盖：

1. 发送会触发 `web_fetch` 的天气查询；该工具执行期间，入站消息 reaction 和活动卡片都应显示 `🌐 获取中`，不再显示通用的 `🛠️ 处理中`。
2. 发送工作区检查请求并触发读取或搜索工具；根据实际 ACP kind 显示 `📖 读取中` 或 `🔎 搜索中`。
3. 发送命令执行任务；显示 `🖥️ 执行中`。
4. 收到第一个回答文本块后；显示 `✍️ 回复中`。
5. 任务完成后；活动阶段行从卡片中移除，终态状态行保留，reaction 切换为现有终态标签。
6. 卡片稳定渲染后再记录客户端截图；首屏渲染延迟需要单独记录。

先使用全局 `qwen` CLI 试运行相同请求，确认模型实际选择的工具；然后使用非 Gateway 钉钉机器人运行当前分支，模型凭据从 Gateway 环境注入。

- [ ] **步骤 6：提交展示证据和设计契约**

```bash
git add packages/channels/dingtalk/src/DingtalkAdapter.test.ts packages/channels/dingtalk/src/status-card-controller.test.ts docs/design/dingtalk-dynamic-lifecycle-tags.md
git commit -m "test(dingtalk): cover granular lifecycle phases"
```

### Task 4：最终验证与交付门禁

**文件：**

- 仅执行验证；计划外不修改 `packages/channels/dingtalk` 之外的生产代码。

**接口：**

- 输入：任务 1 至任务 3 的提交以及 E2E 报告。
- 输出：一个小范围、独立 follow-up PR 所需的评审证据。

- [ ] **步骤 1：执行包级验证**

```bash
(cd packages/channels/base && npx vitest run src/AcpBridge.test.ts -t "standard initial ACP tool kinds")
(cd packages/channels/dingtalk && npx vitest run src/presentation-phase.test.ts src/DingtalkAdapter.test.ts src/status-card-controller.test.ts src/interaction-presenter.test.ts)
```

预期：所有指定测试通过。

- [ ] **步骤 2：执行仓库交付验证**

在仓库根目录执行：

```bash
npm run build
npm run typecheck
npm run lint
git diff --check origin/main
```

预期：所有命令退出码均为 0，并且没有空白字符错误。

- [ ] **步骤 3：执行仓库自审**

完整阅读 diff 和新增测试文件，不带预设目标地检查：每个标准 ACP kind 是否都有中英文标签、兼容回退是否保留旧行为、title 展示策略是否保持不变、是否意外改变其他生命周期或 reaction 行为。连续两轮检查均未发现问题后停止；任何修复都会将干净轮次清零，并要求重新执行步骤 1 和步骤 2。

- [ ] **步骤 4：执行客户端可见的钉钉 E2E**

执行任务 3 的 E2E 计划，将时间戳、实际阶段序列、最终回答和稳定渲染截图追加到被忽略的报告中。仅有 Stream 连接成功或钉钉 API 更新成功不算通过，必须获得客户端可见的 reaction 和卡片状态证据。

- [ ] **步骤 5：准备独立后续 PR**

生命周期交付 PR 合并后，从已合并的默认分支创建后续分支。使用 `.github/pull_request_template.md`，描述用户可见行为，不引用实现符号；Reviewer Test Plan 至少说明：

- Web Fetch 显示 `🌐 获取中`，不再显示通用“处理中”。
- 删除、移动、思考和模式切换具有独立标签。
- 现有读取、搜索、执行、编辑和终态行为保持不变。
- Agent/Other 仍是已知限制。

只有在获得明确交付授权后才执行 push 和创建 PR；完成后回读远端 head、PR 正文和检查状态，再报告交付结果。

## 明确延期项

- 本地 `AcpBridge` 消费并补全 `tool_call_update`，使工具完成和失败阶段可以准确回到 `thinking` 或进入 `retrying`。
- 将 ACP `_meta.provenance` 或 `toolName` 安全地传到 Channel 生命周期，使 `Agent` 与普通 `Other` 可以区分。
- 为 `plan` 事件定义单独的钉钉展示语义；本版本不把 TodoWrite 猜测为 `think`。
