# Verbose / Compact 输出模式（Ctrl+O）完整设计与实现

**版本：** 2.0（最终版）
**日期：** 2026-03-31
**状态：** 已实现并验证

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [竞品调研](#2-竞品调研)
3. [需求定义](#3-需求定义)
4. [技术方案分析与选型](#4-技术方案分析与选型)
5. [整体架构](#5-整体架构)
6. [实现细节](#6-实现细节)
7. [行为对比与实际效果](#7-行为对比与实际效果)
8. [变更文件清单](#8-变更文件清单)
9. [测试结果](#9-测试结果)

---

## 1. 背景与动机

### 1.1 问题

qwen-code 中所有工具调用结果（文件内容、bash 输出、diff 等）和模型思考链均在终端完整展示，仅通过 `MaxSizedBox` 按终端高度截断。在执行复杂多步任务时，大量工具输出会淹没最终回答，用户需要频繁滚动才能看到模型的结论。

### 1.2 目标

实现**精简模式（Compact）/ 详细模式（Verbose）**的运行时热切换：

- **精简模式（默认）**：只显示工具名称 + 状态图标，隐藏工具执行结果和思考链，突出最终回答
- **详细模式（Verbose）**：显示完整工具输出、思考链，适合调试和审计
- **快捷键**：Ctrl+O 热切换，状态跨 session 持久化

---

## 2. 竞品调研

### 2.1 Claude Code — Transcript Mode（Ctrl+O）

**行为（初版对齐目标）：**

- **精简模式（默认）**：工具名 + 状态图标，工具结果隐藏，思考链隐藏
- **详细模式**：工具结果全文展示，思考链展示
- **持久化**：写入 settings 文件，跨 session 保留
- **切换方式**：Ctrl+O 热切换

**深度调研（v2 对齐目标）发现的额外行为：**

| 场景                     | 行为                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| 空闲时切换               | 所有历史条目（含已完成会话）同步展开/收起，不只影响后续内容          |
| 流式输出期间切换进入详细 | pending 区域冻结为静态快照，用户可安静阅读，后台执行继续但不更新显示 |
| 冻结状态再切换           | 解冻，恢复实时 pending 视图                                          |
| 会话结束后切换           | 历史条目依然响应展开/收起                                            |

### 2.2 其他竞品

| 工具               | 是否有类似功能           | 说明                               |
| ------------------ | ------------------------ | ---------------------------------- |
| Gemini CLI         | ❌                       | 工具结果固定格式展示，无运行时切换 |
| Aider              | 部分（`--verbose` flag） | 启动时 flag，不支持运行时热切换    |
| OpenHands          | Web UI 日志级别          | 针对系统日志，非用户侧输出呈现     |
| GitHub Copilot CLI | ❌                       | 单次命令场景，不适用               |

**结论：** Claude Code 是唯一实现**运行时热切换 + 持久化 + 历史追溯**的工具，qwen-code 应对齐其完整行为。

---

## 3. 需求定义

### 3.1 功能需求

| ID  | 需求                                                                        | 优先级 |
| --- | --------------------------------------------------------------------------- | ------ |
| F1  | 精简模式（默认）：工具执行结果完全隐藏，只留工具名 + 状态图标               | P0     |
| F2  | 精简模式：模型思考链（`gemini_thought` / `gemini_thought_content`）完全隐藏 | P0     |
| F3  | 详细模式：工具结果全文展示，思考链展示                                      | P0     |
| F4  | Ctrl+O 快捷键切换精简/详细模式                                              | P0     |
| F5  | 模式状态持久化到 settings.json，跨 session 保留                             | P0     |
| F6  | 切换时影响**所有**历史条目（追溯展开/收起）                                 | P0     |
| F7  | 流式输出期间切换：冻结 pending 区域快照，不随执行抖动                       | P0     |
| F8  | 详细模式时 Footer 右侧显示 `verbose` 标签                                   | P1     |

### 3.2 非功能需求

- **无数据丢弃**：精简模式只在渲染层跳过，切换后可完整还原详细视图
- **架构一致性**：使用 React Context 模式，与现有 Context 保持一致
- **无侵入性**：核心逻辑变更最小化

### 3.3 明确排除

- ❌ 不按工具类型分别控制（全局一个开关）
- ❌ 不在 `/settings` 对话框中暴露此设置（通过快捷键控制）

---

## 4. 技术方案分析与选型

### 4.1 精简/详细渲染控制：渲染层 vs 数据层

| 方案                   | 描述                                | 优缺点                                  |
| ---------------------- | ----------------------------------- | --------------------------------------- |
| **数据层过滤**         | 将工具结果从 `resultDisplay` 中清除 | ❌ 切换回详细模式时历史工具结果无法复现 |
| **渲染层过滤**（选用） | 通过 Context 在渲染时决定是否展示   | ✅ 数据完整保留，切换即时生效，无副作用 |

**决策：渲染层过滤。** `verboseMode` 值通过 React Context 传递，消费组件在渲染时判断是否展示细节。

### 4.2 状态管理：独立 Context vs 扩展 UIStateContext

| 方案                                | 描述                                     | 优缺点                                                                  |
| ----------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| **扩展 UIStateContext**             | 在已有的 UIState 中追加 verboseMode 字段 | ❌ UIStateContext 已有 90+ 行字段，职责过重；消费方需要订阅整个 UIState |
| **独立 VerboseModeContext**（选用） | 新建专属 Context                         | ✅ 语义清晰；消费组件只引入一个轻量 hook；遵循单一职责                  |

**决策：独立 `VerboseModeContext`。**

### 4.3 历史追溯切换：Static 重挂载 vs 废弃 Static

Ink 的 `<Static>` 组件渲染后内容固定，React Context 更新无法触发其子组件重新渲染。两种解法：

| 方案                                          | 描述                                                | 优缺点                                                                      |
| --------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| **废弃 Static，改用动态渲染**                 | 所有历史条目都用普通 Box 渲染                       | ❌ Ink 的 Static 是性能保障；动态渲染历史条目会引起严重性能问题             |
| **利用 historyRemountKey 强制重挂载**（选用） | 修改 `<Static>` 的 key，触发 React 销毁并重建整棵树 | ✅ 复用已有机制；性能影响仅发生在切换瞬间（一次性清屏重绘）；正确性完全保证 |

**决策：调用 `refreshStatic()`（已有函数），该函数执行 `clearTerminal + historyRemountKey + 1`，强制 Static 以最新 Context 值重挂载。**

```
<Static key={`${uiState.historyRemountKey}-${uiState.currentModel}`}>
         ↑ key 变化 → React 销毁重建 → 所有历史以新 verboseMode 重新渲染
```

### 4.4 视口冻结：快照捕获方案

在 `VerboseModeContext` 中增加 `frozenSnapshot: HistoryItemWithoutId[] | null`：

- **进入详细模式且正在流式** → 捕获 `[...pendingHistoryItems]` 浅拷贝
- **MainContent** 渲染 `frozenSnapshot ?? pendingHistoryItems`
- **流式结束** → `useEffect` 自动解冻（用户无需再按一次 Ctrl+O）
- **再次切换** → 清空快照，恢复实时视图

浅拷贝安全性：pending items 在 React 中遵循不可变更新模式，快照引用不会被后续流式操作修改。

---

## 5. 整体架构

```
┌─────────────────────────────────────────────────────┐
│  持久化层                                              │
│  settings.json → ui.verboseMode: boolean             │
│  （默认 false = 精简模式）                              │
└──────────────────────────┬──────────────────────────┘
                           │ 启动时读取 / 切换时写入
┌──────────────────────────▼──────────────────────────┐
│  状态层：AppContainer.tsx                             │
│                                                      │
│  const [verboseMode, setVerboseMode]                 │
│  const [frozenSnapshot, setFrozenSnapshot]           │
│                                                      │
│  Ctrl+O handler:                                     │
│    toggle verboseMode                                │
│    → refreshStatic()          // 追溯切换             │
│    → capture/clear snapshot   // 视口冻结             │
│    → writeSettings                                   │
│                                                      │
│  useEffect([streamingState]):                        │
│    Idle → setFrozenSnapshot(null)  // 自动解冻        │
└──────────────────────────┬──────────────────────────┘
                           │ Context.Provider
┌──────────────────────────▼──────────────────────────┐
│  Context 层：VerboseModeContext.tsx                   │
│  value: { verboseMode, frozenSnapshot }              │
│  export useVerboseMode()                             │
└────────┬──────────────┬──────────────┬──────────────┘
         │              │              │
  HistoryItemDisplay  ToolMessage   MainContent
  思考链条件渲染       工具结果条件   displayItems =
                      渲染           frozenSnapshot ??
                                     pendingHistoryItems
```

### 关键数据流

```
用户按 Ctrl+O
  │
  ├─ [空闲 或 退出详细]
  │   setVerboseMode(newValue)
  │   refreshStatic()  →  stdout.clearTerminal + historyRemountKey+1
  │   setFrozenSnapshot(null)
  │   writeSettings
  │   ↓
  │   React 批处理单次重渲染：
  │   ┌─ <Static> key 变化 → 重挂载 → 所有历史以新 verboseMode 渲染
  │   └─ pending 区域渲染实时内容（compact/verbose）
  │
  └─ [正在流式 + 进入详细]
      setVerboseMode(true)
      refreshStatic()
      setFrozenSnapshot([...pendingHistoryItems])
      writeSettings
      ↓
      React 批处理单次重渲染：
      ┌─ <Static> 重挂载 → 历史以 verboseMode=true 渲染
      └─ MainContent: displayItems = frozenSnapshot（静止快照）
           ↓
           流式继续，pendingHistoryItems 实时更新，但不渲染到屏幕
           ↓
           streamingState → Idle：useEffect → setFrozenSnapshot(null) → 恢复实时视图
```

---

## 6. 实现细节

### 6.1 `VerboseModeContext.tsx`（新建）

```typescript
import { createContext, useContext } from 'react';
import type { HistoryItemWithoutId } from '../types.js';

interface VerboseModeContextType {
  verboseMode: boolean;
  frozenSnapshot: HistoryItemWithoutId[] | null;
}

const VerboseModeContext = createContext<VerboseModeContextType>({
  verboseMode: false, // 默认精简模式
  frozenSnapshot: null,
});

export const useVerboseMode = (): VerboseModeContextType =>
  useContext(VerboseModeContext);

export const VerboseModeProvider = VerboseModeContext.Provider;
```

### 6.2 `settingsSchema.ts` — 新增持久化字段

```typescript
verboseMode: {
  type: 'boolean',
  label: 'Verbose Mode',
  category: 'UI',
  requiresRestart: false,
  default: false,
  description: 'Show full tool output and thinking in verbose mode (toggle with ctrl+o).',
  showInDialog: false,
},
```

`InferSettings<SettingsSchemaType>` 自动推断出 `Settings.ui.verboseMode?: boolean`，无需手动修改 TypeScript interface。

### 6.3 `keyBindings.ts` — 快捷键注册

```typescript
// Command enum
TOGGLE_VERBOSE_MODE = 'toggleVerboseMode',

// defaultKeyBindings
[Command.TOGGLE_VERBOSE_MODE]: [{ key: 'o', ctrl: true }],
```

### 6.4 `AppContainer.tsx` — 状态与处理器

**状态声明：**

```typescript
const [verboseMode, setVerboseMode] = useState<boolean>(
  settings.merged.ui?.verboseMode ?? false,
);

const [frozenSnapshot, setFrozenSnapshot] = useState<
  HistoryItemWithoutId[] | null
>(null);
```

**自动解冻 useEffect：**

```typescript
useEffect(() => {
  if (streamingState === StreamingState.Idle) {
    setFrozenSnapshot(null);
  }
}, [streamingState]);
```

**`pendingHistoryItems` 前置声明**（须在 `handleGlobalKeypress` 之前，避免 TS2448）：

```typescript
const pendingHistoryItems = useMemo(
  () => [...pendingSlashCommandHistoryItems, ...pendingGeminiHistoryItems],
  [pendingSlashCommandHistoryItems, pendingGeminiHistoryItems],
);
```

**Ctrl+O 处理器：**

```typescript
} else if (keyMatchers[Command.TOGGLE_VERBOSE_MODE](key)) {
  const newValue = !verboseMode;
  setVerboseMode(newValue);
  settings.setValue(SettingScope.User, 'ui.verboseMode', newValue);

  // 追溯切换：清屏 + 强制 <Static> 重挂载
  refreshStatic();

  // 视口冻结：进入详细模式且正在流式时捕获快照
  if (newValue && streamingState !== StreamingState.Idle) {
    setFrozenSnapshot([...pendingHistoryItems]);
  } else {
    setFrozenSnapshot(null);
  }
}
```

**Provider：**

```tsx
<VerboseModeProvider value={{ verboseMode, frozenSnapshot }}>
  <ShellFocusContext.Provider value={isFocused}>
    <App />
  </ShellFocusContext.Provider>
</VerboseModeProvider>
```

### 6.5 `HistoryItemDisplay.tsx` — 隐藏思考链

```typescript
const { verboseMode } = useVerboseMode();

// 精简模式下隐藏思考链（包括"正在思考..."动画）
{verboseMode && itemForDisplay.type === 'gemini_thought' && (
  <ThinkMessage ... />
)}
{verboseMode && itemForDisplay.type === 'gemini_thought_content' && (
  <ThinkMessageContent ... />
)}
```

### 6.6 `ToolMessage.tsx` — 隐藏工具结果

```typescript
const { verboseMode } = useVerboseMode();

// 精简模式下将 displayRenderer 替换为 none，跳过结果展示
const effectiveDisplayRenderer = verboseMode
  ? displayRenderer
  : { type: 'none' as const };

// JSX 中使用 effectiveDisplayRenderer 替代 displayRenderer
{effectiveDisplayRenderer.type !== 'none' && (
  <Box ...>...</Box>
)}
```

### 6.7 `MainContent.tsx` — 视口冻结渲染

```typescript
const { frozenSnapshot } = useVerboseMode();

const displayItems = frozenSnapshot ?? pendingHistoryItems;
const isFrozen = frozenSnapshot !== null;

// pending 区域
{displayItems.map((item, i) => (
  <HistoryItemDisplay
    key={i}
    item={{ ...item, id: 0 }}
    isPending={true}
    // 冻结时禁用焦点和 shell 交互，防止快照条目捕获输入
    isFocused={isFrozen ? false : !uiState.isEditorDialogOpen}
    activeShellPtyId={isFrozen ? undefined : uiState.activePtyId}
    embeddedShellFocused={isFrozen ? false : uiState.embeddedShellFocused}
  />
))}
```

### 6.8 `Footer.tsx` — 模式标识

```typescript
const { verboseMode } = useVerboseMode();

// rightItems 末尾追加
if (verboseMode) {
  rightItems.push({
    key: 'verbose',
    node: <Text color={theme.text.accent}>{t('verbose')}</Text>,
  });
}
```

---

## 7. 行为对比与实际效果

### 7.1 渲染内容对比

| 内容                                     | 精简模式  | 详细模式 |
| ---------------------------------------- | --------- | -------- |
| 工具名称                                 | ✅ 显示   | ✅ 显示  |
| 工具状态图标（✓ / ⟳ / ✗）                | ✅ 显示   | ✅ 显示  |
| 工具参数摘要                             | ✅ 显示   | ✅ 显示  |
| 工具执行结果（stdout / 文件内容 / diff） | ❌ 隐藏   | ✅ 显示  |
| 思考链（Thinking / 正在思考...）         | ❌ 隐藏   | ✅ 显示  |
| 最终模型回答                             | ✅ 显示   | ✅ 显示  |
| Footer verbose 标签                      | ❌ 不显示 | ✅ 显示  |

### 7.2 交互行为对比

| 场景                | 初版行为                    | 最终行为                      |
| ------------------- | --------------------------- | ----------------------------- |
| 空闲时按 Ctrl+O     | 只影响后续新输出            | 所有历史条目同步展开/收起 ✅  |
| 流式输出时按 Ctrl+O | pending 区域持续刷新抖动    | pending 区域冻结为静态快照 ✅ |
| 流式结束后          | —                           | 自动解冻，恢复实时视图 ✅     |
| 再次按 Ctrl+O       | —                           | 解冻 + 切换回精简模式 ✅      |
| 切换时提示文字      | 输出"已切换到 xxx 模式"文字 | 无提示，直接生效 ✅           |
| 模式持久化          | ✅                          | ✅                            |
| Footer 标识         | ✅                          | ✅                            |

### 7.3 设计审计

| 审计项               | 分析                                                                                    | 结论        |
| -------------------- | --------------------------------------------------------------------------------------- | ----------- |
| React 状态批处理     | 所有 `setState` 调用在同一事件处理器内，React 18 自动批处理为单次渲染                   | ✅ 安全     |
| `clearTerminal` 时序 | `stdout.write()` 同步执行，先于 React 重渲染，终端清空后以新模式重绘                    | ✅ 正确     |
| 快照不可变性         | `[...pendingHistoryItems]` 浅拷贝；item 对象遵循 React 不可变更新，快照不被后续流式修改 | ✅ 安全     |
| 空快照边界           | `frozenSnapshot = []` 时，`[] ?? x` 取 `[]`（空数组非 nullish），pending 区显示空白     | ✅ 符合预期 |
| 自动解冻             | `useEffect([streamingState])` 在 Idle 时清空，防止流式结束后残留冻结视图                | ✅ 正确     |
| Shell 焦点安全       | 冻结时 `isFocused=false`、`activeShellPtyId=undefined`，防止快照条目获得焦点            | ✅ 安全     |
| AgentChatView 隔离性 | Agent 视图使用独立 `getMessages()` 机制，不受 `frozenSnapshot` 影响                     | ✅ 无影响   |
| tsconfig 排除文件    | `Footer.test.tsx` 被 tsconfig exclude，tsc 未检出；审计中手动发现并修复                 | ✅ 已修复   |

---

## 8. 变更文件清单

| 文件                                                   | 类型    | 说明                                            |
| ------------------------------------------------------ | ------- | ----------------------------------------------- |
| `src/ui/contexts/VerboseModeContext.tsx`               | 🆕 新建 | Context 定义（verboseMode + frozenSnapshot）    |
| `src/config/settingsSchema.ts`                         | ✏️ 修改 | `ui.verboseMode` 字段定义                       |
| `src/config/keyBindings.ts`                            | ✏️ 修改 | `TOGGLE_VERBOSE_MODE` Command + Ctrl+O 绑定     |
| `src/ui/AppContainer.tsx`                              | ✏️ 修改 | state、useEffect、Ctrl+O 处理器、Provider value |
| `src/ui/components/HistoryItemDisplay.tsx`             | ✏️ 修改 | 思考链条件渲染                                  |
| `src/ui/components/messages/ToolMessage.tsx`           | ✏️ 修改 | `effectiveDisplayRenderer` 精简模式跳过结果     |
| `src/ui/components/MainContent.tsx`                    | ✏️ 修改 | `frozenSnapshot` 快照渲染                       |
| `src/ui/components/Footer.tsx`                         | ✏️ 修改 | verbose 标识标签                                |
| `src/i18n/locales/en.js`                               | ✏️ 修改 | 英文 i18n key                                   |
| `src/i18n/locales/zh.js`                               | ✏️ 修改 | 中文翻译                                        |
| `src/i18n/locales/de.js` / `ja.js` / `ru.js` / `pt.js` | ✏️ 修改 | 其他语言占位                                    |
| `docs/users/reference/keyboard-shortcuts.md`           | ✏️ 修改 | Ctrl+O 说明更新                                 |
| `src/ui/keyMatchers.test.ts`                           | ✏️ 修改 | 新增 `TOGGLE_VERBOSE_MODE` 测试                 |
| `src/ui/components/HistoryItemDisplay.test.tsx`        | ✏️ 修改 | 思考链 verbose 测试 + mock 修复                 |
| `src/ui/components/messages/ToolMessage.test.tsx`      | ✏️ 修改 | 工具结果 verbose 测试 + mock 修复               |
| `src/ui/components/Footer.test.tsx`                    | ✏️ 修改 | verbose 标签测试 + mock 修复                    |

---

## 9. 测试结果

### 9.1 自动化测试

```
TypeScript:  0 errors  (npx tsc --noEmit)

Tests:       3727 passed
             7 skipped
             3 failed（均为本次修改前已存在的 Header/AppHeader 品牌测试，与本功能无关）

Test Files:  236 passed | 2 failed (238)
```

### 9.2 关键测试覆盖

| 测试文件                      | 覆盖内容                                    |
| ----------------------------- | ------------------------------------------- |
| `keyMatchers.test.ts`         | Ctrl+O 匹配 / 非 Ctrl+O 不匹配              |
| `ToolMessage.test.tsx`        | 精简模式隐藏工具结果 / 详细模式显示工具结果 |
| `HistoryItemDisplay.test.tsx` | 精简模式隐藏思考链 / 详细模式显示思考链     |
| `Footer.test.tsx`             | 详细模式显示 verbose 标签 / 精简模式不显示  |
