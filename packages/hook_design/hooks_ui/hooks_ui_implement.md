# Hooks UI 实现方案

## 1. 概述

本文档描述了 Hooks UI 的重构实现方案，将原有的 `/hooks`、`/enable`、`/disable` 三个命令整合为单一的 `/hooks` 命令，并提供完整的交互式 UI 流程。

## 2. 设计目标

- **简化命令**: 将 3 个命令 (`/hooks`, `/enable`, `/disable`) 合并为 1 个 (`/hooks`)
- **完整 UI 流程**: 提供列表选择 → 详情查看 → 配置操作的完整交互
- **清晰的状态展示**: 显示当前 hooks 配置状态和来源（User Settings / Local Settings）
- **友好的提示信息**: 为每种 hook 类型提供详细的使用说明

## 3. UI 流程设计

### 3.1 主流程

```
用户输入 /hooks
       ↓
显示 Hooks 列表页面
       ↓
用户选择特定 Hook (Enter)
       ↓
显示 Hook 详情页面
       ↓
用户操作: Esc 返回 / Enter 确认配置
```

### 3.2 页面结构

#### 3.2.1 Hooks 列表页面

```
┌─────────────────────────────────────────────────────────────┐
│  Hooks                                                       │
│                                                              │
│  ❯ 1. Stop                              [当前选择]          │
│    2. PreToolUse - Matchers                                 │
│    3. PostToolUse - Matchers                                 │
│    4. Notification                                          │
│    ...                                                       │
│                                                              │
│  Enter to select · Esc to cancel                            │
└─────────────────────────────────────────────────────────────┘
```

**元素说明**:

- 列表项显示 Hook 名称
- 当前选中的 Hook 有特殊标注（如 `❯` 符号）
- 底部显示操作提示

#### 3.2.2 Hook 详情页面 - Stop Hook 示例

```
┌─────────────────────────────────────────────────────────────┐
│  Stop                                                        │
│                                                              │
│  Exit code 0 - stdout/stderr not shown                      │
│  Exit code 2 - show stderr to model and continue conversation│
│  Other exit codes - show stderr to user only                │
│                                                              │
│  ❯ 1. [command] echo '{"decision": "block", ...}'  User Settings│
│    2. [command] echo '{"decision": "block", ...}'  Local Settings│
│                                                              │
│  Enter to confirm · Esc to go back                          │
└─────────────────────────────────────────────────────────────┘
```

**元素说明**:

- 顶部显示 Hook 名称
- 中间显示该 Hook 的使用说明（退出码含义等）
- 列表显示已配置的 hooks，包含命令和配置来源
- 底部显示操作提示

#### 3.2.3 Hook 详情页面 - PreToolUse 示例

```
┌─────────────────────────────────────────────────────────────┐
│  PreToolUse - Matchers                                       │
│                                                              │
│  Input to command is JSON of tool call arguments.           │
│  Exit code 0 - stdout/stderr not shown                       │
│  Exit code 2 - show stderr to model and block tool call     │
│  Other exit codes - show stderr to user only but continue   │
│                                                              │
│  No hooks configured for this event.                        │
│                                                              │
│  To add hooks, edit settings.json directly or ask Claude.   │
│                                                              │
│  Esc to go back                                              │
└─────────────────────────────────────────────────────────────┘
```

#### 3.2.4 Hook 详情页面 - PostToolUse 示例

```
┌─────────────────────────────────────────────────────────────┐
│  PostToolUse - Matchers                                      │
│                                                              │
│  Input to command is JSON with fields "inputs" (tool call   │
│  arguments) and "response" (tool call response).            │
│  Exit code 0 - stdout shown in transcript mode (ctrl+o)     │
│  Exit code 2 - show stderr to model immediately             │
│  Other exit codes - show stderr to user only                │
│                                                              │
│  No hooks configured for this event.                        │
│                                                              │
│  To add hooks, edit settings.json directly or ask Claude.   │
│                                                              │
│  Esc to go back                                              │
└─────────────────────────────────────────────────────────────┘
```

## 4. 数据结构设计

### 4.1 现有类型定义（来自 `packages/core/src/hooks/types.ts`）

直接使用现有的类型定义：

```typescript
import {
  HookEventName,
  HookConfig,
  CommandHookConfig,
  HooksConfigSource,
  HookDefinition,
  HookExecutionResult,
  HookExecutionPlan,
} from '@qwen-code/core/hooks/types';
```

**关键类型说明**:

| 类型                  | 说明                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ |
| `HookEventName`       | Hook 事件枚举，包含 `Stop`, `PreToolUse`, `PostToolUse`, `Notification` 等           |
| `HookConfig`          | Hook 配置接口，包含 `type`, `command`, `name`, `description`, `timeout`, `source` 等 |
| `HooksConfigSource`   | 配置来源枚举：`Project`, `User`, `System`, `Extensions`                              |
| `HookDefinition`      | Hook 定义，包含 `matcher`, `sequential`, `hooks` 数组                                |
| `HookExecutionResult` | Hook 执行结果，包含成功/失败状态、输出、错误等                                       |

### 4.2 UI 专用类型定义（新增）

```typescript
// UI 显示用的 Hook 详情
interface HookUIDetail {
  event: HookEventName;
  description: string;
  exitCodes: {
    code: number | string;
    description: string;
  }[];
  configs: HookConfig[];
}

// UI 状态管理
interface HooksUIState {
  currentView: 'list' | 'detail';
  selectedHookIndex: number;
  hooks: HookUIDetail[];
}
```

### 4.3 配置来源映射

将 `HooksConfigSource` 映射为 UI 显示文本：

```typescript
const SOURCE_DISPLAY_MAP: Record<HooksConfigSource, string> = {
  [HooksConfigSource.Project]: 'Local Settings',
  [HooksConfigSource.User]: 'User Settings',
  [HooksConfigSource.System]: 'System Settings',
  [HooksConfigSource.Extensions]: 'Extensions',
};
```

## 5. 实现方案

### 5.1 命令注册

```typescript
// 在命令注册处修改
// 移除: /enable, /disable
// 保留并增强: /hooks

commands.register('/hooks', {
  description: 'Manage hooks configuration',
  handler: handleHooksCommand,
});
```

### 5.2 Hooks 列表渲染

```typescript
import {
  HookEventName,
  HookConfig,
  HooksConfigSource,
} from '@qwen-code/core/hooks/types';

async function renderHooksList(hooks: HookUIDetail[]): Promise<void> {
  const items = hooks.map((hook, index) => ({
    label: hook.event,
    description:
      hook.configs.length > 0
        ? `${hook.configs.length} configured`
        : 'Not configured',
    selected: index === 0, // 默认选中第一个
  }));

  await renderSelectList({
    title: 'Hooks',
    items,
    onSelect: (index) => showHookDetail(hooks[index]),
    onCancel: () => closeUI(),
  });
}
```

### 5.3 Hook 详情渲染

```typescript
import { HookConfig, HooksConfigSource } from '@qwen-code/core/hooks/types';

const SOURCE_DISPLAY_MAP: Record<HooksConfigSource, string> = {
  [HooksConfigSource.Project]: 'Local Settings',
  [HooksConfigSource.User]: 'User Settings',
  [HooksConfigSource.System]: 'System Settings',
  [HooksConfigSource.Extensions]: 'Extensions',
};

async function renderHookDetail(hook: HookUIDetail): Promise<void> {
  const content = [
    // 标题
    { type: 'title', text: hook.event },
    { type: 'spacer' },
    // 描述
    { type: 'text', text: hook.description },
    { type: 'spacer' },
    // 退出码说明
    ...hook.exitCodes.map((ec) => ({
      type: 'text',
      text: `Exit code ${ec.code} - ${ec.description}`,
    })),
    { type: 'spacer' },
  ];

  if (hook.configs.length > 0) {
    // 显示已配置的 hooks
    const configItems = hook.configs.map((config, index) => ({
      label: `[command] ${config.command}`,
      description: config.source
        ? SOURCE_DISPLAY_MAP[config.source]
        : 'Unknown',
      selected: index === 0,
    }));

    await renderSelectList({
      content,
      items: configItems,
      onSelect: (index) => handleHookConfigAction(hook.configs[index]),
      onCancel: () => renderHooksList(allHooks),
    });
  } else {
    // 显示空状态
    content.push(
      { type: 'text', text: 'No hooks configured for this event.' },
      { type: 'spacer' },
      {
        type: 'text',
        text: 'To add hooks, edit settings.json directly or ask Claude.',
      },
      { type: 'spacer' },
    );

    await renderMessage({
      content,
      onBack: () => renderHooksList(allHooks),
    });
  }
}
```

### 5.4 Hook 提示信息配置

```typescript
import { HookEventName } from '@qwen-code/core/hooks/types';

const HOOK_DESCRIPTIONS: Record<string, HookUIDetail> = {
  [HookEventName.Stop]: {
    event: HookEventName.Stop,
    description: '',
    exitCodes: [
      { code: 0, description: 'stdout/stderr not shown' },
      {
        code: 2,
        description: 'show stderr to model and continue conversation',
      },
      { code: 'Other', description: 'show stderr to user only' },
    ],
    configs: [],
  },
  [HookEventName.PreToolUse]: {
    event: HookEventName.PreToolUse,
    description: 'Input to command is JSON of tool call arguments.',
    exitCodes: [
      { code: 0, description: 'stdout/stderr not shown' },
      { code: 2, description: 'show stderr to model and block tool call' },
      {
        code: 'Other',
        description: 'show stderr to user only but continue with tool call',
      },
    ],
    configs: [],
  },
  [HookEventName.PostToolUse]: {
    event: HookEventName.PostToolUse,
    description:
      'Input to command is JSON with fields "inputs" (tool call arguments) and "response" (tool call response).',
    exitCodes: [
      { code: 0, description: 'stdout shown in transcript mode (ctrl+o)' },
      { code: 2, description: 'show stderr to model immediately' },
      { code: 'Other', description: 'show stderr to user only' },
    ],
    configs: [],
  },
  [HookEventName.Notification]: {
    event: HookEventName.Notification,
    description: 'Triggered when notifications are sent.',
    exitCodes: [{ code: 0, description: 'notification handled' }],
    configs: [],
  },
};
```

## 6. 文件修改清单

### 6.1 需要修改的文件

| 文件路径                                       | 修改内容                              |
| ---------------------------------------------- | ------------------------------------- |
| `packages/cli/src/commands/index.ts`           | 移除 `/enable` 和 `/disable` 命令注册 |
| `packages/cli/src/commands/hooks.ts`           | 重构为完整的交互式 UI                 |
| `packages/cli/src/ui/components/HooksList.ts`  | 新增：Hooks 列表组件                  |
| `packages/cli/src/ui/components/HookDetail.ts` | 新增：Hook 详情组件                   |

### 6.2 需要删除的文件

| 文件路径                               | 原因                |
| -------------------------------------- | ------------------- |
| `packages/cli/src/commands/enable.ts`  | 功能合并到 `/hooks` |
| `packages/cli/src/commands/disable.ts` | 功能合并到 `/hooks` |

## 7. 实现步骤

### Phase 1: 基础结构 (1-2天)

1. 创建 Hook UI 专用类型定义（`HookUIDetail`, `HooksUIState`）
2. 实现 `HooksList` 组件
3. 实现 `HookDetail` 组件

### Phase 2: 命令整合 (1天)

1. 重构 `/hooks` 命令处理器
2. 移除 `/enable` 和 `/disable` 命令
3. 更新命令注册

### Phase 3: 测试与优化 (1天)

1. 编写单元测试
2. 集成测试
3. UI 交互优化

## 8. 兼容性考虑

- 保持现有的 hooks 配置文件格式不变
- 保持现有的 hooks 执行逻辑不变
- 复用 `packages/core/src/hooks/types.ts` 中的类型定义
- 仅修改 UI 交互层

## 9. 后续扩展

- 支持在 UI 中直接添加/编辑/删除 hooks
- 支持 hooks 配置的导入/导出
- 支持 hooks 执行日志查看

---

## 10. 实现完成状态

**Build 状态**: ✅ 成功

### 已完成的文件

| 文件                                                             | 状态      |
| ---------------------------------------------------------------- | --------- |
| `packages/cli/src/ui/components/hooks/types.ts`                  | ✅ 已创建 |
| `packages/cli/src/ui/components/hooks/constants.ts`              | ✅ 已创建 |
| `packages/cli/src/ui/components/hooks/HooksListStep.tsx`         | ✅ 已创建 |
| `packages/cli/src/ui/components/hooks/HookDetailStep.tsx`        | ✅ 已创建 |
| `packages/cli/src/ui/components/hooks/HooksManagementDialog.tsx` | ✅ 已创建 |
| `packages/cli/src/ui/components/hooks/index.ts`                  | ✅ 已创建 |
| `packages/cli/src/ui/hooks/useHooksDialog.ts`                    | ✅ 已创建 |
| `packages/cli/src/ui/commands/hooksCommand.ts`                   | ✅ 已修改 |
| `packages/cli/src/ui/commands/types.ts`                          | ✅ 已修改 |
| `packages/cli/src/ui/contexts/UIStateContext.tsx`                | ✅ 已修改 |
| `packages/cli/src/ui/contexts/UIActionsContext.tsx`              | ✅ 已修改 |
| `packages/cli/src/ui/hooks/slashCommandProcessor.ts`             | ✅ 已修改 |
| `packages/cli/src/ui/AppContainer.tsx`                           | ✅ 已修改 |
| `packages/cli/src/ui/components/DialogManager.tsx`               | ✅ 已修改 |
| `packages/cli/src/commands/hooks.tsx`                            | ✅ 已简化 |
| `packages/cli/src/commands/hooks/enable.ts`                      | ✅ 已删除 |
| `packages/cli/src/commands/hooks/disable.ts`                     | ✅ 已删除 |

### 使用方式

在交互模式下输入 `/hooks` 即可打开 Hooks 管理界面。
