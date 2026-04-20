# TUI 优化：屏幕闪烁

> 详细设计文档 2/3 — 解决流式输出、窄屏、终端 resize 等场景下的屏幕闪烁问题。

## 1. 问题分析

### 1.1 闪烁的根本原因

Ink 6.2.3 的渲染模型决定了闪烁问题的根源：

1. **全量重绘**：每次 React 状态变更，Ink 对整个动态区域执行 `eraseLines(N)` + 重新输出。`eraseLines` 会逐行发出 `ERASE_LINE + CURSOR_UP` 序列对，然后重写所有内容。
2. **超高重绘频率**：流式输出时每个内容 chunk（可包含一到多个 token）触发一次状态更新和重绘，高频时可达 50+ 次/秒。
3. **全屏回退路径**：当动态内容高度超过终端高度时，Ink 切换到 `clearTerminal` + 全量重写，产生整屏闪烁。

### 1.2 当前缓解措施

#### terminalRedrawOptimizer.ts

位于 `packages/cli/src/ui/utils/terminalRedrawOptimizer.ts`，通过拦截 `stdout.write()` 优化 ANSI 序列：

```typescript
// 核心优化：折叠重复的 ERASE_LINE + CURSOR_UP 序列
// 原始序列（N 行）:
//   ESC[2K ESC[1A  ESC[2K ESC[1A  ... ESC[2K ESC[G
// 优化后:
//   ESC[NA  ESC[2K ESC[1B  ESC[2K ESC[1B  ... ESC[NA ESC[G
```

**局限**：

- 仅优化光标移动模式，不减少实际输出字节数
- 不解决 Ink 全量重绘的根本问题
- 不支持同步输出协议
- 对全屏清除路径无效

#### Static/Dynamic 分离

`packages/cli/src/ui/components/MainContent.tsx` 使用 Ink 的 `<Static>` 组件分离已完成内容和流式内容：

```typescript
// Static 区域：已完成的历史消息，追加后不再更新
<Static items={mergedHistory}>
  {(item) => <HistoryItemDisplay key={item.key} ... />}
</Static>

// Dynamic 区域：当前流式内容，每帧重绘
<Box>
  {pendingHistoryItems.map((item) => <HistoryItemDisplay ... />)}
</Box>
```

**局限**：

- 当流式内容本身超过终端高度时仍会触发全屏重绘
- `refreshStatic()` 使用 `clearTerminal` 导致整屏闪烁（resize、compact 切换等场景）

### 1.3 具体闪烁场景

| 场景             | 触发条件                               | 严重程度 | 代码位置                     |
| ---------------- | -------------------------------------- | -------- | ---------------------------- |
| 流式输出         | 每个内容 chunk 触发 React re-render    | 高       | `useGeminiStream` hook       |
| 长输出超屏       | 动态内容高度 > 终端行数                | 严重     | Ink 内部 `eraseLines` 路径   |
| 终端宽度 resize  | `refreshStatic()` 调用 `clearTerminal`；当前 effect 主要依赖宽度变化 | 中       | `AppContainer.tsx` resize effect |
| Compact 模式切换 | 历史合并、settings dialog、快捷键切换触发 `refreshStatic()` | 中       | `MainContent` / `SettingsDialog` / `AppContainer` |
| 手动清屏/视图切换 | `/clear`、active view 切换触发全屏刷新 | 中 | `slashCommandProcessor` / `DefaultAppLayout` |
| 窄屏布局抖动     | 布局重算导致内容高度反复变化           | 中       | Ink 布局引擎                 |
| tmux/SSH         | 终端复用器放大闪烁效果                 | 严重     | 终端环境因素                 |

### 1.4 社区反馈

- **qwen-code#1778**：流式输出时屏幕闪烁
- **qwen-code#2748**：MCP 加载时闪烁 + 慢启动
- **claude-code#9935**：tmux 中 4,000-6,700 次/秒滚动事件
- **claude-code#37283**：长输出全屏闪烁
- **claude-code#10794**：SSH 远程场景闪烁加剧

## 2. 解决方案

### 2.1 [P0] 同步输出 — DECSET 2026

**原理**：[同步输出协议](https://gist.github.com/christianparpart/d8a62cc1ab659194f6ca7e8e5b1b1814) 允许应用通过转义序列告知终端"我正在更新帧，请暂缓显示直到帧完成"。

```
CSI ? 2026 h    ← Begin Synchronized Update（暂停显示）
... 帧内容 ...
CSI ? 2026 l    ← End Synchronized Update（刷新显示）
```

**终端支持情况**：
| 终端 | 支持版本 |
|---|---|
| kitty | 0.17.0+ |
| foot | 1.0+ |
| WezTerm | 所有版本 |
| iTerm2 | 3.5+ |
| Windows Terminal | 1.18+ |
| Contour | 0.3.0+ |
| tmux | 3.4+ (透传) |
| 不支持的终端 | 通常会忽略未知私有 CSI 序列；仍需按终端和 tmux/SSH 组合验证 |

**落地步骤**：先在现有的 `terminalRedrawOptimizer.ts` 中加入输出指标，再根据指标决定采用“单 write 包裹”还是“帧缓冲合并”。

**前置 instrumentation**：在默认启用前，必须先统计 Ink 每帧对应的 `stdout.write()` 次数、每次 write 的字节数、chunk 类型（string / Buffer）和 callback 语义。当前优化器的 `optimizeMultilineEraseLines()` 只能处理**单次 string write 内**的 ANSI 序列折叠，不能据此假设每帧一定只有一次 write。

**实现方案**：先在现有 `terminalRedrawOptimizer.ts` 中扩展 `optimizedWrite`，但需保证 BSU/ESU 成对、可禁用、且不改变 Buffer/callback 行为。

```typescript
const BSU = '\x1b[?2026h';  // Begin Synchronized Update
const ESU = '\x1b[?2026l';  // End Synchronized Update

const optimizedWrite = function (
  this: NodeJS.WriteStream,
  chunk: unknown,
  encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void,
) {
  let optimizedChunk = chunk;
  if (typeof chunk === 'string') {
    optimizedChunk = optimizeMultilineEraseLines(chunk);
    // 检测是否包含帧更新（包含擦除序列即视为帧更新）
    if (chunk.includes(ERASE_LINE) || chunk.includes('\x1b[2J')) {
      optimizedChunk = BSU + optimizedChunk + ESU;
    }
  }
  return originalWrite.call(this, optimizedChunk as string | Uint8Array, ...);
};
```

**如果 Ink 每帧多次 write**：不要简单给每个 write 都包 BSU/ESU。应改用帧缓冲策略：在 microtask/idle tick 中收集同一帧的 write 调用，合并后统一输出，并记录合并前后的 writes/sec 和 bytes/sec。

**验证步骤**：

1. 在优化器中添加 counters，统计单次 React render 触发多少次 `stdout.write()`
2. 覆盖 string、Buffer、带 encoding、带 callback 的 `stdout.write()` 调用形态
3. 覆盖 screen reader 开启时不安装优化器的路径
4. 覆盖 `ansiEscapes.clearTerminal`、`eraseLines`、普通文本输出三类路径
5. 检查 `bsu_frame_count === esu_frame_count`，异常时自动关闭同步输出

**影响范围**：仅 `packages/cli/src/ui/utils/terminalRedrawOptimizer.ts`

**风险评估**：**中低**

- 不支持的终端通常忽略 BSU/ESU，但不能宣称零风险，需覆盖 tmux/SSH/Windows Terminal/Terminal.app
- 可通过 `QWEN_CODE_LEGACY_ERASE_LINES=1` 或 `QWEN_CODE_LEGACY_RENDERING=1` 禁用
- stdout monkeypatch 是全局副作用，必须保证原始 `write()` 语义不变
- Claude Code 在 `src/ink/terminal.ts` 中已使用相同方案

**预期收益**：

- 消除大部分可见的帧撕裂和闪烁
- tmux 场景下效果最为显著（从数千次/秒滚动事件降至帧率级别）
- 不改变渲染管线，仅改变终端侧行为

### 2.2 [P0] 流式更新节流

**现状**：LLM 流式输出的每个内容 chunk 都触发 React 状态更新。虽然不是逐 token 更新（而是按 API 返回的 chunk 粒度），但在高速流式输出时仍可能产生每秒 50+ 次 re-render。人眼对文本更新的感知频率约 15-20fps，大量渲染被浪费。

**方案**：在流式 hook 中实现 chunk 缓冲 + 定时刷新。需要覆盖 content stream 和 thought stream；shell 命令输出已有 1s 级节流，应作为现状保留并单独验证。

```typescript
// packages/cli/src/ui/hooks/useGeminiStream.ts（概念实现）

const chunkBufferRef = useRef<string>('');
const flushTimerRef = useRef<NodeJS.Timeout | null>(null);
const FLUSH_INTERVAL_MS = 60; // ≈16fps，足够文本展示

const flushBuffer = useCallback(() => {
  if (chunkBufferRef.current) {
    setStreamingContent((prev) => prev + chunkBufferRef.current);
    chunkBufferRef.current = '';
  }
  flushTimerRef.current = null;
}, []);

const onContentChunk = useCallback(
  (chunk: string) => {
    chunkBufferRef.current += chunk;
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(flushBuffer, FLUSH_INTERVAL_MS);
    }
  },
  [flushBuffer],
);

// 流结束、取消、工具调用开始、需要展示确认框时立即刷新
const onStreamEnd = useCallback(() => {
  if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
  flushBuffer();
}, [flushBuffer]);
```

**影响范围**：`packages/cli/src/ui/hooks/useGeminiStream.ts`

**具体切入点**：

- `handleContentEvent()`：在 `setPendingHistoryItem()` 前缓冲 content chunk
- thought stream 更新路径：使用同一套缓冲/flush 机制，避免思考内容绕过节流
- shell command output：保留现有 `OUTPUT_UPDATE_INTERVAL_MS = 1000`，只补指标和回归测试

**风险评估**：低

- 60ms 延迟对用户不可感知
- 流结束、取消、工具调用、确认框展示前立即刷新，确保 UI 状态不滞后
- 如有问题可调整 `FLUSH_INTERVAL_MS` 或通过环境变量禁用

**预期收益**：`stdout.write` 调用从 50+/秒降至 < 20/秒，直接减少 60%+ 的渲染开销。

### 2.3 [P1] 动态内容高度管理 + 渐进提升

**现状校准**：当流式内容超过终端高度时，Ink 可能触发全屏重绘。源码中已经存在渐进提升的雏形：`useGeminiStream` 在 content 和 thought 流中调用 `findLastSafeSplitPoint()`，把安全分割点之前的内容加入 history/static，只保留尾部 pending 内容在动态区域。当前缺口不是“从零实现提升”，而是提升阈值、覆盖范围和刷新频率不够可控。

**方案**：增强现有"渐进提升"（Progressive Promotion）模式 — 随着流式内容增长，将已完成的块从动态区域提升到 `<Static>` 区域，并把触发条件从纯文本边界升级为“渲染高度 + 时间间隔 + 安全 Markdown 边界”。

**核心逻辑**：

```
流式输出开始
  ├─ 新 token 追加到 pendingContent
  ├─ 估算 pendingContent 渲染高度 vs 可用动态区域高度
  │   ├─ 高度安全且未超过最小间隔 → 继续累积
  │   └─ 接近阈值 →
  │       ├─ 使用 findLastSafeSplitPoint() 找到安全分割点
  │       ├─ 分割点之前的内容 → 提升到 history (Static)
  │       └─ 分割点之后的内容 → 保留在 pending (Dynamic)
  └─ 流结束 → 全部提升到 history
```

`findLastSafeSplitPoint()` 已存在于 `packages/cli/src/ui/utils/markdownUtilities.ts`，专为此类场景设计：

- 不在代码块内部分割
- 优先在段落边界 `\n\n` 分割
- 回退到行边界 `\n`

**增强点**：

- 使用 `availableTerminalHeight`、`contentWidth` 和渲染行数估算 pending 高度
- 对 content stream、thought stream、tool 输出摘要分别设置阈值
- 加入最小提升间隔（如 300-500ms），避免频繁写入 `<Static>`
- 只在安全 Markdown 边界分割；代码块、列表、表格中保守不切

**影响范围**：

- `packages/cli/src/ui/components/MainContent.tsx` — 提供可用动态高度和 pending 高度约束
- `packages/cli/src/ui/AppContainer.tsx` — 改进高度计算
- `packages/cli/src/ui/hooks/useGeminiStream.ts` — 增强现有分割/提升逻辑

**风险评估**：中

- 分割可能导致部分 Markdown 上下文丢失（如跨段落的列表）→ 通过保守的分割策略缓解
- 频繁提升可能导致 `<Static>` 闪烁 → 设置最小提升间隔（如 500ms）

**预期收益**：动态内容尽量控制在终端高度内，显著降低 Ink 全屏重绘路径触发概率。

### 2.4 [P1] 智能 refreshStatic()

**现状**：`refreshStatic()` 在 `AppContainer.tsx` 中通过 `clearTerminal`（完整的 `ESC[2J ESC[3J ESC[H`）实现全屏清除后重新挂载：

```typescript
// AppContainer.tsx 当前实现
const refreshStatic = useCallback(() => {
  process.stdout.write(ansiEscapes.clearTerminal);
  setHistoryRemountKey((prev) => prev + 1); // 触发 <Static> 重新渲染
}, []);
```

触发场景：

- 终端宽度 resize（当前主要依赖 `terminalWidth`，高度变化不应触发静态区重排）
- Compact 模式合并：`MainContent`
- Compact 设置变更：`SettingsDialog`
- Compact 快捷键切换：`AppContainer`
- 手动清屏：`/clear` / `clearScreen()`
- Active view 切换：`DefaultAppLayout`

**方案**：

1. **Resize 优化**：仅重绘动态区域而非全屏清除

   ```typescript
   const handleResize = useCallback(
     debounce(() => {
       // 不再 clearTerminal，仅更新布局尺寸
       updateTerminalDimensions();
       // 只在宽度变化时才需要重新渲染（高度变化不影响已渲染内容换行）
       if (widthChanged) {
         refreshStatic(); // 宽度变化时仍需全量重绘（行包装会变）
       }
     }, 500),
     [],
   );
   ```

2. **Compact 模式合并**：使用增量更新而非全量重绘
   - 仅当合并确实改变了可见内容时触发刷新
   - 增加合并去抖动间隔

3. **增加 resize debounce 到 500ms**（从 300ms），因为 resize 事件通常成组到达

**影响范围**：`packages/cli/src/ui/AppContainer.tsx`（第 462-464, 1508-1517 行）

### 2.5 [P2] 双缓冲 + Diff Patch（Phase 3）

**现状**：Ink 每帧都向 stdout 写入完整的新内容。

**方案**：维护一个 2D 字符网格作为"后缓冲区"，每次渲染时仅输出与当前缓冲区不同的单元格。

**架构设计**：

```
React 状态更新
  → Ink 渲染管线（产出新帧文本）
    → ScreenBuffer.diff(oldFrame, newFrame)
      → 产出 Patch 列表 [{row, col, content, style}]
        → 序列化为最小 ANSI 序列
          → 单次 stdout.write(BSU + patches + ESU)
```

**核心数据结构**：

```typescript
interface Cell {
  char: string; // 单个字符/grapheme cluster
  styleId: number; // 内化的样式 ID
  hyperlinkId: number; // 内化的超链接 ID
}

class ScreenBuffer {
  private cells: Cell[][]; // rows × cols
  private width: number;
  private height: number;

  diff(newBuffer: ScreenBuffer): Patch[];
  apply(patches: Patch[]): string; // 生成 ANSI 序列
}
```

**风险评估**：高

- 需要拦截 Ink 的输出层或 fork Ink
- 字符宽度计算（CJK、emoji）需要精确匹配 Ink 的计算
- 样式边界的 diff 比纯文本 diff 复杂得多

**参考**：Claude Code 在 `src/ink/screen.ts` 中实现了完整的双缓冲 + StylePool + CharPool，是最成熟的参考实现。

**建议**：先评估 Phase 1 的同步输出 + 节流效果。如果已满足需求，可降低此方案优先级。

### 2.6 [P2] DECSTBM 滚动区域优化（Phase 3）

**原理**：使用 CSI DECSTBM（Set Top and Bottom Margins）设定终端滚动区域，当内容需要滚动时发出 `CSI n S`（scroll up）指令，由终端硬件执行滚动而非重写整个视口。

**前置条件**：需要双缓冲（2.5）作为基础。

**参考**：Claude Code 的 `src/ink/render-node-to-output.ts` 实现了自适应 drain 策略：

- xterm.js：5 行以下即时，12 行以上平滑步进
- 原生终端：待处理行数的 3/4，最少 4 行

## 3. 竞品参考

### Claude Code 防闪烁架构

Claude Code 的自研 Ink 内核提供了五层防闪烁保护：

| 层级         | 机制                        | 对应文件                                 |
| ------------ | --------------------------- | ---------------------------------------- |
| 1. 帧缓冲    | frontFrame/backFrame 双缓冲 | `src/ink/ink.tsx:99-100`                 |
| 2. Diff 渲染 | 逐 cell 比较，仅输出变更    | `src/ink/log-update.ts`                  |
| 3. 原子帧    | BSU/ESU 同步输出包裹        | `src/ink/terminal.ts`                    |
| 4. 硬件滚动  | DECSTBM 滚动区域            | `src/ink/render-node-to-output.ts`       |
| 5. 布局感知  | 布局稳定时窄范围 diff       | `src/ink/render-node-to-output.ts:34-42` |

**关键洞察**：Claude Code 的经验表明，同步输出（第 3 层）是**单项收益最大**的优化，而双缓冲 + diff（第 1-2 层）提供了最彻底的解决方案。我们的 Phase 1 策略（同步输出 + 节流）可以以约 10% 的实现成本获得约 70% 的效果。

## 4. 实施优先级与里程碑

| 优先级 | 方案                 | 周次  | 风险 | 预期收益                  |
| ------ | -------------------- | ----- | ---- | ------------------------- |
| P0     | 输出层 instrumentation | 1     | 低   | 指标口径可信              |
| P0     | 同步输出 DECSET 2026 | 2     | 中低 | 消除帧撕裂，tmux 效果显著 |
| P0     | 流式更新节流 60ms    | 2     | 低   | stdout.write -60%+        |
| P1     | 现有渐进提升增强      | 7     | 中   | 降低长输出全屏闪烁        |
| P1     | 智能 refreshStatic() | 8-9   | 中   | resize 不再全屏闪烁       |
| P2     | 双缓冲 + diff patch  | 11-13 | 高   | stdout 字节/帧 -80%       |
| P2     | DECSTBM 滚动区域     | 13+   | 高   | 滚动性能接近原生          |

## 5. 验证方案

### 5.1 定量指标

| 指标                         | 当前估计    | Phase 1 目标         | Phase 3 目标 |
| ---------------------------- | ----------- | -------------------- | ------------ |
| stdout.write 调用/秒（流式） | 50+         | < 20                 | < 16         |
| stdout 字节/帧（增量更新）   | 全帧大小    | 全帧大小（同步包裹） | 仅变更 cell  |
| clearTerminal 次数（正常流式） | 未知        | 0                    | 0            |
| BSU/ESU 平衡                 | 无          | 100% 成对            | 100% 成对    |
| tmux 滚动事件/秒             | 4,000-6,700 | < 100                | < 20         |
| 可见闪烁（主观）             | 严重        | 轻微/无              | 无           |

### 5.2 测试场景

| 场景           | 测试方法                | 验收标准             |
| -------------- | ----------------------- | -------------------- |
| 正常流式输出   | 生成 500 token 响应     | 无可见闪烁           |
| 超长输出       | 生成 5000+ 行响应       | 不触发全屏清除       |
| 终端 resize    | 快速拖拽窗口大小        | 无全屏闪烁           |
| 窄屏 (< 40 列) | 将终端缩至 30 列        | 布局优雅降级，无抖动 |
| tmux 内运行    | tmux 分屏环境           | 滚动事件 < 100/秒    |
| SSH 远程       | 高延迟网络              | 闪烁不加剧           |
| kitty/WezTerm  | 支持 DECSET 2026 的终端 | 无明显帧撕裂         |
| Terminal.app   | 不支持 DECSET 2026      | 行为不变（不退化）   |
| screen reader  | `config.getScreenReader()` 开启 | 不安装 stdout 优化器 |
| Buffer write/callback | 直接写 stdout 的外部路径 | `write()` 返回值和 callback 行为不变 |

### 5.3 向后兼容

- `QWEN_CODE_LEGACY_ERASE_LINES=1`：禁用所有 stdout 拦截优化（已有）
- `QWEN_CODE_LEGACY_RENDERING=1`：新增，禁用同步输出 + 节流
- 不支持 DECSET 2026 的终端：通常忽略未知序列，但仍需保留开关和终端矩阵验证
