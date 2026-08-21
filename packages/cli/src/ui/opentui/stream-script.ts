/**
 * Framework-agnostic fake streaming engine for the POC.
 * Produces the same event stream shape a real agent loop would,
 * so the opentui POC and the ink reference demo render identical content.
 */

export type StreamEvent =
  | { type: 'thinking'; delta: string }
  | { type: 'thinking-end' }
  | { type: 'text'; delta: string }
  | { type: 'tool-start'; id: string; tool: string; title: string }
  | { type: 'tool-output'; id: string; delta: string }
  | { type: 'tool-end'; id: string; success: boolean; summary: string }
  | { type: 'task-start'; id: string; name: string; description: string }
  | { type: 'task-progress'; id: string; line: string }
  | {
      type: 'task-end';
      id: string;
      tools: number;
      seconds: number;
      tokens: string;
    }
  | { type: 'done' };

const THINKING =
  '用户想让我分析 VP 模式下的渲染性能问题。需要先看看 AppContainer 的渲染路径，' +
  '再搜索 clearTerminal 的调用点。ink 的整帧擦写在 Warp 上可能是闪烁的根源，' +
  '我应该先收集证据，再给出分优先级的建议。让我先读一下核心文件。';

const TEXT_1 =
  '我来分析 **VP 模式**的渲染路径。先读取核心编排组件，并搜索整屏清屏的调用点。\n\n';

const TOOL_READ_OUTPUT =
  "import React from 'react';\n" +
  "import { Box, Text } from 'ink';\n" +
  '// AppContainer: 4779 lines — holds all UI state\n' +
  'export const AppContainer = ({ config }: Props) => {\n' +
  '  const [thoughtExpanded, setThoughtExpanded] = useState(false);\n';

const TOOL_GREP_OUTPUT =
  'packages/cli/src/ui/AppContainer.tsx:1306:    ansiEscapes.clearTerminal\n' +
  'packages/cli/src/ui/MainContent.tsx:503:  // Ink cannot update incrementally and clears the terminal\n' +
  'node_modules/ink/build/ink.js:84: function shouldClearTerminalForFrame(\n' +
  'packages/cli/src/ui/utils/terminalRedrawOptimizer.ts:155: clearTerminal: 0\n' +
  'packages/cli/src/ui/AppContainer.tsx:1286: // Writing clearTerminal would be a wasted flash\n' +
  'packages/cli/src/ui/startInteractiveUI.tsx:242: alternateScreen: useVP\n';

const TEXT_2 =
  '找到了关键点：ink 在帧溢出视口时会回退到 `clearTerminal` 整屏重绘。\n\n' +
  '```typescript\n' +
  '// node_modules/ink/build/ink.js:84\n' +
  'function shouldClearTerminalForFrame({\n' +
  '  lastOutput,\n' +
  '  output,\n' +
  '  terminalHeight,\n' +
  '}) {\n' +
  '  if (!lastOutput) return false;\n' +
  "  const lastLines = lastOutput.split('\\n');\n" +
  '  return lastLines.length > terminalHeight;\n' +
  '}\n' +
  '```\n\n';

const TASK_LINES = [
  '↳ Grep "requestRender" in packages/cli/src',
  '↳ Read node_modules/ink/build/log-update.js',
  '↳ Bash: node bench-frame-bytes.js',
];

const TEXT_3 =
  '子代理完成了 ink 帧写入的基准测试，汇总结论如下：\n\n' +
  '| 模式 | 每帧字节 | 擦除序列 | Warp 表现 |\n' +
  '| --- | --- | --- | --- |\n' +
  '| ink 标准 | ~4.2 KB | `2K`×40 | 明显闪烁 |\n' +
  '| ink incremental | ~0.3 KB | `K`×变化行 | 仍然闪烁 |\n' +
  '| opentui cell-diff | ~70 B | 无 | 待验证 |\n\n' +
  '建议按以下优先级推进：\n\n' +
  '1. **先跑本 POC** 在 Warp / Tabby / PowerShell 上实测闪烁是否消失\n' +
  '2. 鼠标选择与复制对齐原生终端体验（opentui 原生选区）\n' +
  '3. 确认后再制定 qwen-code 的完整迁移计划\n';

/** Split text into token-ish chunks (2–8 chars, CJK-aware). */
function tokenize(text: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const size = 2 + Math.floor(Math.random() * 7);
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks;
}

/** Build the full scripted event list (deterministic order, tokenized deltas). */
export function buildScenario(): StreamEvent[] {
  const events: StreamEvent[] = [];

  for (const delta of tokenize(THINKING))
    events.push({ type: 'thinking', delta });
  events.push({ type: 'thinking-end' });

  for (const delta of tokenize(TEXT_1)) events.push({ type: 'text', delta });

  events.push({
    type: 'tool-start',
    id: 't1',
    tool: 'Read',
    title: 'Read packages/cli/src/ui/AppContainer.tsx',
  });
  for (const delta of tokenize(TOOL_READ_OUTPUT))
    events.push({ type: 'tool-output', id: 't1', delta });
  events.push({
    type: 'tool-end',
    id: 't1',
    success: true,
    summary: '4779 lines',
  });

  events.push({
    type: 'tool-start',
    id: 't2',
    tool: 'Bash',
    title: 'rg -n "clearTerminal" packages/cli/src node_modules/ink/build',
  });
  for (const delta of tokenize(TOOL_GREP_OUTPUT))
    events.push({ type: 'tool-output', id: 't2', delta });
  events.push({
    type: 'tool-end',
    id: 't2',
    success: true,
    summary: '6 matches',
  });

  for (const delta of tokenize(TEXT_2)) events.push({ type: 'text', delta });

  events.push({
    type: 'task-start',
    id: 's1',
    name: 'researcher',
    description: 'benchmark ink frame write patterns',
  });
  for (const line of TASK_LINES)
    events.push({ type: 'task-progress', id: 's1', line });
  events.push({
    type: 'task-end',
    id: 's1',
    tools: 3,
    seconds: 12.4,
    tokens: '2.1k',
  });

  for (const delta of tokenize(TEXT_3)) events.push({ type: 'text', delta });

  events.push({ type: 'done' });
  return events;
}

export const TOKEN_INTERVAL_MS = 12;
