# TUI 优化：渲染性能与可扩展性

> 详细设计文档 — 提升渲染性能，支持更多格式，增强主题可配置性，探索远期方向。

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
3. **正则脆弱性**：边界情况处理不完整，如嵌套代码块、复杂列表、未闭合流式 Markdown 等
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

**源码校准**：

- 当前实现已经使用 `wrap-ansi`、`strip-ansi` 和 string-width 缓存处理 ANSI/CJK 宽度
- 已有基本表格、CJK、ANSI、宽度边界和 vertical fallback 的回归测试
- 因此表格不应作为 Phase 1 的主要重构目标；除非有 qwen-code 当前版本可复现缺陷，否则以补 fixture 和保护现有能力为主

**仍需验证的风险**：

- 与新 Markdown token/cache 层集成后，表格 token 到现有 `TableRenderer` 的输入是否保持一致
- 极窄宽度、混合 ANSI + CJK + emoji 场景是否仍能触发 vertical fallback
- marked 迁移后对齐语法、转义 pipe、代码 span 中 pipe 的处理是否与当前渲染兼容

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

### 1.6 Gemini CLI / Claude Code 调研结论

外部源码调研说明，渲染层的机会不能只看“Markdown 支持哪些语法”，而要同时看 parser、streaming、highlight、表格和长会话容器：

| 维度 | Gemini CLI | Claude Code | 对 qwen-code 的含义 |
| --- | --- | --- | --- |
| Markdown parser | 仍是自定义正则解析器 | `marked` + token cache + plain-text fast path | parser 架构升级应主要参考 Claude，而不是把 Gemini 当 parser 终局 |
| 流式 Markdown | `findLastSafeSplitPoint()` + Static 提升 | `StreamingMarkdown` 稳定前缀 / 不稳定尾部 | 现有“安全分割点”方向正确，但应升级成稳定块模型 |
| 代码高亮 | 同步 `lowlight(common)` | Suspense + fallback + 宽度感知渲染 | qwen-code 应坚持“同步基线 + 异步增强” |
| 表格 | 已有成熟 ANSI/CJK 宽度处理 | `MarkdownTable` 单独组件化 | 表格不是首要重构目标，但应成为 parser 迁移的兼容边界 |
| 长会话 | `ScrollableList` / `VirtualizedList` | `ScrollBox` / `useVirtualScroll` / `VirtualMessageList` | 虚拟滚动必须进入正式路线图，且要处理动态高度与 resize |

因此，本设计文档后续的重点不应只是“换 parser”，而是把 parser、streaming、高亮、虚拟滚动作为一组相互制约的问题来处理。

### 1.7 基于 issue 的渲染问题校准

本轮补查 qwen-code issue 后，渲染层至少还要面对三类已被用户反复报告的问题：

| 类别 | 代表 issue | 当前源码结论 |
| --- | --- | --- |
| 大工具输出导致闪烁 / 卡顿 | #2748 #2818 #1008 | 当前 plain text 路径仍主要依赖 `MaxSizedBox` 做最终视觉裁剪，容易出现“先 layout 全量，再裁剪” |
| 长回答 / 长会话不可读不可滚动 | #1479 #2748 | 当前主路径仍是 `<Static>` + pending，缺少专门的长会话滚动容器 |
| 工具 / 子 agent 详情既想看全，又会导致界面抖动 | #2424 #2624 #1861 #2924 | 当前折叠模式存在，但缺少统一预算、稳定高度与 bounded detail panel |

更完整的问题分类见 [07-issue-backed-failure-taxonomy.md](./07-issue-backed-failure-taxonomy.md)。本文件只展开这些问题在**渲染层**的修复方式。

## 2. 解决方案

### 2.1 [P0] Markdown token/block 缓存

**目标**：消除流式输出时的重复解析开销。

**关键约束**：不能缓存 `React.ReactNode[]`。`MarkdownDisplay` 的最终渲染受 `isPending`、`availableTerminalHeight`、`contentWidth`、`textColor`、主题、代码行号设置等 props/settings 影响；按文本 hash 缓存 ReactNode 会导致 resize、主题切换、pending 高度裁剪和行号开关后复用错误结果。

**方案**：实现 block 级别的 LRU 缓存，但缓存对象是 token/block 元数据，而不是 ReactNode。

**设计**：

```typescript
// 新增缓存层
const PARSE_CACHE_MAX = 500;
const parseCache = new LRUCache<string, ParsedMarkdownBlock[]>(PARSE_CACHE_MAX);

interface ParsedMarkdownBlock {
  type: 'paragraph' | 'heading' | 'code' | 'table' | 'list' | 'hr';
  raw: string;
  attrs: Record<string, unknown>;
  children?: ParsedMarkdownBlock[];
}

function parseMarkdownBlocks(text: string): ParsedMarkdownBlock[] {
  const cacheKey = hashContent(text);
  const cached = parseCache.get(cacheKey);
  if (cached) return cached;

  // ... 现有解析逻辑 ...
  const blocks = doParseBlocks(text);
  parseCache.set(cacheKey, blocks);
  return blocks;
}

function renderMarkdownBlocks(
  blocks: ParsedMarkdownBlock[],
  props: MarkdownDisplayProps,
): React.ReactNode[] {
  // 根据当前 width/theme/pending/height/settings 渲染，不能跨 props 复用
}
```

**流式优化**：利用现有的 `findLastSafeSplitPoint()` 实现增量解析。

````
全文: "# Title\n\nParagraph 1\n\nParagraph 2\n\n```code block..."
       ├──── 已完成块 ────┤├── 已完成块 ──┤├── 当前块 ──┤
       缓存命中（不重解析）  缓存命中         重新解析（仅此块）
````

**缓存 key**：

- parse cache：`hash(rawBlock)` + parser version
- render 辅助缓存（如纯文本 wrap 结果）：必须额外包含 `contentWidth`、theme identity、`isPending`、height constraint、settings 版本
- 不把完整原始长字符串作为 key 保存，避免内存放大

**影响范围**：`packages/cli/src/ui/utils/MarkdownDisplay.tsx`

**预期收益**：缓存命中时解析耗时显著下降。对于 1000 行的流式输出，每帧仅需解析最后一个不完整块（通常 < 50 行），而非全部 1000 行。

**参考**：Claude Code 使用模块级 LRU 缓存（500 条目），key 为内容 hash，避免保留完整字符串引用；qwen-code 应采用 token/block 级缓存以适配 Ink props 驱动渲染。

### 2.2 [P0] 代码高亮优化

**关键约束**：当前 `colorizeCode()` 是同步函数，直接返回 ReactNode；因此不能在 render 路径中直接 `await ensureLanguage()`。语法库懒加载必须配合 Suspense、预热队列或“当前帧纯文本 fallback，下一帧高亮增强”的状态模型，否则会破坏 Ink 同步渲染路径。

**方案 A：同步基线 + 异步预热**

```typescript
// 当前（急切加载）
import { common, createLowlight } from 'lowlight';
const lowlightInstance = createLowlight(common);

// 优化方向：保留小型同步基础语法，稀有语法异步预热
import { createLowlight } from 'lowlight';
const lowlightInstance = createLowlight(BASELINE_GRAMMARS);

const GRAMMAR_LOADERS: Record<string, () => Promise<any>> = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  python: () => import('highlight.js/lib/languages/python'),
  // ... 常用语言
};

function requestLanguageWarmup(lang: string): void {
  if (lowlightInstance.registered(lang)) return;
  const loader = GRAMMAR_LOADERS[lang];
  if (!loader) return;
  void loader().then((grammar) => {
    lowlightInstance.register(lang, grammar.default);
    emitHighlightCacheInvalidated(lang);
  });
}
```

**渲染策略**：

- 已注册语言：同步高亮
- 未注册但可加载语言：本帧纯文本/简化高亮，同时触发 warmup；下一次 render 使用高亮
- 未指定语言：限制 `highlightAuto()` 的输入大小和语言集合，超大代码块直接纯文本，避免遍历所有 grammar
- pending streaming 代码块：默认不做昂贵高亮，完成后再高亮

**方案 B：高亮结果缓存**

```typescript
const highlightCache = new LRUCache<string, HighlightResult>(200);

function cachedHighlight(input: HighlightInput): HighlightResult {
  const key = [
    input.language ?? 'auto',
    input.themeId,
    input.showLineNumbers,
    input.contentWidth,
    input.availableTerminalHeight ?? 'none',
    hashContent(input.code),
  ].join(':');
  const cached = highlightCache.get(key);
  if (cached) return cached;

  const result = highlightSynchronously(input);
  highlightCache.set(key, result);
  return result;
}
```

**缓存 key 必须包含**：

- code hash、language/auto mode、registered grammar version
- theme identity / color palette
- `showLineNumbers`
- `contentWidth`
- `availableTerminalHeight` 或裁剪后的 line range
- pending vs completed 状态（pending 可直接禁用缓存或单独缓存）

**影响范围**：`packages/cli/src/ui/utils/CodeColorizer.tsx`

**预期收益**：

- 同步基线 + 异步预热：减少启动时模块加载量，降低内存占用，同时不破坏同步 render
- 缓存：对已完成代码块的重复渲染耗时降至 O(1)

### 2.2A [P0] 大工具输出预裁剪（pre-render slicing）

**当前问题**：`packages/cli/src/ui/components/messages/ToolMessage.tsx` 的 plain text 工具输出路径，仍然倾向于把整段字符串交给 React/Ink，再依赖 `MaxSizedBox` 做最终视觉裁剪。这样会出现一个经典坏路径：

```
500 行工具输出
  -> React/Ink 先 layout 500 行
  -> 终端最终只显示 10-15 行
  -> 每次增量更新都重新走一遍
```

这类问题与同步输出、ANSI 优化是**两条独立治理线**。即便终端输出完全原子，若 React 每次仍要 layout 巨量节点，闪烁和卡顿也不会真正消失。

**Gemini 参考实现**：Gemini CLI 在 `ToolResultDisplay.tsx` 中已经使用 `SlicingMaxSizedBox`，先做：

1. 字符级保护
2. logical line slice
3. 再交给 `MaxSizedBox` 做最终安全裁剪

**qwen-code 设计建议**：

- 为 plain text / ANSI tool output 引入预裁剪层
- 预裁剪在进入 React render tree 前完成
- `MaxSizedBox` 只保留为 width limiter 和安全网，而不是主要削峰手段

```typescript
// 概念实现
interface SlicingMaxSizedBoxProps<T> extends Omit<MaxSizedBoxProps, 'children'> {
  data: T;
  maxLines?: number;
  children: (truncatedData: T) => React.ReactNode;
}
```

**必须保留的约束**：

- markdown-heavy 输出不能因为防闪烁而直接退化成纯文本
- hidden lines 计数必须区分 logical line 与 soft wrap line，避免双重计算
- alternate/fullscreen 模式下应允许查看完整输出，main-screen 才做保守裁剪

**维护者方向信号**：截至 **2026-04-22**，PR `#3013` 仍是 `OPEN + CHANGES_REQUESTED`。它确认了“预裁剪 + 稳定高度 + 硬上限”的方向，但 reviewer 也明确指出：

1. markdown path 不能被粗暴删掉
2. hidden line 统计不能混淆 pre-slice 与 visual overflow

因此本设计文档应采用该方向，但不能把 PR 当前实现直接当作已验证终稿。

### 2.2B [P0] 通用 tool output budgeting

`#2818` 和 `#1008` 说明当前另一个真实问题是：预算规则并不统一。shell / MCP 路径已有截断，但 `grep`、`glob`、`read_file`、`edit` 等仍可能直接把巨大字符串送入上下文和 UI。

**设计建议**：把 budget 分成两层，而不是混在一起：

1. **模型可见预算**
   - 在 scheduler / function response 生成前统一截断
   - 控制上下文膨胀
2. **用户可见预算**
   - 在 UI 层按 main-screen / alternate/fullscreen 模式决定显示多少
   - 控制 Ink layout 成本与可读性

这两个预算不能互相替代：

- 只做 UI 折叠，模型上下文仍会爆
- 只做模型截断，UI 仍可能因未折叠的原始结果而卡顿

### 2.2C [P1] 有边界的 detail panel

`#1479` 和 `#2748` 反映的不是“某个组件性能不够”，而是当前主界面缺少一个正式的长内容容器。继续把所有细节直接摊进主 transcript，会同时造成：

- 工具输出太长
- 子 agent 展开闪烁
- 生成时无法自由回看

**建议路线**：

- main transcript 默认展示 summary / truncated preview
- detail 内容进入 bounded scroll container
- fullscreen / alternate buffer 优先承接完整详情

这个动作和后面的虚拟滚动并不冲突，反而是更稳妥的前置步骤。

### 2.3 [P1] 切换到 marked 解析器

**动机**：当前自定义正则解析器的功能和鲁棒性已接近上限。`marked` 是 Claude Code 的选择，提供成熟的 block/inline lexer API，可作为 v2 渲染器候选。但迁移必须先定义安全策略和流式不完整语法策略，不能只替换 parser。

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

**和大工具输出方案的关系**：

- `marked` 迁移不能替代 pre-render slicing
- markdown tool output 需要自己的 bounded strategy：字符保护、stable prefix / unstable suffix、必要时 summary + detail panel
- 不能因为 parser 升级就默认放开大块 markdown 全量渲染

**新增 GFM 能力**：
| 能力 | marked 支持 | 当前解析器 |
|---|---|---|
| 标准表格 | 是，需映射到现有 `TableRenderer` | 已有自定义实现 |
| 任务列表 `- [x]` | 是，需自定义 Ink renderer | 否 |
| 脚注 `[^1]` | 需通过扩展/插件策略验证，不作为首批默认承诺 | 否 |
| 删除线 `~~text~~` | 是 | 是 |
| 自动链接 | 是 | 部分 |
| HTML 内联 | parser 可识别；qwen-code 需默认转义或忽略，不能直接渲染 HTML | 仅 `<u>` |
| 嵌套格式 | 更完整，但需 fixture 验证 Ink renderer 行为 | 受限 |

**必须先定的策略**：

- HTML policy：默认忽略或转义 HTML；不允许把 marked 输出的 HTML 当作安全内容直接渲染
- Extension policy：脚注、定义列表等非首批能力需单独开关和 fixture，不在 v2 默认承诺里混入
- Streaming policy：未闭合代码块、表格、列表时，最后一个 block 允许降级为纯文本或 v1 行解析，避免 token 结构抖动
- Compatibility policy：现有 `InlineMarkdownRenderer` 的 `[text](url)` 输出形态、表格 fallback、代码块裁剪行为必须有 fixture 对照

**迁移策略**：

1. 添加 `marked` 依赖
2. 创建 `MarkdownDisplayV2.tsx`，使用 marked lexer + 自定义 renderer
3. 默认关闭，通过设置项 `ui.markdownRenderer: 'v1' | 'v2'` 和环境变量双重切换
4. 编写 Markdown fixture 测试集，对比两个渲染器输出，重点覆盖 streaming partial blocks
5. 内部 dogfood 后渐进切换默认值到 v2，保留 v1 作为回退
6. 稳定两个小版本后再评估移除 v1

**来自 Claude Code 的额外校准**：

- `marked` 迁移的真正收益不只是语法支持，而是 token cache、plain-text fast path、流式稳定前缀可以一起落地
- 表格应继续组件化渲染，避免为了 parser 迁移把表格退回到纯文本路径
- 如果只替换 parser 而不补 cache / streaming policy，收益会明显低于预期

**影响范围**：

- 新增：`packages/cli/src/ui/utils/MarkdownDisplayV2.tsx`
- 修改：`packages/cli/src/ui/utils/MarkdownDisplay.tsx`（特性开关）
- 修改：`package.json`（添加 marked 依赖）

**风险点**：

- marked 的 token 结构与当前组件的 props 接口需要适配
- 流式 markdown 中的不完整语法可能导致 marked 产生不同的 token 结构
- marked 本身不负责 HTML sanitize，必须由 qwen-code renderer 定义安全策略
- 添加依赖会影响 bundle 体积，需要纳入 `processUptimeAtT0Ms` 和 bundle analyzer
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

OSC 11 查询会向终端请求背景色响应，可能与用户输入流、tmux/SSH 组合和非交互输出产生副作用。该能力只作为 opt-in 进阶功能，不作为默认启动路径的一部分；默认策略应优先基于 `NO_COLOR`、`FORCE_COLOR`、`COLORTERM`、`TERM` 和用户显式主题设置。

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

**支持的终端**：iTerm2, kitty, WezTerm, Windows Terminal, Hyper, foot, Contour 等。不支持或禁用 OSC 8 的场景应保持当前纯文本 fallback。

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

**安全与兼容**：

- URL 必须过滤控制字符和 OSC 终止符，避免注入额外 escape sequence
- 仅允许明确协议白名单（如 `http:`, `https:`, `file:`），其他协议按纯文本渲染
- 不支持 OSC 8 或禁用超链接时，保持当前 `text (url)` 的可复制 fallback
- 在 screen reader 模式下默认使用纯文本 fallback

**影响范围**：

- `packages/cli/src/ui/utils/InlineMarkdownRenderer.tsx` — 链接渲染修改
- 新增：超链接工具函数模块

### 2.6 [P2] 消息历史虚拟滚动（Phase 3）

**现状**：所有历史消息通过 `<Static>` 追加到终端 scrollback，长会话会产生大量渲染元素。

**调研结论先行**：这不是一个“列表 slice 一下”的小优化。Gemini CLI 的 `VirtualizedList` 和 Claude Code 的 `useVirtualScroll` 都表明，真正可用的消息虚拟滚动至少要处理：

- 动态高度消息
- 贴底行为（sticky bottom）
- resize 后高度缓存失效
- overscan
- 搜索/跳转/定位
- 复制模式 / 选择模式
- 渲染中间态不出现 blank spacer

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

**应补充的工程约束**：

1. **滚动输入不要每 tick 都走 React setState**
   Claude 的 `ScrollBox` 直接操作 DOM scrollTop，`useVirtualScroll` 只在量化后的 snapshot 变化时触发 React commit。qwen-code 如果让 wheel/scroll 直接驱动高频 state 更新，后续所有虚拟化收益都会被抵消。

2. **高度缓存不能在 resize 时简单清空**
   Claude 采用“按列宽比例缩放旧高度 + 冻结旧 range 两帧”的策略，Gemini 也用 `ResizeObserver` 和实测高度维护 offsets。qwen-code 需要把 resize 视为一等场景，而不是异常路径。

3. **要为 sticky bottom 与 copy/search mode 预留语义**
   Gemini 的 `VirtualizedList` 暴露 `isStickingToBottom`、`stableScrollback`、`copyModeEnabled`；Claude 也把 sticky signal 视为核心状态。qwen-code 若未来要支持 transcript 搜索、selection 或 copy mode，不应把虚拟滚动写成只服务普通聊天输出的最小实现。

4. **初期只建议在 fullscreen / alternate buffer 路径启用**
   Gemini 的经验表明，这类滚动容器最适合全屏或 buffer 模式；main-screen 路径继续用 `Static` + pending 区域更保守。

**参考**：Claude Code 的 `<ScrollBox>` 和 `useVirtualScroll` 形成了完整的滚动/贴底/overscan/resize 体系；Gemini CLI 的 `ScrollableList` / `VirtualizedList` 则证明这一层可以先在 alternate/fullscreen 路径落地。

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

## 3. 竞品参考与路线校准

### 3.1 Gemini CLI：滚动和渲染模式先行

Gemini CLI 在 parser 架构上并没有比 qwen-code 更先进，但它在长会话和渲染模式上已经形成了可借鉴的组合：

| 能力 | 实现方式 |
| --- | --- |
| 长会话容器 | `ScrollableList` / `VirtualizedList` |
| item 级稳定渲染 | `StaticRender` |
| 高度测量 | `ResizeObserver` |
| 贴底行为 | `scrollAnchor` + `isStickingToBottom` |
| scrollback / copy mode | `stableScrollback` / `copyModeEnabled` |

**关键差异**：Gemini 说明“渲染扩展”不仅是 parser 选择，还包括长会话容器和消息呈现模式。

### 3.2 Claude Code：parser、streaming 与虚拟滚动一体化

| 能力 | 实现方式 |
| --- | --- |
| Markdown 解析 | `marked` 库 + LRU token 缓存（500 条） |
| 快速路径 | 正则检测无 MD 语法 → 跳过 `marked.lexer()` |
| 流式优化 | `StreamingMarkdown` 稳定前缀，仅重解析最后一个块 |
| 代码高亮 | `<Suspense>` 包裹的可选 CLI 语法高亮 |
| 表格 | React 组件 `<MarkdownTable>` |
| 超链接 | OSC 8 终端超链接 |
| 长会话 | `ScrollBox` + `useVirtualScroll` + `VirtualMessageList` |

**关键差异**：Claude Code 将 parser、streaming、高亮、虚拟滚动视为同一套渲染架构的一部分，因此能在长会话中同时保持功能完整和性能稳定。

## 4. 实施优先级与里程碑

| 优先级 | 方案                                | 周次  | 风险   | 预期收益                  |
| ------ | ----------------------------------- | ----- | ------ | ------------------------- |
| P0     | Markdown token/block 缓存           | 3     | 低     | 解析耗时显著下降          |
| P0     | 代码高亮缓存 + 同步基线/异步预热     | 3     | 中     | 重复渲染消除，降低大块代码成本 |
| P1     | ANSI 16 色默认 + 能力检测           | 4     | 中     | 修复透明终端兼容性        |
| P1     | 切换到 marked 解析器                | 7-8   | 中     | GFM 基础能力增强          |
| P1     | streaming stable prefix / suffix    | 7-8   | 中     | 流式重解析成本显著下降    |
| P2     | OSC 8 终端超链接                    | 9-10  | 低     | URL 可点击                |
| P2     | fullscreen / alternate 路径虚拟滚动 | 13-15 | 高     | 长会话性能                |
| P3     | LaTeX 数学公式                      | 15-16 | 中     | 数学内容渲染              |
| 远期   | Web 渲染探索                        | TBD   | 探索性 | 富文本能力                |

## 5. 验证方案

除本节外，实施前还应对照 `06-implementation-rollout-checklist.md` 中“渲染与扩展验收清单”的退出标准。

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
- 表格回归（ANSI + CJK + emoji、极窄宽度、vertical fallback、代码 span 中 pipe）
- 列表（有序 + 无序 + 嵌套 + 混合）
- 内联格式（加粗 + 斜体 + 代码 + 链接 + 删除线）
- 分割线
- 引用块
- streaming partial blocks（未闭合代码块、未闭合表格、未闭合列表）
- stable prefix / unstable suffix 切换场景
- HTML 输入（默认转义/忽略策略）
- resize 后高度缓存与虚拟滚动 range 稳定性

### 5.3 主题兼容性

| 终端             | ANSI 16 色   | 256 色 | Truecolor | 透明背景      |
| ---------------- | ------------ | ------ | --------- | ------------- |
| iTerm2           | 正确         | 正确   | 正确      | ANSI 模式正确 |
| Terminal.app     | 正确         | 正确   | N/A       | ANSI 模式正确 |
| kitty            | 正确         | 正确   | 正确      | ANSI 模式正确 |
| WezTerm          | 正确         | 正确   | 正确      | ANSI 模式正确 |
| Windows Terminal | 正确         | 正确   | 正确      | ANSI 模式正确 |
| NO_COLOR 环境    | NoColor 主题 | —      | —         | —             |
