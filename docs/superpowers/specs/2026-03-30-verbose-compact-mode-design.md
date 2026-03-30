# Verbose / Compact 输出模式切换 设计文档

**版本：** 1.0
**日期：** 2026-03-30
**作者：** Claude Code (claude-sonnet-4-6)
**状态：** Draft → 待工程评审

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [竞品调研](#2-竞品调研)
3. [需求定义](#3-需求定义)
4. [整体架构](#4-整体架构)
5. [数据模型与持久化](#5-数据模型与持久化)
6. [快捷键注册与切换逻辑](#6-快捷键注册与切换逻辑)
7. [渲染层改动](#7-渲染层改动)
8. [UI 反馈：Footer 与切换消息](#8-ui-反馈footer-与切换消息)
9. [国际化（i18n）](#9-国际化i18n)
10. [测试策略](#10-测试策略)
11. [改动文件总览](#11-改动文件总览)
12. [验收标准](#12-验收标准)

---

## 1. 背景与动机

### 问题

qwen-code 当前所有工具调用结果（文件内容、bash 输出、diff 等）和模型思考链均在终端完整展示，仅通过 `MaxSizedBox` 按终端高度截断。在执行复杂多步任务时，大量工具输出会淹没最终回答，用户需要频繁滚动才能看到模型的结论。

### 目标

实现**精简模式（Compact）/ 详细模式（Verbose）**的运行时热切换：

- **精简模式（默认）**：只显示工具名称 + 状态图标，隐藏工具执行结果和思考链，突出最终回答
- **详细模式（Verbose）**：显示完整工具输出、思考链，适合调试和审计

### 参考

Claude Code 原版代码中有 `transcript mode (ctrl+o)` 的文档注释残留（`packages/cli/src/ui/components/hooks/constants.ts:33`），但在 qwen-code fork 中**未实现**。本功能从头实现，行为对齐 Claude Code 原版。

---

## 2. 竞品调研

### 2.1 Claude Code — Transcript Mode（Ctrl+O）

**状态：** 原版已实现，qwen-code 未继承

- **精简模式（默认）**：工具名 + 状态图标（一行），工具结果隐藏，思考链隐藏
- **详细模式**：工具结果全文展示，hook stdout 对用户可见，思考链展示
- **持久化**：写入 settings 文件，跨 session 保留
- **切换方式**：Ctrl+O 热切换，切换时插入 info 消息
- **影响范围**：仅影响切换后的新内容，已固化的历史不变

### 2.2 Gemini CLI

无对应功能。工具结果始终固定格式展示，无运行时切换机制。

### 2.3 Aider — `--verbose` CLI Flag

启动时 flag（`aider --verbose`），不支持运行时热切换。详细模式输出完整 API 请求/响应 JSON。

### 2.4 OpenHands (OpenDevin)

Web UI 内置日志级别切换（INFO/DEBUG），针对系统日志而非用户侧输出呈现，概念不同。

### 2.5 GitHub Copilot CLI

单次命令场景，无持续会话模式，不适用 verbose 切换概念。

### 调研结论

Claude Code 是唯一实现**运行时热切换 + 持久化**的工具。其核心价值在于：详细模式对调试有用，精简模式让用户聚焦最终答案。qwen-code 应对齐 Claude Code 的行为。

---

## 3. 需求定义

### 3.1 功能需求

| ID  | 需求                                                                        | 优先级         |
| --- | --------------------------------------------------------------------------- | -------------- |
| F1  | 精简模式（默认）：工具执行结果完全隐藏，只留工具名 + 状态图标               | P0             |
| F2  | 精简模式：模型思考链（`gemini_thought` / `gemini_thought_content`）完全隐藏 | P0             |
| F3  | 详细模式：工具结果全文展示，思考链展示                                      | P0             |
| F4  | Ctrl+O 快捷键切换精简/详细模式                                              | P0             |
| F5  | 模式状态持久化到 settings.json，跨 session 保留                             | P0             |
| F6  | 切换时插入 info 消息提示用户当前模式                                        | P1             |
| F7  | 详细模式时 Footer 右侧显示 `verbose` 标签                                   | P1             |
| F8  | Footer 快捷键文档中更新 Ctrl+O 说明                                         | P1             |
| F9  | 切换仅影响新内容，已固化的 `<Static>` 历史不受影响                          | P0（框架约束） |

### 3.2 非功能需求

- **无性能影响**：精简模式不做数据丢弃，只在渲染层跳过，切换后可完整还原详细视图
- **架构一致性**：使用 React Context 模式，与现有 10+ Context 保持一致
- **改动最小化**：核心逻辑变更不超过 50 行

### 3.3 明确排除

- ❌ 不按工具类型分别控制（全局一个开关）
- ❌ 不重渲染历史内容（Ink `<Static>` 机制限制，也无必要）
- ❌ 不在 `/settings` 对话框中暴露此设置（通过快捷键控制已足够）

---

## 4. 整体架构

### 4.1 架构分层

```
┌─────────────────────────────────────────┐
│  持久化层                                 │
│  settings.json → ui.verboseMode: boolean │
│  （默认 false = 精简模式）                 │
└──────────────────┬──────────────────────┘
                   │ 启动时读取 / 切换时写入
┌──────────────────▼──────────────────────┐
│  状态层：AppContainer.tsx               │
│  const [verboseMode, setVerboseMode]    │
│  = useState(settings.merged.ui?.        │
│    verboseMode ?? false)                │
│                                         │
│  Ctrl+O handler:                        │
│    toggle → writeSettings → addInfoMsg  │
└──────────────────┬──────────────────────┘
                   │ Context.Provider
┌──────────────────▼──────────────────────┐
│  Context 层：VerboseModeContext.tsx（新建）│
│  export const useVerboseMode()          │
│  value: { verboseMode: boolean }        │
└──────────┬─────────────────┬────────────┘
           │ useVerboseMode() │ useVerboseMode()
┌──────────▼──────┐  ┌───────▼──────────────┐
│ HistoryItem     │  │ ToolMessage.tsx       │
│ Display.tsx     │  │                       │
│ 跳过 thought*   │  │ 跳过 resultDisplay    │
│ 渲染            │  │ 渲染                  │
└─────────────────┘  └──────────────────────┘
```

### 4.2 关键设计决策

**决策 1：渲染层过滤 vs 数据层过滤**

选择渲染层过滤（Context 注入），原因：

- 数据层过滤会丢弃 `resultDisplay`，切换回详细模式时历史工具结果无法复现
- 渲染层过滤只影响展示，数据完整保留

**决策 2：独立 Context vs 扩展 UIStateContext**

选择独立 `VerboseModeContext`，原因：

- `UIStateContext` 已有 90+ 行字段，职责过重
- verbose mode 是 UI 呈现偏好，独立 Context 语义更清晰
- 消费组件只需引入一个轻量 hook

**决策 3：Context 只读**

`VerboseModeContext` 只暴露 `verboseMode: boolean`，写操作集中在 `AppContainer`。消费组件不持有写权限，避免状态更新分散。

---

## 5. 数据模型与持久化

### 5.1 Settings Schema 新增字段

**文件：** `packages/cli/src/config/settingsSchema.ts`

在 `ui.properties` 末尾（`enableUserFeedback` 之后）新增：

```typescript
verboseMode: {
  type: 'boolean',
  label: 'Verbose Mode',
  category: 'UI',
  requiresRestart: false,
  default: false,
  description:
    'Show full tool output and thinking in verbose mode (toggle with ctrl+o).',
  showInDialog: false,  // 通过快捷键控制，不在设置对话框中显示
},
```

此定义通过 `InferSettings<SettingsSchemaType>`（`settingsSchema.ts:1630`）自动推断出 `Settings.ui.verboseMode?: boolean`，无需手动修改 TypeScript interface。

### 5.2 VerboseModeContext

**文件：** `packages/cli/src/ui/contexts/VerboseModeContext.tsx`（新建）

```typescript
import React, { createContext, useContext } from 'react';

interface VerboseModeContextType {
  verboseMode: boolean;
}

const VerboseModeContext = createContext<VerboseModeContextType>({
  verboseMode: false, // 默认精简模式
});

export const useVerboseMode = (): VerboseModeContextType =>
  useContext(VerboseModeContext);

export const VerboseModeProvider = VerboseModeContext.Provider;
```

### 5.3 AppContainer 状态初始化

**文件：** `packages/cli/src/ui/AppContainer.tsx`

```typescript
// 从 settings 读取初始值，默认 false（精简模式）
const [verboseMode, setVerboseMode] = useState<boolean>(
  settings.merged.ui?.verboseMode ?? false,
);
```

持久化写入（切换时调用）：

```typescript
settings.setValue(SettingScope.User, 'ui.verboseMode', newValue);
```

---

## 6. 快捷键注册与切换逻辑

### 6.1 Command Enum 与 Key Binding

**文件：** `packages/cli/src/config/keyBindings.ts`

```typescript
// Command enum（App level bindings 区块，紧跟 TOGGLE_TOOL_DESCRIPTIONS 之后）
TOGGLE_VERBOSE_MODE = 'toggleVerboseMode',

// defaultKeyBindings
[Command.TOGGLE_VERBOSE_MODE]: [{ key: 'o', ctrl: true }],
```

### 6.2 AppContainer Keypress Handler

**文件：** `packages/cli/src/ui/AppContainer.tsx`

在 `handleGlobalKeypress` 中，紧跟 `TOGGLE_TOOL_DESCRIPTIONS` handler 之后新增：

```typescript
if (keyMatchers[Command.TOGGLE_VERBOSE_MODE](key)) {
  const newValue = !verboseMode;
  setVerboseMode(newValue);
  settings.setValue(SettingScope.User, 'ui.verboseMode', newValue);
  historyManager.addItem(
    {
      type: MessageType.INFO,
      text: newValue
        ? t('Verbose mode on — showing full tool output and thinking')
        : t('Compact mode on — showing tool names and final responses only'),
    },
    Date.now(),
  );
}
```

`verboseMode` 须加入 `handleGlobalKeypress` 的 `useCallback` 依赖数组。

### 6.3 VerboseModeProvider 挂载

**文件：** `packages/cli/src/ui/AppContainer.tsx`

在 `AppContext.Provider` 内部、`ShellFocusContext.Provider` 外部包裹（与 `ShellFocusContext.Provider` 并列同层）：

```tsx
// 原代码
<ShellFocusContext.Provider value={isFocused}>
  <App />
</ShellFocusContext.Provider>

// 改为
<VerboseModeProvider value={{ verboseMode }}>
  <ShellFocusContext.Provider value={isFocused}>
    <App />
  </ShellFocusContext.Provider>
</VerboseModeProvider>
```

### 6.4 切换时序

```
用户按 Ctrl+O
  ↓
handleGlobalKeypress 匹配 Command.TOGGLE_VERBOSE_MODE
  ↓
setVerboseMode(newValue)           ← React state，触发 rerender
settings.setValue(...)             ← 写 settings.json，持久化
historyManager.addItem(info msg)   ← 插入切换提示到对话历史
  ↓
VerboseModeContext 值更新
  ↓
HistoryItemDisplay + ToolMessage rerender（仅 pending items）
```

---

## 7. 渲染层改动

### 7.1 HistoryItemDisplay — 隐藏思考链

**文件：** `packages/cli/src/ui/components/HistoryItemDisplay.tsx`

```typescript
// 顶部新增 import 和 hook 调用
import { useVerboseMode } from '../contexts/VerboseModeContext.js';
const { verboseMode } = useVerboseMode();

// 修改 gemini_thought 条件（原约第 116 行）
{verboseMode && itemForDisplay.type === 'gemini_thought' && (
  <ThinkMessage
    text={itemForDisplay.text}
    isPending={isPending}
    availableTerminalHeight={availableTerminalHeightGemini ?? availableTerminalHeight}
    contentWidth={contentWidth}
  />
)}

// 修改 gemini_thought_content 条件（原约第 126 行）
{verboseMode && itemForDisplay.type === 'gemini_thought_content' && (
  <ThinkMessageContent
    text={itemForDisplay.text}
    isPending={isPending}
    availableTerminalHeight={availableTerminalHeightGemini ?? availableTerminalHeight}
    contentWidth={contentWidth}
  />
)}
```

**注意：** 精简模式下，思考过程的"正在思考..."动画（`isPending=true` 状态）也随之隐藏，用户在精简模式下完全感知不到思考链的存在。

### 7.2 ToolMessage — 隐藏工具结果

**文件：** `packages/cli/src/ui/components/messages/ToolMessage.tsx`

```typescript
// 顶部新增 import 和 hook 调用
import { useVerboseMode } from '../../contexts/VerboseModeContext.js';
const { verboseMode } = useVerboseMode();

// 在 useResultDisplayRenderer 调用之后新增一行
const effectiveDisplayRenderer = verboseMode
  ? displayRenderer
  : { type: 'none' as const };
```

将 JSX 中的 `displayRenderer` 替换为 `effectiveDisplayRenderer`（约第 347 行）：

```tsx
// 原代码
{displayRenderer.type !== 'none' && (
  <Box ...>...</Box>
)}

// 改为
{effectiveDisplayRenderer.type !== 'none' && (
  <Box ...>...</Box>
)}
```

### 7.3 视觉效果对比

| 内容                                 | 精简模式 | 详细模式 | 说明                          |
| ------------------------------------ | -------- | -------- | ----------------------------- |
| 工具名                               | ✅ 显示  | ✅ 显示  | 始终可见                      |
| 工具状态图标（✓/⟳/✗）                | ✅ 显示  | ✅ 显示  | 始终可见                      |
| 工具描述行（参数摘要）               | ✅ 显示  | ✅ 显示  | 始终可见                      |
| 工具执行结果（stdout/文件内容/diff） | ❌ 隐藏  | ✅ 显示  | `ToolMessage.tsx` 控制        |
| 思考链（Thinking）                   | ❌ 隐藏  | ✅ 显示  | `HistoryItemDisplay.tsx` 控制 |
| 最终模型回答                         | ✅ 显示  | ✅ 显示  | 始终可见                      |

---

## 8. UI 反馈：Footer 与切换消息

### 8.1 Footer verbose 标签

**文件：** `packages/cli/src/ui/components/Footer.tsx`

```typescript
// 顶部新增 import
import { useVerboseMode } from '../contexts/VerboseModeContext.js';

// Footer 组件内读取
const { verboseMode } = useVerboseMode();

// 在 rightItems 数组末尾新增
if (verboseMode) {
  rightItems.push({
    key: 'verbose',
    node: (
      <Text color={theme.text.accent}>
        {t('verbose')}
      </Text>
    ),
  });
}
```

**行为：**

- 精简模式（默认）：Footer 右侧无 verbose 标签，保持简洁
- 详细模式：Footer 右侧出现 `verbose` 标签，颜色为 `theme.text.accent`（与 context usage 指示器一致）

### 8.2 切换 Info 消息文案

通过 `historyManager.addItem` 插入，使用 `MessageType.INFO` 类型：

| 切换方向    | 消息文案（EN）                                                  | 消息文案（ZH）                                  |
| ----------- | --------------------------------------------------------------- | ----------------------------------------------- |
| 精简 → 详细 | `Verbose mode on — showing full tool output and thinking`       | `已切换到详细模式 — 完整显示工具输出和思考过程` |
| 详细 → 精简 | `Compact mode on — showing tool names and final responses only` | `已切换到精简模式 — 仅显示工具名称和最终回答`   |

### 8.3 文档更新

**文件：** `docs/users/reference/keyboard-shortcuts.md` 第 13 行

```diff
- | `Ctrl+O` | Toggle the display of the debug console.                    |
+ | `Ctrl+O` | Toggle verbose mode (show/hide full tool output and thinking). |
```

---

## 9. 国际化（i18n）

在以下 6 个 locale 文件中各新增 4 条 key：

**文件列表：**

- `packages/cli/src/i18n/locales/en.js`
- `packages/cli/src/i18n/locales/zh.js`
- `packages/cli/src/i18n/locales/de.js`
- `packages/cli/src/i18n/locales/ja.js`
- `packages/cli/src/i18n/locales/ru.js`
- `packages/cli/src/i18n/locales/pt.js`

**新增 key（en.js 为基准）：**

```javascript
'Verbose mode on — showing full tool output and thinking':
  'Verbose mode on — showing full tool output and thinking',
'Compact mode on — showing tool names and final responses only':
  'Compact mode on — showing tool names and final responses only',
'verbose': 'verbose',
'Show full tool output and thinking in verbose mode (toggle with ctrl+o).':
  'Show full tool output and thinking in verbose mode (toggle with ctrl+o).',
```

**zh.js 翻译：**

```javascript
'Verbose mode on — showing full tool output and thinking':
  '已切换到详细模式 — 完整显示工具输出和思考过程',
'Compact mode on — showing tool names and final responses only':
  '已切换到精简模式 — 仅显示工具名称和最终回答',
'verbose': '详细',
'Show full tool output and thinking in verbose mode (toggle with ctrl+o).':
  '详细模式下显示完整工具输出和思考过程（ctrl+o 切换）。',
```

**其他语言（de / ja / ru / pt）：** 初版以英文 key 为 value 占位，后续由本地化团队补充翻译。

---

## 10. 测试策略

### 10.1 单元测试（新增 case，不新建文件）

**① `packages/cli/src/ui/keyMatchers.test.ts` — 新增 2 case**

```typescript
describe('TOGGLE_VERBOSE_MODE', () => {
  it('matches Ctrl+O', () => {
    const key = {
      name: 'o',
      ctrl: true,
      shift: false,
      meta: false,
      paste: false,
      sequence: '',
    };
    expect(keyMatchers[Command.TOGGLE_VERBOSE_MODE](key)).toBe(true);
  });
  it('does not match plain O', () => {
    const key = {
      name: 'o',
      ctrl: false,
      shift: false,
      meta: false,
      paste: false,
      sequence: '',
    };
    expect(keyMatchers[Command.TOGGLE_VERBOSE_MODE](key)).toBe(false);
  });
});
```

**② `packages/cli/src/ui/components/messages/ToolMessage.test.tsx` — 新增 2 case**

```typescript
describe('verbose mode', () => {
  it('hides resultDisplay in compact mode (verboseMode=false)', () => {
    const { lastFrame } = render(
      <VerboseModeProvider value={{ verboseMode: false }}>
        <ToolMessage {...baseProps} resultDisplay="tool output content" />
      </VerboseModeProvider>,
    );
    expect(lastFrame()).not.toContain('tool output content');
  });

  it('shows resultDisplay in verbose mode (verboseMode=true)', () => {
    const { lastFrame } = render(
      <VerboseModeProvider value={{ verboseMode: true }}>
        <ToolMessage {...baseProps} resultDisplay="tool output content" />
      </VerboseModeProvider>,
    );
    expect(lastFrame()).toContain('tool output content');
  });
});
```

**③ `packages/cli/src/ui/components/HistoryItemDisplay.test.tsx` — 新增 2 case**

```typescript
describe('verbose mode — thought rendering', () => {
  it('hides gemini_thought in compact mode', () => {
    const item: HistoryItem = { id: 1, type: 'gemini_thought', text: 'thinking text', ... };
    const { lastFrame } = render(
      <VerboseModeProvider value={{ verboseMode: false }}>
        <HistoryItemDisplay item={item} ... />
      </VerboseModeProvider>,
    );
    expect(lastFrame()).not.toContain('thinking text');
  });

  it('shows gemini_thought in verbose mode', () => {
    const { lastFrame } = render(
      <VerboseModeProvider value={{ verboseMode: true }}>
        <HistoryItemDisplay item={item} ... />
      </VerboseModeProvider>,
    );
    expect(lastFrame()).toContain('thinking text');
  });
});
```

**④ `packages/cli/src/ui/components/Footer.test.tsx` — 新增 2 case**

```typescript
describe('verbose mode indicator', () => {
  it('shows verbose indicator when verboseMode=true', () => {
    const { lastFrame } = render(
      <VerboseModeProvider value={{ verboseMode: true }}>
        <Footer />
      </VerboseModeProvider>,
    );
    expect(lastFrame()).toContain('verbose');
  });

  it('hides verbose indicator when verboseMode=false', () => {
    const { lastFrame } = render(
      <VerboseModeProvider value={{ verboseMode: false }}>
        <Footer />
      </VerboseModeProvider>,
    );
    expect(lastFrame()).not.toContain('verbose');
  });
});
```

### 10.2 集成测试（手动 E2E）

**场景 1：默认精简模式验证**

```
1. 启动 qwen-code（确保 settings.json 中无 ui.verboseMode 或为 false）
2. 发送一条需要工具调用的消息（如"读取 package.json 并告诉我版本"）
3. ✅ 验证：工具名 + 状态图标可见
4. ✅ 验证：工具执行结果（文件内容）不可见
5. ✅ 验证：Footer 无 verbose 标签
```

**场景 2：切换到详细模式**

```
1. 按 Ctrl+O
2. ✅ 验证：出现 info 消息"已切换到详细模式..."
3. ✅ 验证：Footer 右侧出现 verbose 标签
4. 发送新消息触发工具调用
5. ✅ 验证：工具执行结果全文可见
6. ✅ 验证：思考链可见（如模型有思考内容）
```

**场景 3：持久化验证**

```
1. 切换到详细模式（Ctrl+O）
2. 退出 qwen-code（Ctrl+D）
3. 检查 settings.json → ui.verboseMode 应为 true
4. 重启 qwen-code
5. ✅ 验证：仍处于详细模式（Footer 有 verbose 标签）
```

**场景 4：切回精简模式**

```
1. 在详细模式下按 Ctrl+O
2. ✅ 验证：出现 info 消息"已切换到精简模式..."
3. ✅ 验证：Footer verbose 标签消失
4. 发送新消息触发工具调用
5. ✅ 验证：工具结果再次隐藏
```

**场景 5：历史不变性验证**

```
1. 在精简模式下触发工具调用（工具结果不可见）
2. 切换到详细模式（Ctrl+O）
3. ✅ 验证：之前的工具调用结果仍不可见（Static 内容不重渲染）
4. 发送新消息触发工具调用
5. ✅ 验证：新工具调用结果可见
```

---

## 11. 改动文件总览

| 文件路径                                                  | 类型    | 改动量  | 说明                                                    |
| --------------------------------------------------------- | ------- | ------- | ------------------------------------------------------- |
| `packages/cli/src/ui/contexts/VerboseModeContext.tsx`     | 🆕 新建 | ~25 行  | Context 定义 + Provider + Hook                          |
| `packages/cli/src/config/settingsSchema.ts`               | ✏️ 修改 | +9 行   | `ui.verboseMode` 字段定义                               |
| `packages/cli/src/config/keyBindings.ts`                  | ✏️ 修改 | +2 行   | Command enum + 默认绑定                                 |
| `packages/cli/src/ui/AppContainer.tsx`                    | ✏️ 修改 | +22 行  | 状态、handler、Provider 挂载                            |
| `packages/cli/src/ui/components/HistoryItemDisplay.tsx`   | ✏️ 修改 | +6 行   | thought\* 类型条件渲染                                  |
| `packages/cli/src/ui/components/messages/ToolMessage.tsx` | ✏️ 修改 | +4 行   | effectiveDisplayRenderer                                |
| `packages/cli/src/ui/components/Footer.tsx`               | ✏️ 修改 | +8 行   | verbose 标签 + import                                   |
| `packages/cli/src/i18n/locales/en.js`                     | ✏️ 修改 | +4 行   | 英文 i18n key                                           |
| `packages/cli/src/i18n/locales/zh.js`                     | ✏️ 修改 | +4 行   | 中文翻译                                                |
| `packages/cli/src/i18n/locales/de.js`                     | ✏️ 修改 | +4 行   | 德文占位                                                |
| `packages/cli/src/i18n/locales/ja.js`                     | ✏️ 修改 | +4 行   | 日文占位                                                |
| `packages/cli/src/i18n/locales/ru.js`                     | ✏️ 修改 | +4 行   | 俄文占位                                                |
| `packages/cli/src/i18n/locales/pt.js`                     | ✏️ 修改 | +4 行   | 葡文占位                                                |
| `docs/users/reference/keyboard-shortcuts.md`              | ✏️ 修改 | 改 1 行 | Ctrl+O 说明更新                                         |
| 测试文件（×4）                                            | ✏️ 修改 | +8 case | keyMatchers / ToolMessage / HistoryItemDisplay / Footer |

**总计：** 1 个新文件，17 个修改文件（含 4 个测试文件），约 110 行净增量

---

## 12. 验收标准

### 12.1 功能验收

- [ ] 默认启动时处于精简模式（工具结果不可见）
- [ ] Ctrl+O 可在精简/详细模式间热切换
- [ ] 详细模式下工具执行结果（string / diff / ansi / todo / plan / task 所有类型）均可见
- [ ] 详细模式下思考链（gemini_thought / gemini_thought_content）均可见
- [ ] 精简模式下上述内容均不可见
- [ ] 模式状态写入 settings.json，重启后保留
- [ ] 切换时出现对应 info 提示消息
- [ ] 详细模式时 Footer 右侧显示 verbose 标签
- [ ] 切换只影响新内容，历史 Static 内容不变

### 12.2 测试验收

- [ ] 所有新增单元测试通过（`npm test`）
- [ ] 现有测试无回归
- [ ] TypeScript 类型检查通过（`npm run typecheck`）

### 12.3 代码质量

- [ ] `VerboseModeContext` 遵循现有 Context 命名和文件结构规范
- [ ] 新增 i18n key 在所有 6 个 locale 文件中均已添加
- [ ] 无 prop drilling（消费组件通过 `useVerboseMode()` 获取，不通过 props）
