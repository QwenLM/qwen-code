# TUI 优化：渲染性能与可扩展性

> 详细设计文档 3/3 — 提升渲染性能，支持更多格式，增强主题可配置性，探索远期方向。

## 1. 问题分析

### 1.1 Markdown 解析器现状

当前使用自定义正则逐行解析器（`packages/cli/src/ui/utils/MarkdownDisplay.tsx`，461 行）：

```typescript
// MarkdownDisplayInternal 核心循环
const lines = text.split(/\r?\n/);
const headerRegex = /^ *(#{1,4}) +(.*)/;
const codeFenceRegex = /^ *(`{3,}|~{3,}) *(\w*?) *$/;
const ulItemRegex = /^([ \t]*)([-*+]) +(.*)/;
const olItemRegex = /^([ \t]*)(\d+)\. +(.*)/;
const hrRegex = /^ *([-*_] *){3,} *$/;
const tableRowRegex = /^\s*\|(.+)\|\s*$/;
const tableSeparatorRegex =
  /^(?=.*\|)\s*\|?\s*(:?-+:?)\s*(\|\s*(:?-+:?)\s*)*\|?\s*$/;

// 在循环中逐行用这 7 个正则匹配，无解析结果缓存
for (let i = 0; i < lines.length; i++) {
  // headerRegex.exec(line)
  // codeFenceRegex.exec(line)
  // ulItemRegex.exec(line)
  // ... 逐个正则尝试匹配当前行
}
```

**问题**：

1. **无解析缓存**：每次 React re-render 都对完整文本重新解析。流式输出时，每新增一个 token 就重新解析所有已累积文本
2. **功能受限**：不支持 GFM 任务列表、脚注、嵌套格式、定义列表等
3. **正则脆弱性**：边界情况处理不完整，如表格与 CJK 字符的交互、嵌套代码块等
4. **性能线性退化**：文本越长，每帧解析耗时线性增长

### 1.2 代码高亮现状

`packages/cli/src/ui/utils/CodeColorizer.tsx`（224 行）：

```typescript
import { common, createLowlight } from 'lowlight';
const lowlightInstance = createLowlight(common); // 启动时加载 ~40 种语法
```

**问题**：

1. **急切加载**：`import { common }` 在模块级别加载约 40 种语言语法到内存，增加启动时间和内存占用
2. **无高亮缓存**：每次渲染相同代码块都重新调用 `lowlight.highlight()`
3. **`highlightAuto()` 昂贵**：未指定语言时的自动检测需遍历所有已注册语法

### 1.3 表格渲染现状

`packages/cli/src/ui/utils/TableRenderer.tsx`（540 行）：

**问题**：

- CJK/宽字符的列宽计算存在 bug（GitHub 反馈）
- 特定终端宽度下表格消失或错位
- 对齐方式（`:---:` 等）的解析与渲染存在边缘情况

### 1.4 主题系统现状

`packages/cli/src/ui/themes/theme-manager.ts`：

```typescript
// 大多数主题使用 hex 颜色
export const QwenDark: Theme = {
  name: 'QwenDark',
  colors: {
    Background: '#0b0e14',
    Foreground: '#bfbdb6',
    AccentBlue: '#39BAE6',
    // ...
  },
};
```

**问题**：

1. **hex 颜色硬编码**：绕过终端调色板，破坏透明背景终端
2. **无终端能力检测**：不区分 truecolor/256 色/16 色终端
3. **仅 ANSI/ANSILight 使用 16 色**：但非默认主题

### 1.5 缺失的渲染能力

| 能力               | 现状               | 用户需求          |
| ------------------ | ------------------ | ----------------- |
| LaTeX 数学公式     | 不支持             | claude-code#21433 |
| 终端超链接 (OSC 8) | URL 渲染为纯文本   | 点击跳转          |
| 虚拟滚动           | 无，长会话性能退化 | 长会话场景        |
| 图表/图像          | 不支持             | 远期探索          |

## 2. 解决方案

### 2.1 [P0] Markdown 解析结果缓存

**目标**：消除流式输出时的重复解析开销。

**方案**：实现 block 级别的 LRU 缓存。

**设计**：

```typescript
// 新增缓存层
const PARSE_CACHE_MAX = 500;
const parseCache = new LRUCache<string, React.ReactNode[]>(PARSE_CACHE_MAX);

function parseMarkdownBlocks(text: string): React.ReactNode[] {
  const cacheKey = hashContent(text);
  const cached = parseCache.get(cacheKey);
  if (cached) return cached;

  // ... 现有解析逻辑 ...
  const blocks = doParseBlocks(text);
  parseCache.set(cacheKey, blocks);
  return blocks;
}
```

**流式优化**：利用现有的 `findLastSafeSplitPoint()` 实现增量解析。

````
全文: "# Title\n\nParagraph 1\n\nParagraph 2\n\n```code block..."
       ├──── 已完成块 ────┤├── 已完成块 ──┤├── 当前块 ──┤
       缓存命中（不重解析）  缓存命中         重新解析（仅此块）
````

**影响范围**：`packages/cli/src/ui/utils/MarkdownDisplay.tsx`

**预期收益**：缓存命中时解析耗时降低 70%+。对于 1000 行的流式输出，每帧仅需解析最后一个不完整块（通常 < 50 行），而非全部 1000 行。

**参考**：Claude Code 使用模块级 LRU 缓存（500 条目），key 为内容 hash，避免保留完整字符串引用。

### 2.2 [P0] 代码高亮优化

**方案 A：语法库懒加载**

```typescript
// 当前（急切加载）
import { common, createLowlight } from 'lowlight';
const lowlightInstance = createLowlight(common);

// 优化后（按需加载）
import { createLowlight } from 'lowlight';
const lowlightInstance = createLowlight(); // 空实例

const GRAMMAR_LOADERS: Record<string, () => Promise<any>> = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  python: () => import('highlight.js/lib/languages/python'),
  // ... 常用语言
};

async function ensureLanguage(lang: string): Promise<boolean> {
  if (lowlightInstance.registered(lang)) return true;
  const loader = GRAMMAR_LOADERS[lang];
  if (!loader) return false;
  const grammar = await loader();
  lowlightInstance.register(lang, grammar.default);
  return true;
}
```

**方案 B：高亮结果缓存**

```typescript
const highlightCache = new LRUCache<string, HastNode>(200);

function cachedHighlight(code: string, lang: string): HastNode {
  const key = `${lang}:${hashContent(code)}`;
  const cached = highlightCache.get(key);
  if (cached) return cached;

  const result = lowlightInstance.highlight(lang, code);
  highlightCache.set(key, result);
  return result;
}
```

**影响范围**：`packages/cli/src/ui/utils/CodeColorizer.tsx`

**预期收益**：

- 懒加载：减少启动时模块加载量，降低内存占用
- 缓存：对已完成代码块的重复渲染耗时降至 O(1)

### 2.3 [P1] 切换到 marked 解析器

**动机**：当前自定义正则解析器的功能和鲁棒性已接近上限。`marked` 是 Claude Code 的选择，提供完整的 GFM 支持和流式友好的 lexer API。

**架构设计**：

```
输入文本
  ├─ 快速路径检测: /[#*`|[\->_~]|\n\n|^\d+\. / (无 MD 语法 → 纯文本渲染)
  ├─ marked.lexer(text) → Token[]  (AST)
  └─ 自定义 Renderer: Token[] → React.ReactNode[]
       ├─ heading → <Text bold>
       ├─ code → <RenderCodeBlock> (复用现有组件)
       ├─ table → <RenderTable> (复用现有组件)
       ├─ list → <RenderListItem> (复用现有组件)
       ├─ paragraph → <RenderInline> (复用现有组件)
       ├─ blockquote → <Box borderLeft>
       └─ ... 其他 token 类型
```

**流式优化**：

```typescript
// 仅对最后一个不完整块调用 marked.lexer()
const blocks = splitAtBlockBoundaries(streamingText);
const cachedBlocks = blocks.slice(0, -1).map((b) => getCachedTokens(b));
const lastBlockTokens = marked.lexer(blocks[blocks.length - 1]);
return [...cachedBlocks.flat(), ...lastBlockTokens];
```

**新增 GFM 能力**：
| 能力 | marked 支持 | 当前解析器 |
|---|---|---|
| 标准表格 | 完整 | 部分 |
| 任务列表 `- [x]` | 是 | 否 |
| 脚注 `[^1]` | 是 | 否 |
| 删除线 `~~text~~` | 是 | 是 |
| 自动链接 | 是 | 部分 |
| HTML 内联 | 可配置 | 仅 `<u>` |
| 嵌套格式 | 完整 | 受限 |

**迁移策略**：

1. 添加 `marked` 依赖
2. 创建 `MarkdownDisplayV2.tsx`，使用 marked lexer + 自定义 renderer
3. 通过设置项 `ui.markdownRenderer: 'v1' | 'v2'` 切换（默认 v1）
4. 编写 Markdown fixture 测试集，对比两个渲染器输出
5. 渐进切换默认值到 v2，保留 v1 作为回退
6. 稳定后移除 v1

**影响范围**：

- 新增：`packages/cli/src/ui/utils/MarkdownDisplayV2.tsx`
- 修改：`packages/cli/src/ui/utils/MarkdownDisplay.tsx`（特性开关）
- 修改：`package.json`（添加 marked 依赖）

**风险点**：

- marked 的 token 结构与当前组件的 props 接口需要适配
- 流式 markdown 中的不完整语法可能导致 marked 产生不同的 token 结构
- 缓解：保留 v1 作为回退，充分测试后再切换默认值

### 2.4 [P1] 主题系统 — ANSI 16 色默认 + 终端能力检测

**目标**：默认使用 ANSI 16 色主题，确保兼容所有终端（包括透明背景、自定义配色方案）。

**终端能力检测逻辑**：

```typescript
// packages/cli/src/ui/themes/theme-manager.ts

function detectColorCapability(): 'truecolor' | '256' | '16' | 'none' {
  if (process.env.NO_COLOR !== undefined) return 'none';
  if (process.env.FORCE_COLOR === '3') return 'truecolor';

  const colorterm = process.env.COLORTERM?.toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor';

  const term = process.env.TERM || '';
  if (term.includes('256color')) return '256';

  return '16'; // 保守默认
}

function getDefaultTheme(): Theme {
  const capability = detectColorCapability();
  switch (capability) {
    case 'none':
      return NoColorTheme;
    case 'truecolor':
      return QwenDark; // hex 颜色主题
    default:
      return ANSI; // 16 色主题，尊重终端调色板
  }
}
```

**明暗主题自动检测**（进阶）：

```typescript
// 通过 OSC 11 查询终端背景色
function queryTerminalBackground(): Promise<'light' | 'dark' | 'unknown'> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('unknown'), 1000);
    process.stdout.write('\x1b]11;?\x07'); // OSC 11 查询
    // 解析响应判断明暗...
  });
}
```

**影响范围**：

- `packages/cli/src/ui/themes/theme-manager.ts` — 添加能力检测，修改默认主题选择
- `packages/cli/src/ui/themes/semantic-tokens.ts` — 确保 ANSI 主题的语义 token 完整

**向后兼容**：

- 已在 settings 中显式设置主题的用户不受影响
- 仅影响未设置主题的新用户或重置用户
- 所有 hex 颜色主题仍可通过设置选择

### 2.5 [P2] OSC 8 终端超链接

**目标**：将 URL 和 Markdown 链接渲染为可点击的终端超链接。

**OSC 8 协议**：

```
ESC ] 8 ; params ; uri ST    ← 开始超链接
link text                     ← 显示文本
ESC ] 8 ; ; ST               ← 结束超链接

// 示例
\x1b]8;;https://example.com\x07Click here\x1b]8;;\x07
```

**支持的终端**：iTerm2, kitty, WezTerm, Windows Terminal, Hyper, foot, Contour 等。不支持的终端仅显示文本，无副作用。

**实现**：

```typescript
// 新增工具函数
function wrapHyperlink(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}
```

在 `InlineMarkdownRenderer.tsx` 中集成：

- `[text](url)` → OSC 8 包裹的可点击链接
- 自动检测的 URL → OSC 8 包裹
- 文件路径 → `file://` URL 包裹（如工具输出中的文件路径）

**影响范围**：

- `packages/cli/src/ui/utils/InlineMarkdownRenderer.tsx` — 链接渲染修改
- 新增：超链接工具函数模块

### 2.6 [P2] 消息历史虚拟滚动（Phase 3）

**现状**：所有历史消息通过 `<Static>` 追加到终端 scrollback，长会话会产生大量渲染元素。

**方案设计**：

```
┌─────────────────────────────┐
│     Overscan (上方 2 条)     │  ← 预渲染但不可见
├─────────────────────────────┤
│                             │
│     可见区域 (终端高度)       │  ← 当前渲染
│                             │
├─────────────────────────────┤
│     Overscan (下方 2 条)     │  ← 预渲染但不可见
└─────────────────────────────┘
│     未渲染消息 (跳过)        │  ← 按需加载
```

**关键挑战**：

- Ink 的 `<Static>` 是追加模式，无法移除已渲染内容
- 需要切换到 alternate screen 模式或自行管理终端输出
- 每条消息的高度需要预计算或缓存

**参考**：Claude Code 的 `<ScrollBox>` 组件（31KB）实现了完整的虚拟滚动 + DECSTBM 硬件滚动。

**建议**：先评估 Phase 1-2 的优化效果，若长会话性能仍是痛点再实施。

### 2.7 [P3] LaTeX/数学公式渲染

**场景**：代码辅助场景中，模型输出可能包含数学公式（如算法分析、信号处理等）。

**方案层次**：

**Level 1：Unicode 数学符号替换（可行性高）**

```
$x^2 + y^2 = z^2$  →  x² + y² = z²
$\alpha + \beta$    →  α + β
$\frac{1}{2}$       →  ½
$\sum_{i=1}^{n}$    →  Σᵢ₌₁ⁿ
```

使用 `tex-to-unicode` 库或自建映射表，覆盖常见数学符号。

**Level 2：块级公式语法高亮（可行性中）**

```
$$
E = mc^2
$$
```

识别 `$$...$$` 块，使用语法高亮渲染 LaTeX 源码（类似代码块但标注为 `latex`）。

**Level 3：完整 KaTeX 渲染到终端（可行性低）**

- 需要实现 KaTeX 的 AST 到终端渲染的转换
- 终端能力有限（无下标对齐、无分数线等）
- 可能需要图像协议（Sixel/Kitty image protocol）

**建议**：Phase 3 实现 Level 1 + Level 2，Level 3 作为远期探索。

### 2.8 [远期] Web 渲染探索

**动机**：终端能力终究有限，复杂的富文本渲染（图表、公式、交互式表格）在 Web 环境中更自然。

**探索方向**：

1. **混合架构**：CLI 进程处理输入和工具执行，通过 WebSocket 将富文本内容推送到本地浏览器伴侣界面
2. **Electron/Tauri 封装**：将终端嵌入 Web 壳中（类似 VS Code 终端），获得 CSS/SVG/Canvas 完整能力
3. **Kitty Image Protocol**：在支持的终端中内联显示图像（图表截图、公式渲染图等）

**收益**：

- 完整 CSS 样式
- SVG 图表
- MathJax/KaTeX 数学公式
- 交互式表格（排序、筛选）
- 图像内联显示

**风险**：

- 增加系统复杂度和依赖
- 偏离纯 CLI 工具的定位
- 需要额外的安装步骤

**建议**：仅作为概念验证（POC），不纳入正式路线图。

## 3. 竞品参考

### Claude Code 渲染架构

| 能力          | 实现方式                                                   |
| ------------- | ---------------------------------------------------------- |
| Markdown 解析 | `marked` 库 + LRU token 缓存（500 条）                     |
| 快速路径      | 正则检测无 MD 语法 → 跳过 `marked.lexer()`（大多数短回复） |
| 流式优化      | 在块边界分割，仅重解析最后一个块                           |
| 代码高亮      | `<Suspense>` 包裹的可选 CLI 语法高亮                       |
| 表格          | React 组件 `<MarkdownTable>` + flexbox 布局                |
| 超链接        | OSC 8 终端超链接                                           |
| 样式池化      | StylePool: ANSI 码集内化为整数 ID + 转换缓存               |
| 字符池化      | CharPool: ASCII 快速路径 + Map 缓存                        |

**关键差异**：Claude Code 使用 `marked`（成熟的 GFM 解析器）而非自定义正则，并通过 LRU 缓存 + 快速路径跳过 + 流式块分割实现了高效的流式渲染。

## 4. 实施优先级与里程碑

| 优先级 | 方案                      | 周次  | 风险   | 预期收益                  |
| ------ | ------------------------- | ----- | ------ | ------------------------- |
| P0     | Markdown 解析缓存         | 2     | 低     | 解析耗时 -70%（缓存命中） |
| P0     | 代码高亮缓存 + 懒加载     | 2     | 低     | 启动加速 + 重复渲染消除   |
| P1     | 切换到 marked 解析器      | 7-8   | 中     | GFM 完整支持              |
| P1     | ANSI 16 色默认 + 能力检测 | 4     | 中     | 修复透明终端兼容性        |
| P2     | OSC 8 终端超链接          | 9-10  | 低     | URL 可点击                |
| P2     | 虚拟滚动                  | 13-15 | 高     | 长会话性能                |
| P3     | LaTeX 数学公式            | 15-16 | 中     | 数学内容渲染              |
| 远期   | Web 渲染探索              | TBD   | 探索性 | 富文本能力                |

## 5. 验证方案

### 5.1 渲染性能基准

```typescript
// 测试用例
const benchmarks = [
  { name: '短文本', content: '一段简短的回复', expectedParseMs: '<1' },
  { name: '500行 Markdown', content: generateMd(500), expectedParseMs: '<5' },
  {
    name: '代码块×10',
    content: generateCodeBlocks(10),
    expectedParseMs: '<10',
  },
  {
    name: '大表格 (20×5)',
    content: generateTable(20, 5),
    expectedParseMs: '<5',
  },
  {
    name: '流式 1000 token',
    content: simulateStream(1000),
    expectedRerenders: '<20',
  },
];
```

### 5.2 格式兼容性测试

Markdown fixture 测试集，验证所有支持的格式正确渲染：

- 标题（H1-H4）
- 代码块（带语言标注 + 无语言 + 嵌套）
- 表格（基本 + 对齐 + CJK 内容 + 宽字符）
- 列表（有序 + 无序 + 嵌套 + 混合）
- 内联格式（加粗 + 斜体 + 代码 + 链接 + 删除线）
- 分割线
- 引用块

### 5.3 主题兼容性

| 终端             | ANSI 16 色   | 256 色 | Truecolor | 透明背景      |
| ---------------- | ------------ | ------ | --------- | ------------- |
| iTerm2           | 正确         | 正确   | 正确      | ANSI 模式正确 |
| Terminal.app     | 正确         | 正确   | N/A       | ANSI 模式正确 |
| kitty            | 正确         | 正确   | 正确      | ANSI 模式正确 |
| WezTerm          | 正确         | 正确   | 正确      | ANSI 模式正确 |
| Windows Terminal | 正确         | 正确   | 正确      | ANSI 模式正确 |
| NO_COLOR 环境    | NoColor 主题 | —      | —         | —             |
