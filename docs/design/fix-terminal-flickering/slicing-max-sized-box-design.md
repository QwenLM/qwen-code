# SlicingMaxSizedBox: 渲染前数据裁剪防闪烁设计方案

> **状态**: 设计评审中
> **日期**: 2026-04-08
> **分支**: feat/fix-terminal-flickering
> **优先级**: P0

## 一、问题定义

### 1.1 现象

当 `verboseMode=true` 时，Agent 执行产生大量输出的命令（如 `npm install`、`git log`、`cat large-file.json`）会导致终端屏幕闪烁，严重影响用户体验。

### 1.2 根因分析

Ink（React for CLI）的渲染流程：

```
数据变化 → React reconciliation → Ink 布局（测量每个 Box 高度）→ 终端写入
```

**Qwen Code 当前行为**：将全部数据（可能 500+ 行）交给 `MaxSizedBox`，由 Ink 先布局全部内容，再用 `overflow="hidden"` 视觉裁剪。但 Ink 仍需计算全部内容的高度——500 行的布局成本与 15 行相差 30 倍以上。每新增一行输出就触发完整重新布局 → 屏幕闪烁。

**关键洞察**：`MaxSizedBox` 的视觉裁剪只是"看不到"，不是"不计算"。Ink 必须布局全部内容才能决定哪些溢出。

### 1.3 实际场景

| 操作                  | 输出量   | 当前表现 | 期望表现       |
| --------------------- | -------- | -------- | -------------- |
| `npm install`         | ~500 行  | 闪烁     | 稳定 15 行窗口 |
| `git log --oneline`   | ~200 行  | 闪烁     | 稳定 15 行窗口 |
| `find . -name "*.ts"` | ~1000 行 | 严重闪烁 | 稳定 15 行窗口 |
| `cat large-file.json` | ~5000 行 | 卡顿     | 稳定 15 行窗口 |

## 二、Gemini CLI 解决方案分析

> 参考文档：[Tool Output Height Limiting Deep Dive](https://github.com/wenshao/codeagents/blob/main/docs/comparison/tool-output-height-limiting-deep-dive.md)

### 2.1 四层防线架构

Gemini CLI 使用四层递进式限制：

```
原始数据 (可能 10MB)
  │
  ├─ 第 1 层：后台 buffer 上限（shellReducer: MAX_SHELL_OUTPUT_SIZE = 10MB）
  ├─ 第 2 层：字符数裁剪（SlicingMaxSizedBox: 20,000 字符）
  ├─ 第 3 层：行数裁剪（SlicingMaxSizedBox: .slice(-maxLines)，渲染前裁剪）
  └─ 第 4 层：视觉裁剪（MaxSizedBox: overflow="hidden"，兜底）
```

### 2.2 SlicingMaxSizedBox 核心逻辑

```typescript
const MAXIMUM_RESULT_DISPLAY_CHARACTERS = 20000;

export function SlicingMaxSizedBox({ data, maxLines, ... }) {
  const { truncatedData } = useMemo(() => {
    let text = data;
    // 字符裁剪
    if (text.length > MAXIMUM_RESULT_DISPLAY_CHARACTERS) {
      text = '...' + text.slice(-MAXIMUM_RESULT_DISPLAY_CHARACTERS);
    }
    // 行数裁剪（关键！渲染前只保留最后 N 行）
    if (maxLines !== undefined) {
      const lines = text.split('\n');
      if (lines.length > maxLines) {
        text = lines.slice(-(maxLines - 1)).join('\n');
      }
    }
    return { truncatedData: text };
  }, [data, maxLines]);

  return <MaxSizedBox {...boxProps}>{children(truncatedData)}</MaxSizedBox>;
}
```

### 2.3 关键差异

| 机制             | Gemini CLI                               | Qwen Code（当前）          |
| ---------------- | ---------------------------------------- | -------------------------- |
| 渲染前行数裁剪   | `SlicingMaxSizedBox` `.slice(-maxLines)` | 无                         |
| 字符上限         | 20,000 (20KB)                            | 1,000,000 (1MB)，50 倍差距 |
| Shell 输出硬上限 | 15 行                                    | 无（= 终端高度）           |
| 布局成本         | O(15) = 常数时间                         | O(输出行数)                |

## 三、Qwen Code 改进方案

### 3.1 核心思路

在 `MaxSizedBox` 之外包裹 `SlicingMaxSizedBox`，在 React 渲染**之前**用 `useMemo()` 将数据 `.slice()` 到 `maxLines` 行。Ink 只收到 15 行数据 → 布局瞬间完成 → 无闪烁。

### 3.2 数据流（改进后）

```
原始数据 (可能 500 行)
  │
  ├─ 第 1 层：字符截断（MAXIMUM_RESULT_DISPLAY_CHARACTERS = 20,000）
  │   useMemo() 内 .slice() 到 20KB
  │
  ├─ 第 2 层：行数裁剪（渲染前）
  │   useMemo() 内 lines.slice(-maxLines)
  │   最终只有 ≤15 行进入 React 渲染树
  │
  └─ 第 3 层：视觉裁剪（兜底）
      MaxSizedBox: maxHeight + overflow="hidden"
```

### 3.3 涉及文件

| 操作     | 文件                                                           | 说明                                               |
| -------- | -------------------------------------------------------------- | -------------------------------------------------- |
| **新建** | `packages/cli/src/ui/components/shared/SlicingMaxSizedBox.tsx` | 渲染前裁剪组件（~100 行）                          |
| **修改** | `packages/cli/src/ui/components/messages/ToolMessage.tsx`      | 用 `SlicingMaxSizedBox` 包裹 string 类型工具输出   |
| **修改** | `packages/cli/src/ui/components/messages/ToolMessage.tsx`      | 降低 `MAXIMUM_RESULT_DISPLAY_CHARACTERS` 到 20,000 |

### 3.4 SlicingMaxSizedBox 组件设计

```typescript
// packages/cli/src/ui/components/shared/SlicingMaxSizedBox.tsx

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { MaxSizedBox } from './MaxSizedBox.js';
import { theme } from '../../semantic-colors.js';

/**
 * 渲染前字符上限。
 * 与 MaxSizedBox 的视觉裁剪不同，SlicingMaxSizedBox 在 React 渲染前
 * 就将数据裁剪到安全范围，避免 Ink 布局大量不可见内容导致的性能问题。
 */
export const MAXIMUM_RESULT_DISPLAY_CHARACTERS = 20000;

interface SlicingMaxSizedBoxProps {
  /** 原始文本数据 */
  data: string;
  /** 最大显示行数（渲染前裁剪） */
  maxLines: number | undefined;
  /** MaxSizedBox 的 maxHeight（视觉裁剪兜底） */
  maxHeight: number | undefined;
  /** MaxSizedBox 的 maxWidth */
  maxWidth: number;
  /** 溢出方向 */
  overflowDirection?: 'top' | 'bottom';
  /** 渲染裁剪后数据的回调 */
  children: (truncatedData: string) => React.ReactNode;
}

export const SlicingMaxSizedBox: React.FC<SlicingMaxSizedBoxProps> = ({
  data,
  maxLines,
  maxHeight,
  maxWidth,
  overflowDirection = 'top',
  children,
}) => {
  const { truncatedData, hiddenLineCount } = useMemo(() => {
    let text = data;
    let hidden = 0;

    // 第 1 层：字符裁剪
    if (text.length > MAXIMUM_RESULT_DISPLAY_CHARACTERS) {
      text = '...' + text.slice(-MAXIMUM_RESULT_DISPLAY_CHARACTERS);
    }

    // 第 2 层：行数裁剪
    if (maxLines !== undefined && maxLines > 0) {
      const lines = text.split('\n');
      if (lines.length > maxLines) {
        const targetLines = Math.max(1, maxLines - 1); // 留 1 行给 "hidden" 提示
        hidden = lines.length - targetLines;
        if (overflowDirection === 'top') {
          text = lines.slice(-targetLines).join('\n');
        } else {
          text = lines.slice(0, targetLines).join('\n');
        }
      }
    }

    return { truncatedData: text, hiddenLineCount: hidden };
  }, [data, maxLines, overflowDirection]);

  return (
    <MaxSizedBox
      maxHeight={maxHeight}
      maxWidth={maxWidth}
      overflowDirection={overflowDirection}
      additionalHiddenLinesCount={hiddenLineCount}
    >
      {children(truncatedData)}
    </MaxSizedBox>
  );
};
```

### 3.5 ToolMessage.tsx 修改

#### 修改 1：导入 SlicingMaxSizedBox 和共享的字符上限常量

```diff
- import { MaxSizedBox } from '../shared/MaxSizedBox.js';
+ import {
+   SlicingMaxSizedBox,
+   MAXIMUM_RESULT_DISPLAY_CHARACTERS,
+ } from '../shared/SlicingMaxSizedBox.js';
```

`MAXIMUM_RESULT_DISPLAY_CHARACTERS`（20,000）从 SlicingMaxSizedBox 导出，供 markdown 路径复用。

#### 修改 2：StringResultRenderer 使用 SlicingMaxSizedBox + markdown 路径截断保护

```diff
  const StringResultRenderer: React.FC<{
    data: string;
    renderAsMarkdown: boolean;
    availableHeight?: number;
    childWidth: number;
  }> = ({ data, renderAsMarkdown, availableHeight, childWidth }) => {
-   let displayData = data;
-
-   // Truncate if too long
-   if (displayData.length > MAXIMUM_RESULT_DISPLAY_CHARACTERS) {
-     displayData = '...' + displayData.slice(-MAXIMUM_RESULT_DISPLAY_CHARACTERS);
-   }
+   // Truncate oversized data for the markdown path as well, since
+   // MarkdownDisplay has no pre-render slicing of its own.
+   const markdownData =
+     data.length > MAXIMUM_RESULT_DISPLAY_CHARACTERS
+       ? '...' + data.slice(-MAXIMUM_RESULT_DISPLAY_CHARACTERS)
+       : data;

    if (renderAsMarkdown) {
      return (
        <Box flexDirection="column">
          <MarkdownDisplay
-           text={displayData}
+           text={markdownData}
            isPending={false}
            availableTerminalHeight={availableHeight}
            contentWidth={childWidth}
          />
        </Box>
      );
    }

    return (
-     <MaxSizedBox maxHeight={availableHeight} maxWidth={childWidth}>
-       <Box>
-         <Text wrap="wrap" color={theme.text.primary}>
-           {displayData}
-         </Text>
-       </Box>
-     </MaxSizedBox>
+     <SlicingMaxSizedBox
+       data={data}
+       maxLines={availableHeight}
+       maxHeight={availableHeight}
+       maxWidth={childWidth}
+     >
+       {(truncatedData) => (
+         <Box>
+           <Text wrap="wrap" color={theme.text.primary}>
+             {truncatedData}
+           </Text>
+         </Box>
+       )}
+     </SlicingMaxSizedBox>
    );
  };
```

### 3.6 与现有 verbose/compact 模式的关系

| 模式                   | 行为                                  | 闪烁风险     |
| ---------------------- | ------------------------------------- | ------------ |
| compact 模式           | 完全隐藏工具输出                      | 无（不渲染） |
| verbose 模式（改进前） | 显示全部输出，MaxSizedBox 视觉裁剪    | **有闪烁**   |
| verbose 模式（改进后） | SlicingMaxSizedBox 渲染前裁剪到 15 行 | **无闪烁**   |

两者互补：compact 模式解决"要不要看"，SlicingMaxSizedBox 解决 verbose 模式下"看多少"。

## 四、改进前后对比

### 改进前

```
npm install 输出 500 行
  → ToolMessage 传入 500 行到 MaxSizedBox
  → Ink 布局 500 行（计算每行宽度、换行、高度）
  → 每新增一行触发完整重布局
  → 屏幕闪烁
```

### 改进后

```
npm install 输出 500 行
  → SlicingMaxSizedBox useMemo() 裁剪到 15 行
  → Ink 布局 15 行
  → 布局瞬间完成
  → 无闪烁
```

**布局成本**：从 O(输出行数) 降到 O(15) = 常数时间。

## 五、验证方案

1. **手动测试**：在 verbose 模式下运行以下命令，确认无闪烁：
   - `npm install`（~500 行输出）
   - `git log --oneline`（~200 行输出）
   - `find . -name "*.ts"`（~1000 行输出）
   - `cat` 一个大文件（~5000 行）

2. **回归验证**：
   - compact 模式下工具输出仍正常隐藏
   - verbose 模式下短输出（<15 行）仍完整显示
   - "... first N lines hidden ..." 提示正确显示
   - Ctrl+S 展开功能仍正常工作（`ShowMoreLines` 组件）
   - ANSI 输出（AnsiOutputText）不受影响（已有独立的 slice 逻辑）
   - Diff 输出不受影响（使用独立的 DiffRenderer）

3. **边界情况**：
   - 输出为空时不出错
   - 输出恰好等于 maxLines 时不裁剪
   - Unicode/中文字符正确处理（依赖 MaxSizedBox 的 stringWidth）

## 六、实现成本评估

| 维度     | 评估                                        |
| -------- | ------------------------------------------- |
| 涉及文件 | 3 个（新建 1 个，修改 1 个，可能微调 1 个） |
| 新增代码 | ~100 行（SlicingMaxSizedBox）               |
| 修改代码 | ~20 行（ToolMessage.tsx）                   |
| 开发周期 | ~0.5 天                                     |
| 风险     | 低 — 纯 UI 层改动，不影响核心逻辑           |
