# Height Stabilization: 高度稳定化防闪烁设计方案

> **状态**: 设计评审中
> **日期**: 2026-04-08
> **分支**: feat/fix-terminal-flickering
> **优先级**: P1（Phase 2，依赖 Phase 1 SlicingMaxSizedBox）

## 一、问题定义

### 1.1 现象

即使 Phase 1（SlicingMaxSizedBox）已解决大数据量导致的布局成本问题，verbose 模式下仍有一类闪烁：**工具输出的显示行数会突然跳变**。当输出速度快时，行数在 8→15→10→13 之间跳动，造成视觉闪烁。

### 1.2 根因分析

`availableTerminalHeight` 是动态计算的：

```typescript
// AppContainer.tsx:1044-1047
const availableTerminalHeight = Math.max(
  0,
  terminalHeight - controlsHeight - staticExtraHeight - 2 - tabBarHeight,
);
```

在工具执行期间，以下因素导致该值频繁变化：

#### 因素 1：controlsHeight 重测量（最频繁）

```typescript
// AppContainer.tsx:1027-1034
useLayoutEffect(() => {
  if (mainControlsRef.current) {
    const fullFooterMeasurement = measureElement(mainControlsRef.current);
    if (fullFooterMeasurement.height > 0) {
      setControlsHeight(fullFooterMeasurement.height);
    }
  }
}, [buffer, terminalWidth, terminalHeight]);
```

每次 `buffer` 变化（用户输入、光标移动）都触发 footer 重测量。测量结果可能波动 1-3 行（如 prompt suggestions 出现/消失、多行输入）。

#### 因素 2：工具数量变化（ToolGroupMessage）

```typescript
// ToolGroupMessage.tsx:107-115
const availableTerminalHeightPerToolMessage = availableTerminalHeight
  ? Math.max(
      Math.floor(
        (availableTerminalHeight - staticHeight - countOneLineToolCalls) /
          Math.max(1, countToolCallsWithResults),
      ),
      1,
    )
  : undefined;
```

当新工具加入或某工具首次获得结果时，等分公式导致所有工具的分配高度同时大幅变化。例如：

- 2 个工具 → 各 15 行
- 新增第 3 个工具 → 各 9 行（突降 6 行）

#### 因素 3：tabBarHeight 切换

```typescript
const tabBarHeight = agentViewState.agents.size > 0 ? 1 : 0;
```

Subagent 创建时从 0→1，所有工具高度立即减少 1 行。

### 1.3 为什么终端渲染天然存在此问题

终端 UI 使用 ANSI `eraseLines` 逐行擦除再重写——没有双缓冲或合成。任何高度变化意味着擦除不同数量的行并重写，视觉上可感知。Ink 的 32ms 节流有帮助但无法完全隐藏布局跳变。

## 二、技术方案调研

### 2.1 Ink 渲染管线现状

| 机制         | 实现                            | 效果                           |
| ------------ | ------------------------------- | ------------------------------ |
| 渲染节流     | `throttle(onRender, 32)` ~31FPS | 减少渲染频率，但不阻止高度跳变 |
| 输出缓存     | `this.lastOutput` 比较          | 输出相同时跳过写入             |
| 光标隐藏     | `cli-cursor.hide()`             | 隐藏光标闪烁                   |
| Static 组件  | 已完成的历史不再重渲染          | 减少动态区域范围               |
| 终端宽度去抖 | 300ms 延迟 refreshStatic        | 防止 resize 级联               |

**关键缺失**：没有对高度变化的稳定化处理。每次计算出的高度立即传播到所有子组件。

### 2.2 业界常见方案

| 方案          | 原理                               | 适用场景     | 局限                   |
| ------------- | ---------------------------------- | ------------ | ---------------------- |
| **高度锁定**  | 流式输出期间冻结高度值             | 连续输出场景 | 真实的布局变化也被忽略 |
| **单调递增**  | 只允许高度增加，不允许减少         | 内容持续增长 | 无法响应终端缩小       |
| **去抖/节流** | 延迟高度更新                       | 高频波动     | 增加响应延迟           |
| **阈值过滤**  | 忽略小幅变化，只接受大幅变化       | 噪声过滤     | 需要选择合适的阈值     |
| **混合策略**  | 根据状态（streaming/idle）切换策略 | 复杂交互场景 | 实现稍复杂             |

### 2.3 推荐方案：状态感知的高度稳定化

核心思路：**流式输出期间，高度应该稳定而非精确。** 用户不需要输出流动时的像素级高度跟踪，他们需要的是视觉稳定性。高度可以在流式暂停时"追上"真实值。

规则：

1. **高度增加**（更多空间）→ 立即接受（不会导致内容跳动，只是多了空行）
2. **小幅高度减少**（<5行）且在流式输出中 → 吸收波动，保持缓存值
3. **大幅高度减少**（≥5行）→ 接受变化（可能是真实的布局变更，如对话框出现）
4. **空闲状态** → 立即同步到真实值

## 三、详细设计

### 3.1 `useStableHeight` Hook

```typescript
// packages/cli/src/ui/hooks/useStableHeight.ts

import { useRef } from 'react';

/**
 * Stabilizes a height value during streaming to prevent visual flickering.
 *
 * During active streaming, small height decreases (< threshold) are absorbed
 * to maintain visual stability. Height increases are always accepted since
 * they don't cause content to jump. When idle, the value syncs immediately.
 *
 * @param rawHeight - The real-time computed height
 * @param isStreaming - Whether content is actively streaming
 * @returns Stabilized height value
 */
export function useStableHeight(
  rawHeight: number,
  isStreaming: boolean,
): number {
  const stableRef = useRef(rawHeight);
  const lastUpdateRef = useRef(Date.now());

  const SIGNIFICANT_DECREASE_THRESHOLD = 5; // lines
  const STALE_TIMEOUT_MS = 2000; // 2 seconds

  if (!isStreaming) {
    // Idle: sync immediately for accuracy
    stableRef.current = rawHeight;
    lastUpdateRef.current = Date.now();
  } else {
    const delta = rawHeight - stableRef.current;
    const timeSinceUpdate = Date.now() - lastUpdateRef.current;

    if (delta > 0) {
      // More space available — always safe to expand
      stableRef.current = rawHeight;
      lastUpdateRef.current = Date.now();
    } else if (
      delta < -SIGNIFICANT_DECREASE_THRESHOLD ||
      timeSinceUpdate > STALE_TIMEOUT_MS
    ) {
      // Significant shrink or stale cache — accept change
      stableRef.current = rawHeight;
      lastUpdateRef.current = Date.now();
    }
    // Otherwise: absorb the small fluctuation
  }

  return stableRef.current;
}
```

### 3.2 AppContainer 集成

```diff
  // AppContainer.tsx
+ import { useStableHeight } from '../hooks/useStableHeight.js';

  // Line ~1044
- const availableTerminalHeight = Math.max(
+ const rawAvailableHeight = Math.max(
    0,
    terminalHeight - controlsHeight - staticExtraHeight - 2 - tabBarHeight,
  );
+ const availableTerminalHeight = useStableHeight(
+   rawAvailableHeight,
+   streamingState === StreamingState.Responding,
+ );
```

### 3.3 ToolGroupMessage 最低高度保障

```diff
  // ToolGroupMessage.tsx
+ const MIN_TOOL_OUTPUT_HEIGHT = 8;

  const availableTerminalHeightPerToolMessage = availableTerminalHeight
    ? Math.max(
-       Math.floor(
-         (availableTerminalHeight - staticHeight - countOneLineToolCalls) /
-           Math.max(1, countToolCallsWithResults),
-       ),
-       1,
+       MIN_TOOL_OUTPUT_HEIGHT,
+       Math.floor(
+         (availableTerminalHeight - staticHeight - countOneLineToolCalls) /
+           Math.max(1, countToolCallsWithResults),
+       ),
      )
    : undefined;
```

### 3.4 涉及文件

| 操作     | 文件                                                           | 说明                                            |
| -------- | -------------------------------------------------------------- | ----------------------------------------------- |
| **新建** | `packages/cli/src/ui/hooks/useStableHeight.ts`                 | 高度稳定化 Hook（~40 行）                       |
| **修改** | `packages/cli/src/ui/AppContainer.tsx`                         | 用 useStableHeight 包裹 availableTerminalHeight |
| **修改** | `packages/cli/src/ui/components/messages/ToolGroupMessage.tsx` | 增加 MIN_TOOL_OUTPUT_HEIGHT                     |

## 四、方案分析

### 4.1 改进前后对比

**场景：streaming 期间 controlsHeight 波动 2 行**

|                         | 改进前           | 改进后     |
| ----------------------- | ---------------- | ---------- |
| availableTerminalHeight | 30→28→30→29      | 30（稳定） |
| 工具输出行数            | 24→22→24→23 跳动 | 24（稳定） |
| 视觉效果                | 闪烁             | 稳定       |

**场景：新增第 3 个工具**

|                 | 改进前         | 改进后         |
| --------------- | -------------- | -------------- |
| 每个工具高度    | 15→9（突降 6） | 15→max(8, 9)=9 |
| 但如果 4 个工具 | 15→6（突降 9） | 15→max(8, 6)=8 |
| 保障            | 无最低保障     | 至少 8 行      |

### 4.2 边界情况

| 情况                     | 行为                          | 正确性                 |
| ------------------------ | ----------------------------- | ---------------------- |
| 终端窗口大幅缩小（>5行） | 立即接受                      | 正确，避免内容溢出终端 |
| 终端窗口缩小 1 行        | streaming 中吸收，idle 后同步 | 正确，MaxSizedBox 兜底 |
| 终端窗口放大             | 立即接受                      | 正确，更多空间不会闪烁 |
| 从 streaming 切换到 idle | 立即同步真实值                | 正确                   |
| 缓存值过时超过 2s        | 接受更新                      | 正确，防止长期偏离     |

### 4.3 风险评估

| 风险                           | 可能性 | 影响                               | 缓解                           |
| ------------------------------ | ------ | ---------------------------------- | ------------------------------ |
| 稳定化的高度略大于实际可用高度 | 中     | MaxSizedBox 视觉裁剪兜底，不会溢出 | 第 3 层防线（MaxSizedBox）保障 |
| 2s 超时太短/太长               | 低     | 调整常量即可                       | 可配置                         |
| streaming 状态判断不准         | 低     | 退化为无稳定化（等同改进前）       | 安全退化                       |

## 五、验证方案

1. **Build**：`npx tsc --noEmit -p packages/cli/tsconfig.json`
2. **流式稳定性**：verbose 模式 + `npm install`，观察行数是否稳定
3. **多工具场景**：并行工具执行，heights 不应在新工具获得结果时跳变
4. **终端 resize**：streaming 期间缩放终端，高度应平滑过渡（增大立即接受，小幅缩小延迟）
5. **Idle 同步**：streaming 停止后高度应立即同步到真实值
6. **回归**：compact 模式、Ctrl+S 展开、短输出均正常

## 六、实现成本

| 维度     | 评估                                      |
| -------- | ----------------------------------------- |
| 涉及文件 | 3 个（新建 1 个，修改 2 个）              |
| 新增代码 | ~40 行（useStableHeight hook）            |
| 修改代码 | ~10 行（AppContainer + ToolGroupMessage） |
| 风险     | 低 — 安全退化为无稳定化                   |
