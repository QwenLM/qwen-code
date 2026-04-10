# 紧凑模式设计：竞品分析与优化方案

> Ctrl+O 紧凑/详细模式切换 —— 与 Claude Code 的竞品分析、当前实现评审及优化建议。
>
> 用户文档：[设置 — ui.compactMode](../../users/configuration/settings.md)。

## 1. 概要

Qwen Code 和 Claude Code 都提供了 Ctrl+O 快捷键来切换紧凑和详细的工具输出视图，但**设计理念、默认状态和交互模型存在根本性差异**。本文档提供源码级深度对比，识别用户体验差距，并提出 Qwen Code 的优化方案。

| 维度           | Claude Code                          | Qwen Code                              |
| -------------- | ------------------------------------ | -------------------------------------- |
| 默认模式       | 紧凑（verbose=false）                | 详细（compactMode=false）              |
| 切换语义       | 临时查看详情                         | 持久偏好切换                           |
| 持久化         | 仅当前会话，重启后重置               | 持久化到 settings.json                 |
| 作用范围       | 全局屏幕切换（prompt ↔ transcript） | 组件级渲染切换                         |
| 冻结快照       | 无此概念                             | 基础设施存在，当前未使用               |
| 单工具展开提示 | 有（"ctrl+o to expand"）             | 有（"按 Ctrl+O 查看详细工具调用结果"） |

## 2. Claude Code 实现分析

### 2.1 架构

Claude Code 采用**屏幕级**切换方式，而非组件级渲染开关：

```
┌──────────────────────────────────┐
│         AppState (Zustand)       │
│  verbose: boolean（默认 false）   │
│  screen: 'prompt' | 'transcript' │
└──────────┬───────────────────────┘
           │
     ┌─────┴──────┐
     │  Ctrl+O    │  切换屏幕模式
     │  处理器     │  不是渲染标志
     └─────┬──────┘
           │
     ┌─────▼──────────────┐
     │    REPL.tsx         │
     │  screen='prompt'  → 紧凑视图（默认）
     │  screen='transcript'→ 详细视图
     └────────────────────┘
```

### 2.2 关键源文件

| 组件       | 文件                                               | 关键逻辑                                          |
| ---------- | -------------------------------------------------- | ------------------------------------------------- |
| 切换处理器 | `src/hooks/useGlobalKeybindings.tsx:90-132`        | 在 `'prompt'` 和 `'transcript'` 之间切换 `screen` |
| 快捷键绑定 | `src/keybindings/defaultBindings.ts:44`            | `app:toggleTranscript`                            |
| 状态定义   | `src/state/AppStateStore.ts:472`                   | `verbose: false`（仅会话级）                      |
| 展开提示   | `src/components/CtrlOToExpand.tsx:29-46`           | 单工具 "(ctrl+o to expand)" 提示文本              |
| 消息过滤   | `src/components/Messages.tsx:93-151`               | `filterForBriefTool()` 用于紧凑视图               |
| 权限弹窗   | `src/components/permissions/PermissionRequest.tsx` | 在 overlay 层渲染，永远不会被隐藏                 |

### 2.3 设计决策

1. **紧凑是默认模式。** 用户开箱即看到简洁界面，详情需主动查看。
2. **会话级作用域。** `verbose` 在每次新会话时重置为 `false` —— Claude Code 假设用户通常偏好紧凑视图，只是临时需要详情。
3. **屏幕级切换。** Ctrl+O 不改变组件的渲染方式，而是在"prompt"屏幕（紧凑）和"transcript"屏幕（详细）之间切换整个显示。
4. **无冻结快照。** 不存在快照冻结的概念。切换时显示立即更新为当前状态。
5. **权限对话框独立。** 工具授权在专用 overlay 层渲染，永远不受 verbose/compact 切换影响。
6. **单工具提示。** `CtrlOToExpand` 组件在产生大量输出的工具上显示上下文提示，在子代理中被抑制。

### 2.4 用户流程

```
会话开始 → 紧凑模式（默认）
     │
     ├─ 工具输出被汇总为单行
     ├─ 大量输出的工具显示 "(ctrl+o to expand)" 提示
     │
     ├─ 用户按 Ctrl+O
     │     └─→ 屏幕切换到 transcript（详细视图）
     │         └─ 用户看到所有工具输出、思考过程等
     │
     ├─ 用户再按 Ctrl+O
     │     └─→ 屏幕切回 prompt（紧凑模式）
     │
     └─ 会话结束 → verbose 重置为 false
```

## 3. Qwen Code 实现分析

### 3.1 架构

Qwen Code 采用**组件级渲染标志**，每个 UI 组件从 context 中读取：

```
┌─────────────────────────────────────┐
│      CompactModeContext             │
│  compactMode: boolean（默认 false）  │
│  frozenSnapshot: items[] | null     │
│  setCompactMode: (v) => void        │
└──────────┬──────────────────────────┘
           │
     ┌─────┴──────┐
     │  Ctrl+O    │  切换 compactMode
     │  处理器     │  持久化到设置
     └─────┬──────┘
           │
     ┌─────▼──────────────────┐
     │  每个组件读取           │
     │  compactMode 并        │
     │  决定如何渲染           │
     └────────────────────────┘
           │
     ┌─────▼──────────────────────────────┐
     │  ToolGroupMessage                   │
     │    showCompact = compactMode        │
     │      && !hasConfirmingTool          │
     │      && !hasErrorTool               │
     │      && !isEmbeddedShellFocused     │
     │      && !isUserInitiated            │
     └────────────────────────────────────┘
```

### 3.2 关键源文件

| 组件       | 文件                                  | 关键逻辑                                          |
| ---------- | ------------------------------------- | ------------------------------------------------- |
| 切换处理器 | `AppContainer.tsx:1684-1694`          | 切换 `compactMode`，持久化，清除快照              |
| Context    | `CompactModeContext.tsx`              | `compactMode`、`frozenSnapshot`、`setCompactMode` |
| 工具组     | `ToolGroupMessage.tsx:105-110`        | `showCompact` 含 4 个强制展开条件                 |
| 工具消息   | `ToolMessage.tsx:346-350`             | 紧凑模式下隐藏 `displayRenderer`                  |
| 紧凑显示   | `CompactToolGroupDisplay.tsx:49-108`  | 带状态和提示的单行摘要                            |
| 确认消息   | `ToolConfirmationMessage.tsx:113-147` | 简化的 3 选项紧凑确认 UI                          |
| 启动提示   | `Tips.tsx:14-29`                      | 启动提示轮播中包含紧凑模式提示                    |
| 设置同步   | `SettingsDialog.tsx:189-192`          | 与 CompactModeContext 同步                        |
| 主内容区   | `MainContent.tsx:63-72`               | frozenSnapshot 含 WaitingForConfirmation 保护     |
| 思考内容   | `HistoryItemDisplay.tsx:123-133`      | 紧凑模式下隐藏 `gemini_thought`                   |

### 3.3 设计决策

1. **详细是默认模式。** 用户默认看到所有工具输出和思考过程。
2. **持久化偏好。** `compactMode` 保存到 `settings.json`，跨会话保持。
3. **组件级渲染。** 每个组件从 context 读取 `compactMode` 并调整自身渲染。
4. **强制展开保护。** 四个条件覆盖紧凑模式，确保关键 UI 元素始终可见（确认、错误、Shell、用户发起的操作）。
5. **无快照冻结。** 虽然 `frozenSnapshot` 基础设施存在，但从未激活 —— 切换始终显示实时输出。
6. **设置对话框同步。** 从设置中切换紧凑模式时，通过 `setCompactMode` 立即更新 React 状态。
7. **非侵入式可发现性。** 紧凑模式通过启动提示轮播引导用户发现，而非在底部栏持续显示，避免 UI 杂乱。

### 3.4 用户流程

```
会话开始 → 详细模式（默认）
     │
     ├─ 所有工具输出、思考过程、详情可见
     ├─ 启动提示可能随机显示"按 Ctrl+O 切换紧凑模式"
     │
     ├─ 用户按 Ctrl+O（或在设置中切换）
     │     └─→ compactMode = true，持久化
     │         ├─ 工具组显示单行摘要
     │         ├─ 思考内容被隐藏
     │         └─ 确认、错误、Shell 仍然展开
     │
     ├─ 用户再按 Ctrl+O
     │     └─→ compactMode = false，持久化
     │         └─ 所有详情重新可见
     │
     └─ 下次会话 → 保持上次使用的模式
```

## 4. 关键差异深度对比

### 4.1 默认模式理念

| 方面     | Claude Code（默认紧凑）          | Qwen Code（默认详细）           |
| -------- | -------------------------------- | ------------------------------- |
| 第一印象 | 简洁、精练 —— 专业感             | 信息丰富 —— 完全透明            |
| 学习曲线 | 用户需学会 Ctrl+O 才能看详情     | 用户立即看到一切                |
| 目标用户 | 信任工具的资深用户               | 需要了解发生了什么的用户        |
| 信息过载 | 默认避免                         | 新用户可能感到信息过载          |
| 可发现性 | 单工具 "(ctrl+o to expand)" 提示 | 启动提示轮播 + ? 快捷键 + /help |

**分析：** Claude Code 的紧凑默认之所以有效，是因为其用户群体主要是信任工具、不需要查看每次工具调用的资深开发者。Qwen Code 的详细默认适合当前阶段 —— 通过透明度建立用户信任更为重要。

### 4.2 持久化模型

| 方面         | Claude Code          | Qwen Code                  |
| ------------ | -------------------- | -------------------------- |
| 是否持久化？ | 否 —— 仅当前会话     | 是 —— 保存到 settings.json |
| 设计理由     | 详细模式只是临时查看 | 模式是用户偏好             |
| 重启行为     | 始终从紧凑模式开始   | 从上次使用的模式开始       |

**分析：** Claude Code 将详情查看视为临时需求 —— 看完就回去。Qwen Code 将其视为稳定偏好 —— 有些用户始终需要详情，有些始终需要紧凑。两者都合理；Qwen Code 的方式更灵活。

### 4.3 确认保护机制

| 方面        | Claude Code                    | Qwen Code                        |
| ----------- | ------------------------------ | -------------------------------- |
| 机制        | Overlay/模态层（结构性分离）   | `showCompact` 中的强制展开条件   |
| 覆盖范围    | 完全 —— 授权永远不会被隐藏     | 完全 —— 4 个条件覆盖所有交互状态 |
| 紧凑确认 UI | 不适用（overlay 始终完整显示） | 简化的 3 选项 RadioButtonSelect  |

**分析：** Claude Code 的架构分离（overlay 层）更加健壮。Qwen Code 的强制展开方式有效，但需要每个新的交互状态都显式添加到条件列表中。

### 4.4 渲染方式

| 方面     | Claude Code                    | Qwen Code                  |
| -------- | ------------------------------ | -------------------------- |
| 切换范围 | 屏幕级（prompt ↔ transcript） | 组件级（每个组件自行决定） |
| 粒度     | 全有或全无                     | 细粒度，按组件             |
| 灵活性   | 低 —— 全局开关                 | 高 —— 组件可覆盖           |
| 一致性   | 保证一致                       | 取决于每个组件的实现       |

**分析：** Qwen Code 的组件级方式更灵活（如针对特定条件的强制展开），但需要更多纪律来维护一致性。Claude Code 的屏幕级方式更简单，保证行为一致。

## 5. 优化建议

### 5.1 [P0] 保持详细模式为默认 —— 无需改动

Qwen Code 当前阶段以详细模式为默认是正确的选择。新用户需要透明度来建立对工具的信任。随着产品成熟，可考虑将紧凑作为默认（与 Claude Code 一致）。

### 5.2 [P1] 简化 frozenSnapshot 基础设施

当前 `frozenSnapshot` 状态和基础设施存在但从未使用（始终为 null）。两个选项：

- **方案 A —— 完全移除。** 清理死代码。如果未来需要单工具展开，重新实现。
- **方案 B —— 保留基础设施。** 如果计划添加 Claude Code 风格的单工具 "(ctrl+o to expand)" 临时展开功能，可直接复用。

**建议：** 方案 B —— 保留基础设施，但添加代码注释标记其为未来单工具展开预留。

### 5.3 [P1] 大输出工具的单工具展开

Claude Code 在产生大量输出的工具上显示 "(ctrl+o to expand)"。Qwen Code 当前只有全局切换。建议：

- 当单个工具输出超过 N 行时，在紧凑模式下显示单工具"展开"提示。
- 可复用现有的 `frozenSnapshot` 基础设施。
- 范围：未来增强，非当前优先级。

### 5.4 [P2] 考虑会话级覆盖

部分用户可能希望紧凑模式作为默认，但偶尔需要在某个会话中使用详细模式。建议同时支持：

- `settings.json` → 持久默认值（当前行为）
- 会话中按 Ctrl+O → 仅覆盖当前会话（Claude Code 行为）
- 会话重启 → 恢复 settings.json 中的值

这让用户两全其美。实现需要将"设置默认值"与"会话覆盖"状态分离。

### 5.5 [P2] 确认弹窗的结构性分离

当前确认保护依赖 `ToolGroupMessage` 中的 `showCompact` 条件。建议更健壮的方式：

- 将确认弹窗渲染在独立层中（类似 Claude Code 的 overlay 方式）。
- 这将使紧凑模式在架构上不可能影响确认弹窗。
- 优先级较低，因为当前强制展开方式工作正常。

## 6. 当前实现状态

`feat/compact-mode-optimization` 分支变更后：

| 功能                       | 状态   | 说明                                   |
| -------------------------- | ------ | -------------------------------------- |
| 启动提示引导               | 已完成 | 紧凑模式提示加入 Tips 轮播（非侵入式） |
| Ctrl+O 加入快捷键列表（?） | 已完成 | 添加到 KeyboardShortcuts 组件          |
| Ctrl+O 加入 /help          | 已完成 | 添加到 Help 组件                       |
| 设置对话框同步             | 已完成 | compactMode 与 CompactModeContext 同步 |
| 无快照冻结                 | 已完成 | 切换始终显示实时输出                   |
| 确认保护                   | 已完成 | 强制展开 + WaitingForConfirmation 防护 |
| Shell 保护                 | 已完成 | `!isEmbeddedShellFocused` 强制展开     |
| 错误保护                   | 已完成 | `!hasErrorTool` 强制展开               |
| 用户文档已更新             | 已完成 | settings.md、keyboard-shortcuts.md     |

## 7. 文件索引

### Qwen Code

| 文件                                                                  | 用途                                     |
| --------------------------------------------------------------------- | ---------------------------------------- |
| `packages/cli/src/ui/AppContainer.tsx`                                | 切换处理器、状态初始化、context provider |
| `packages/cli/src/ui/contexts/CompactModeContext.tsx`                 | Context 定义                             |
| `packages/cli/src/ui/components/messages/ToolGroupMessage.tsx`        | 强制展开逻辑                             |
| `packages/cli/src/ui/components/messages/ToolMessage.tsx`             | 单工具输出隐藏                           |
| `packages/cli/src/ui/components/messages/CompactToolGroupDisplay.tsx` | 紧凑视图渲染                             |
| `packages/cli/src/ui/components/messages/ToolConfirmationMessage.tsx` | 紧凑确认 UI                              |
| `packages/cli/src/ui/components/MainContent.tsx`                      | frozenSnapshot 渲染                      |
| `packages/cli/src/ui/components/Tips.tsx`                             | 启动提示含紧凑模式引导                   |
| `packages/cli/src/ui/components/Help.tsx`                             | /help 快捷键条目                         |
| `packages/cli/src/ui/components/KeyboardShortcuts.tsx`                | ? 快捷键条目                             |
| `packages/cli/src/ui/components/SettingsDialog.tsx`                   | 设置同步                                 |
| `packages/cli/src/ui/components/HistoryItemDisplay.tsx`               | 思考内容隐藏                             |
| `packages/cli/src/config/settingsSchema.ts`                           | 设置定义                                 |
| `packages/cli/src/config/keyBindings.ts`                              | Ctrl+O 绑定                              |

### Claude Code（参考）

| 文件                                               | 用途                       |
| -------------------------------------------------- | -------------------------- |
| `src/hooks/useGlobalKeybindings.tsx`               | 切换处理器                 |
| `src/state/AppStateStore.ts`                       | 状态定义（verbose: false） |
| `src/components/CtrlOToExpand.tsx`                 | 单工具展开提示             |
| `src/components/Messages.tsx`                      | 简要消息过滤               |
| `src/screens/REPL.tsx`                             | 屏幕级模式切换             |
| `src/components/permissions/PermissionRequest.tsx` | 基于 overlay 的确认弹窗    |
