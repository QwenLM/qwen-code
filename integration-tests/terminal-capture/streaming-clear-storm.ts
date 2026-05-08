#!/usr/bin/env npx tsx
/**
 * Deterministic TUI validation for long assistant streaming output.
 *
 * This script records screenshots/GIF and checks the raw ANSI stream from the
 * same run. It intentionally disables synchronized-output wrapping so the pass
 * signal measures whether Ink had to clear and replay the screen, not whether a
 * terminal emulator hid the clear sequence.
 *
 * Usage:
 *   npm run build && npm run bundle
 *   cd integration-tests/terminal-capture
 *   npm run capture:streaming-clear-storm
 *
 * Useful env:
 *   QWEN_TUI_E2E_REPO=/path/to/qwen-code
 *   QWEN_TUI_E2E_OUT=/tmp/qwen-tui-streaming-clear-storm
 *   QWEN_TUI_E2E_MIN_CLEAR_PAIRS=1
 *   QWEN_TUI_E2E_MAX_CLEAR_PAIRS=Infinity
 */

import { execFileSync } from 'node:child_process';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TerminalCapture } from './terminal-capture.js';
import stripAnsi from 'strip-ansi';

const STREAM_DONE = 'E2E_STREAM_DONE';
const STREAM_CHUNK_COUNT = 220;
const STREAM_INTERVAL_MS = 70;
const FRAME_COUNT = 90;
const FRAME_INTERVAL_MS = 180;
const LIVE_FLUSH_INTERVAL_MS = 16;
const DEFAULT_TERMINAL_COLS = 88;
const DEFAULT_TERMINAL_ROWS = 26;
const MAX_PENDING_PREVIEW_REPEAT_LINES = 2;
const ESC = '\u001B';
const ESC_PATTERN = '\\u001B';

type FakeServer = {
  baseUrl: string;
  getRequestCount: () => number;
  close: () => Promise<void>;
};

type Counts = {
  clearTerminalPairCount: number;
  clearScreenCodeCount: number;
  eraseLineCount: number;
  cursorUpCount: number;
};

type Summary = Counts & {
  repoRoot: string;
  outputDir: string;
  gifPath: string | null;
  streamPayload: string;
  framesCaptured: number;
  rawBytes: number;
  streamDeltaBytes: number;
  finalScreenLines: number;
  finalDoneCount: number;
  requestCount: number;
  hiddenMarkerCount: number;
  rawMermaidFenceCount: number;
  maxFrameHiddenMarkerCount: number;
  maxFrameRawMermaidFenceCount: number;
  maxFrameBlankRun: number;
  maxPreDoneFrameBlankRun: number;
  finalScreenBlankRun: number;
  finalViewportBlankRun: number;
  stallSentinelExpectedCount: number;
  stallSentinelOccurrenceCount: number;
  maxFrameStallSentinelOccurrenceCount: number;
  stallSentinelAmplificationRatio: number | null;
  maxFrameStallSentinelAmplificationRatio: number | null;
  minPostDoneViewportStallSentinelOccurrenceCount: number | null;
  tableSentinelExpectedCount: number;
  tableSentinelOccurrenceCount: number;
  maxFrameTableSentinelOccurrenceCount: number;
  maxPreDoneFrameTableSentinelOccurrenceCount: number;
  tableSentinelAmplificationRatio: number | null;
  maxFrameTableSentinelAmplificationRatio: number | null;
  maxPreDoneFrameTableSentinelAmplificationRatio: number | null;
  reasoningSentinelExpectedCount: number;
  reasoningSentinelOccurrenceCount: number;
  maxFrameReasoningSentinelOccurrenceCount: number;
  reasoningSentinelAmplificationRatio: number | null;
  maxFrameReasoningSentinelAmplificationRatio: number | null;
  openFenceSentinelExpectedCount: number;
  openFenceSentinelOccurrenceCount: number;
  maxPreDoneFrameOpenFenceSentinelOccurrenceCount: number;
  openFenceLivePreviewSeen: boolean;
  openFenceSentinelAmplificationRatio: number | null;
  maxPreDoneFrameOpenFenceSentinelAmplificationRatio: number | null;
  structuralRepeatExpectedPreDoneCount: number;
  structuralRepeatOccurrenceCount: number;
  maxPreDoneFrameStructuralRepeatOccurrenceCount: number;
  structuralRepeatAmplificationRatio: number | null;
  maxPreDoneFrameStructuralRepeatAmplificationRatio: number | null;
  genericRepeatExpectedPreDoneCount: number;
  genericRepeatOccurrenceCount: number;
  maxPreDoneFrameGenericRepeatOccurrenceCount: number;
  genericRepeatAmplificationRatio: number | null;
  maxPreDoneFrameGenericRepeatAmplificationRatio: number | null;
  recoveryOverlapExpectedCount: number;
  recoveryOverlapOccurrenceCount: number;
  maxFrameRecoveryOverlapOccurrenceCount: number;
  recoveryOverlapAmplificationRatio: number | null;
  maxFrameRecoveryOverlapAmplificationRatio: number | null;
  terminal: {
    cols: number;
    rows: number;
    resizeCols: number[];
  };
  limits: {
    minClearTerminalPairs: number;
    maxClearTerminalPairs: number | 'Infinity';
    minFrames: number;
  };
  pass: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  return Number(value);
}

function serializeNumberLimit(value: number): number | 'Infinity' {
  return Number.isFinite(value) ? value : 'Infinity';
}

function envNumberList(name: string): number[] {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    return [];
  }

  return value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part) && part > 0);
}

function qwenArgs(baseUrl: string): string[] {
  const args = [
    'dist/cli.js',
    '--approval-mode',
    'yolo',
    '--auth-type',
    'openai',
    '--openai-api-key',
    'dummy',
    '--openai-base-url',
    baseUrl,
    '--model',
    'dummy',
  ];

  if (process.env['QWEN_TUI_E2E_BARE'] !== '0') {
    args.splice(1, 0, '--bare');
  }

  return args;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countWrappedOccurrences(text: string, needle: string): number {
  const pattern = new RegExp(
    needle
      .split('')
      .map((char) => escapeRegExp(char))
      .join('\\s*'),
    'g',
  );

  return countPattern(text, pattern);
}

function countPattern(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function maxConsecutiveBlankLines(text: string): number {
  let max = 0;
  let current = 0;

  for (const line of stripAnsi(text).split('\n')) {
    if (line.trim().length === 0) {
      current += 1;
      max = Math.max(max, current);
      continue;
    }

    current = 0;
  }

  return max;
}

function captureCounts(raw: string): Counts {
  return {
    clearTerminalPairCount: countOccurrences(raw, `${ESC}[2J${ESC}[3J${ESC}[H`),
    clearScreenCodeCount:
      countOccurrences(raw, `${ESC}[2J`) +
      countOccurrences(raw, `${ESC}[3J`) +
      countOccurrences(raw, `${ESC}c`),
    eraseLineCount: countPattern(
      raw,
      new RegExp(`${ESC_PATTERN}\\[[0-2]?K`, 'g'),
    ),
    cursorUpCount: countPattern(
      raw,
      new RegExp(`${ESC_PATTERN}\\[[0-9]+A`, 'g'),
    ),
  };
}

function markdownChunks(): string[] {
  const lines = [
    "Here's another Mermaid flowchart example - this one models a CI/CD pipeline:",
    '',
    '```mermaid',
    'flowchart TD',
    '    A[Commit pushed] --> B[Install dependencies]',
    '    B --> C[Run lint]',
    '    C --> D[Run unit tests]',
    '    D --> E[Build package]',
    '    E --> F[Publish artifacts]',
    '```',
    '',
    '**Note:** The retry loop uses exponential backoff to avoid hammering the API while preserving delivery.',
  ];

  return lines.flatMap((line) => [line, '\n']);
}

const STALL_SENTINELS = [
  'QWEN_A1',
  'QWEN_B1',
  'QWEN_C1',
  'QWEN_D1',
  'QWEN_E1',
  'QWEN_F1',
];

const TABLE_SENTINELS = [
  'QWEN_TABLE_01',
  'QWEN_TABLE_02',
  'QWEN_TABLE_03',
  'QWEN_TABLE_04',
  'QWEN_TABLE_05',
  'QWEN_TABLE_06',
  'QWEN_TABLE_07',
  'QWEN_TABLE_08',
];

const REASONING_SENTINELS = [
  'QWEN_REASONING_01',
  'QWEN_REASONING_02',
  'QWEN_REASONING_03',
  'QWEN_REASONING_04',
  'QWEN_REASONING_05',
  'QWEN_REASONING_06',
];

const OPEN_FENCE_SENTINELS = [
  'QWEN_CLASS_01',
  'QWEN_CLASS_02',
  'QWEN_CLASS_03',
  'QWEN_CLASS_04',
  'QWEN_CLASS_05',
  'QWEN_CLASS_06',
];

const STRUCTURAL_REPEAT_SENTINELS = [
  'QWEN_STRUCTURAL_TITLE',
  'QWEN_STRUCTURAL_TABLE',
];

const GENERIC_REPEAT_SENTINEL = 'QWEN_GENERIC_REPEAT';
const RECOVERY_OVERLAP_SENTINEL = 'QWEN_TAIL';
const RECOVERY_OVERLAP_UNIQUE_SENTINEL = 'QWEN_DONE';

function markdownStallChunks(): string[] {
  const lines = [
    'Here is a deterministic Mermaid flowchart used by the TUI stall regression:',
    '',
    '```mermaid',
    'flowchart TD',
    '    A[QWEN_A1] --> B[QWEN_B1]',
    '    B --> C[QWEN_C1]',
    '    C --> D[QWEN_D1]',
    '    D --> E[QWEN_E1]',
    '    E --> F[QWEN_F1]',
    '```',
    '',
    'This sentence arrives before the server intentionally stalls.',
  ];

  return lines.flatMap((line) => [line, '\n']);
}

function markdownBlankTailChunks(): string[] {
  return [...markdownStallChunks(), ...Array.from({ length: 80 }, () => '\n')];
}

function markdownTableChunks(): string[] {
  const lines = [
    'The following section is a deterministic Flowchart Syntax Reference:',
    '',
    '```mermaid',
    'flowchart TD',
    '    A[Start] --> B{Decision}',
    '    B --> C[Process]',
    '```',
    '',
    '## Flowchart Syntax Reference',
    '',
    '| Syntax | Direction | Sentinel |',
    '| --- | --- | --- |',
    ...TABLE_SENTINELS.map(
      (sentinel, index) =>
        `| \`${sentinel}\` | Flowchart syntax reference row ${index + 1} |`,
    ),
    '',
    'This paragraph closes the table after the normal streaming output.',
  ];

  return lines.flatMap((line) => [line, '\n']);
}

function markdownTableStallChunks(): string[] {
  const lines = [
    'The following section is a deterministic Flowchart Syntax Reference:',
    '',
    '## Flowchart Syntax Reference',
    '',
    '| Syntax | Direction | Sentinel |',
    '| --- | --- | --- |',
    ...TABLE_SENTINELS.map(
      (sentinel, index) =>
        `| \`${sentinel}\` | Flowchart syntax reference row ${index + 1} |`,
    ),
  ];

  return lines.flatMap((line) => [line, '\n']);
}

function markdownTableStallCloseChunks(): string[] {
  return [
    '',
    'This paragraph closes the table after the stalled streaming output.',
    '',
    STREAM_DONE,
  ].flatMap((line) => [line, '\n']);
}

function markdownTableOverlapChunks(): string[] {
  const finalText = [
    '### 常用语法速查',
    '',
    '| 语法 | 说明 | Sentinel |',
    '| --- | --- | --- |',
    ...TABLE_SENTINELS.map(
      (sentinel, index) =>
        `| \`${sentinel}\` | Flowchart syntax reference row ${index + 1} | row ${index + 1} |`,
    ),
    '',
    STREAM_DONE,
  ].join('\n');

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < finalText.length) {
    const nextCursor = Math.min(finalText.length, cursor + 44);
    const overlapStart = Math.max(0, cursor - 22);
    chunks.push(finalText.slice(overlapStart, nextCursor));
    cursor = nextCursor;
  }

  return chunks;
}

function reasoningScrollbackChunks(): string[] {
  const lines = [
    'The user is asking for a deterministic reasoning scrollback regression.',
    '',
    ...REASONING_SENTINELS.map(
      (sentinel, index) =>
        `${sentinel}: Since the user asked for narrow terminal evidence, reasoning row ${index + 1} stays internal.`,
    ),
    '',
    'The visible answer should not include the reasoning sentinels.',
  ];

  return lines.flatMap((line) => [line, '\n']);
}

function markdownOpenFenceStallChunks(): string[] {
  const lines = [
    '',
    '',
    '下面是一个完整的 Mermaid 类图示例：',
    '',
    '```mermaid',
    'classDiagram',
    ...OPEN_FENCE_SENTINELS.map((sentinel) => `    class ${sentinel}:::entity`),
  ];

  return lines.flatMap((line) => [line, '\n']);
}

function markdownOpenFenceCloseChunks(): string[] {
  return [
    '```',
    '',
    '类图输出结束，未闭合代码块不应在生成中污染滚动历史。',
    '',
    STREAM_DONE,
  ].flatMap((line) => [line, '\n']);
}

function markdownStructuralRepeatStallChunks(): string[] {
  const lines = [
    '',
    '',
    '### QWEN_STRUCTURAL_TITLE 语法参考',
    '### QWEN_STRUCTURAL_TITLE 语法参考',
    '### QWEN_STRUCTURAL_TITLE 语法参考',
    '',
    '| QWEN_STRUCTURAL_TABLE 语法 | 说明 |',
    '| QWEN_STRUCTURAL_TABLE 语法 | 说明 |',
    '| QWEN_STRUCTURAL_TABLE 语法 | 说明 |',
    '| QWEN_STRUCTURAL_TABLE 语法 | 说明 |',
    '| QWEN_STRUCTURAL_TABLE 语法 | 说明 |',
    '| QWEN_STRUCTURAL_TABLE 语法 | 说明 |',
    '| QWEN_STRUCTURAL_TABLE 语法 | 说明 |',
    '| QWEN_STRUCTURAL_TABLE 语法 | 说明 |',
  ];

  return lines.flatMap((line) => [line, '\n']);
}

function markdownProgressiveStructureStallChunks(): string[] {
  const lines = [
    '',
    '',
    '### QWEN_STRUCTURAL_TITLE 语法',
    '### QWEN_STRUCTURAL_TITLE 语法参考',
    '',
    '| QWEN_STRUCTURAL_TABLE 语法 | 说明',
    '| QWEN_STRUCTURAL_TABLE 语法 | 说明 |',
    '| QWEN_STRUCTURAL_TABLE 语法 | 说明 | 示例 |',
    '',
    '| `flowchart TD/L',
    '| `flowchart TD/LR/RL/BT` |',
    '| `flowchart TD/LR/RL/BT` | 示例 |',
  ];

  return lines.flatMap((line) => [line, '\n']);
}

function markdownStructuralRepeatCloseChunks(): string[] {
  return [
    '',
    '重复结构行输出结束，live preview 应只显示去重后的稳定摘要。',
    '',
    STREAM_DONE,
  ].flatMap((line) => [line, '\n']);
}

function markdownGenericRepeatStallChunks(): string[] {
  const lines = [
    '',
    '',
    '下面是一个完整的 Mermaid 时序图示例：',
    '',
    ...Array.from(
      { length: 14 },
      () => `${GENERIC_REPEAT_SENTINEL} 需要其他类型的 Mermaid 图`,
    ),
  ];

  return lines.flatMap((line) => [line, '\n']);
}

function markdownGenericRepeatCloseChunks(): string[] {
  return [
    '',
    '普通重复行输出结束，live preview 应限制重复行。',
    '',
    STREAM_DONE,
  ].flatMap((line) => [line, '\n']);
}

function recoveryOverlapChunksForRequest(requestIndex: number): string[] {
  if (requestIndex === 1) {
    return [
      'This first capped attempt is intentionally discarded before escalation.',
    ];
  }

  if (requestIndex === 2) {
    return [
      'Here is the escalated response before recovery: ',
      RECOVERY_OVERLAP_SENTINEL,
    ];
  }

  return [
    RECOVERY_OVERLAP_SENTINEL,
    ' ',
    RECOVERY_OVERLAP_UNIQUE_SENTINEL,
    ' ',
    STREAM_DONE,
  ];
}

function recoveryContainedReplayChunksForRequest(
  requestIndex: number,
): string[] {
  if (requestIndex === 1) {
    return [
      'This first capped attempt is intentionally discarded before escalation.',
    ];
  }

  if (requestIndex === 2) {
    return [
      [
        'Intro before recovery',
        `### ${RECOVERY_OVERLAP_SENTINEL} 常用语法速查`,
        '| 语法 | 说明 |',
        'tail that was truncated',
      ].join('\n'),
    ];
  }

  return [
    [
      `### ${RECOVERY_OVERLAP_SENTINEL} 常用语法速查`,
      '| 语法 | 说明 |',
      RECOVERY_OVERLAP_UNIQUE_SENTINEL,
      STREAM_DONE,
    ].join('\n'),
  ];
}

function defaultChunks(): string[] {
  return Array.from({ length: STREAM_CHUNK_COUNT }, (_, index) => {
    const marker = String(index).padStart(3, '0');
    return `clear-storm-${marker}-alpha clear-storm-${marker}-beta clear-storm-${marker}-gamma `;
  });
}

function getChunksForPayload(payload: string): string[] {
  const normalizedPayload = payload.endsWith('-cumulative')
    ? payload.slice(0, -'-cumulative'.length)
    : payload;

  if (normalizedPayload === 'markdown') {
    return markdownChunks();
  }

  if (normalizedPayload === 'markdown-stall') {
    return markdownStallChunks();
  }

  if (normalizedPayload === 'markdown-blank-tail') {
    return markdownBlankTailChunks();
  }

  if (normalizedPayload === 'markdown-table') {
    return markdownTableChunks();
  }

  if (normalizedPayload === 'markdown-table-stall') {
    return markdownTableStallChunks();
  }

  if (normalizedPayload === 'markdown-table-overlap') {
    return markdownTableOverlapChunks();
  }

  if (normalizedPayload === 'reasoning-scrollback') {
    return [
      'Visible answer after hidden reasoning.',
      '\n',
      'No reasoning sentinel should be written into the transcript.',
      '\n',
    ];
  }

  if (normalizedPayload === 'markdown-open-fence-stall') {
    return markdownOpenFenceStallChunks();
  }

  if (normalizedPayload === 'markdown-structural-repeat-stall') {
    return markdownStructuralRepeatStallChunks();
  }

  if (normalizedPayload === 'markdown-progressive-structure-stall') {
    return markdownProgressiveStructureStallChunks();
  }

  if (normalizedPayload === 'markdown-generic-repeat-stall') {
    return markdownGenericRepeatStallChunks();
  }

  if (normalizedPayload === 'recovery-overlap') {
    return recoveryOverlapChunksForRequest(1);
  }

  if (normalizedPayload === 'recovery-contained-replay') {
    return recoveryContainedReplayChunksForRequest(1);
  }

  return defaultChunks();
}

function countStallSentinels(text: string): number {
  return STALL_SENTINELS.reduce(
    (total, sentinel) => total + countOccurrences(text, sentinel),
    0,
  );
}

function countTableSentinels(text: string): number {
  return TABLE_SENTINELS.reduce(
    (total, sentinel) => total + countOccurrences(text, sentinel),
    0,
  );
}

function countReasoningSentinels(text: string): number {
  return REASONING_SENTINELS.reduce(
    (total, sentinel) => total + countOccurrences(text, sentinel),
    0,
  );
}

function countOpenFenceSentinels(text: string): number {
  return OPEN_FENCE_SENTINELS.reduce(
    (total, sentinel) => total + countWrappedOccurrences(text, sentinel),
    0,
  );
}

function countStructuralRepeatSentinels(text: string): number {
  return STRUCTURAL_REPEAT_SENTINELS.reduce(
    (total, sentinel) => total + countOccurrences(text, sentinel),
    0,
  );
}

function countGenericRepeatSentinels(text: string): number {
  return countOccurrences(text, GENERIC_REPEAT_SENTINEL);
}

function countRecoveryOverlapSentinels(text: string): number {
  return countOccurrences(text, RECOVERY_OVERLAP_SENTINEL);
}

function amplificationRatio(
  occurrences: number,
  expectedCount: number,
): number | null {
  return expectedCount > 0 ? occurrences / expectedCount : null;
}

function isMarkdownTablePayload(payload: string): boolean {
  return (
    payload === 'markdown-table' ||
    payload === 'markdown-table-stall' ||
    payload === 'markdown-table-cumulative' ||
    payload === 'markdown-table-overlap'
  );
}

function isReasoningScrollbackPayload(payload: string): boolean {
  return payload === 'reasoning-scrollback';
}

function isMarkdownOpenFenceStallPayload(payload: string): boolean {
  return payload === 'markdown-open-fence-stall';
}

function isMarkdownStructuralRepeatStallPayload(payload: string): boolean {
  return (
    payload === 'markdown-structural-repeat-stall' ||
    payload === 'markdown-progressive-structure-stall'
  );
}

function isMarkdownGenericRepeatStallPayload(payload: string): boolean {
  return payload === 'markdown-generic-repeat-stall';
}

function isRecoveryOverlapPayload(payload: string): boolean {
  return (
    payload === 'recovery-overlap' || payload === 'recovery-contained-replay'
  );
}

function streamOpenAIResponse(
  res: ServerResponse,
  payload: string,
  requestIndex: number,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const base = {
    id: 'chatcmpl-qwen-tui-clear-storm',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'dummy',
  };

  send({
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });

  const chunks = isRecoveryOverlapPayload(payload)
    ? payload === 'recovery-contained-replay'
      ? recoveryContainedReplayChunksForRequest(requestIndex)
      : recoveryOverlapChunksForRequest(requestIndex)
    : getChunksForPayload(payload);
  if (
    !isRecoveryOverlapPayload(payload) &&
    payload !== 'markdown-table-overlap' &&
    payload !== 'markdown-table-stall' &&
    !isMarkdownOpenFenceStallPayload(payload) &&
    !isMarkdownStructuralRepeatStallPayload(payload) &&
    !isMarkdownGenericRepeatStallPayload(payload)
  ) {
    chunks.push(STREAM_DONE);
  }
  const useCumulativeTextDelta = payload.endsWith('-cumulative');
  const reasoningChunks = isReasoningScrollbackPayload(payload)
    ? reasoningScrollbackChunks()
    : [];
  const streamIntervalMs = envNumber(
    'QWEN_TUI_E2E_STREAM_INTERVAL_MS',
    STREAM_INTERVAL_MS,
  );
  const stallBeforeFinishMs =
    payload === 'markdown-stall' ||
    payload === 'markdown-blank-tail' ||
    payload === 'markdown-table-stall' ||
    isMarkdownOpenFenceStallPayload(payload) ||
    isMarkdownStructuralRepeatStallPayload(payload) ||
    isMarkdownGenericRepeatStallPayload(payload)
      ? envNumber('QWEN_TUI_E2E_STREAM_STALL_MS', 8000)
      : 0;

  let index = 0;
  let reasoningIndex = 0;
  let cumulativeContent = '';
  const finish = (finishReason = 'stop') => {
    send({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 221, total_tokens: 231 },
    });
    res.write('data: [DONE]\n\n');
    res.end();
  };

  const timer = setInterval(() => {
    if (reasoningIndex < reasoningChunks.length) {
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              reasoning_content: reasoningChunks[reasoningIndex],
            },
            finish_reason: null,
          },
        ],
      });
      reasoningIndex += 1;
      return;
    }

    if (index < chunks.length) {
      cumulativeContent += chunks[index];
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              content: useCumulativeTextDelta
                ? cumulativeContent
                : chunks[index],
            },
            finish_reason: null,
          },
        ],
      });
      index += 1;
      return;
    }

    clearInterval(timer);
    if (stallBeforeFinishMs > 0) {
      setTimeout(() => {
        if (isMarkdownOpenFenceStallPayload(payload)) {
          for (const chunk of markdownOpenFenceCloseChunks()) {
            send({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    content: chunk,
                  },
                  finish_reason: null,
                },
              ],
            });
          }
        }
        if (payload === 'markdown-table-stall') {
          for (const chunk of markdownTableStallCloseChunks()) {
            send({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    content: chunk,
                  },
                  finish_reason: null,
                },
              ],
            });
          }
        }
        if (isMarkdownStructuralRepeatStallPayload(payload)) {
          for (const chunk of markdownStructuralRepeatCloseChunks()) {
            send({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    content: chunk,
                  },
                  finish_reason: null,
                },
              ],
            });
          }
        }
        if (isMarkdownGenericRepeatStallPayload(payload)) {
          for (const chunk of markdownGenericRepeatCloseChunks()) {
            send({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    content: chunk,
                  },
                  finish_reason: null,
                },
              ],
            });
          }
        }
        finish();
      }, stallBeforeFinishMs);
      return;
    }

    finish(
      isRecoveryOverlapPayload(payload) && requestIndex < 3 ? 'length' : 'stop',
    );
  }, streamIntervalMs);
}

async function startFakeOpenAIServer(payload: string): Promise<FakeServer> {
  let requestCount = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCount += 1;
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (body.includes('"stream":true')) {
        streamOpenAIResponse(res, payload, requestCount);
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-qwen-tui-clear-storm',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'dummy',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: STREAM_DONE },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }),
      );
    });
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to start fake OpenAI server');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    getRequestCount: () => requestCount,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

function generateGifWithFfmpeg(
  frames: string[],
  outputDir: string,
): string | null {
  const gifPath = join(outputDir, 'streaming-clear-storm.gif');
  const listFile = join(outputDir, 'frames.txt');
  const lines = frames.flatMap((frame) => [
    `file '${resolve(frame).replace(/'/g, "'\\''")}'`,
    `duration ${
      frame.includes('-stream-') ? String(FRAME_INTERVAL_MS / 1000) : '1.0'
    }`,
  ]);
  lines.push(
    `file '${resolve(frames[frames.length - 1]).replace(/'/g, "'\\''")}'`,
  );
  writeFileSync(listFile, lines.join('\n'));

  try {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-vf',
        'split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
        '-loop',
        '0',
        gifPath,
      ],
      { stdio: 'pipe' },
    );
    return gifPath;
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(listFile);
    } catch {
      // Ignore cleanup failures.
    }
  }
}

function generateGifWithPython(
  frames: string[],
  outputDir: string,
): string | null {
  const gifPath = join(outputDir, 'streaming-clear-storm.gif');
  const python = process.env['QWEN_TUI_E2E_PYTHON'] ?? 'python3';
  const script = String.raw`
import os
import sys
from PIL import Image

out = sys.argv[1]
frames = sys.argv[2:]
images = []
durations = []
for frame in frames:
    image = Image.open(frame)
    images.append(
        image.convert("P", palette=Image.Palette.ADAPTIVE, colors=128)
    )
    durations.append(350 if "-stream-" in os.path.basename(frame) else 1000)

images[0].save(
    out,
    save_all=True,
    append_images=images[1:],
    duration=durations,
    loop=0,
    optimize=False,
)
`;

  try {
    execFileSync(python, ['-c', script, gifPath, ...frames], {
      stdio: 'pipe',
    });
    return gifPath;
  } catch {
    return null;
  }
}

function generateGif(frames: string[], outputDir: string): string | null {
  if (frames.length === 0) {
    return null;
  }

  return (
    generateGifWithFfmpeg(frames, outputDir) ??
    generateGifWithPython(frames, outputDir)
  );
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const defaultRepoRoot = resolve(scriptDir, '../..');
  const repoRoot = resolve(process.env['QWEN_TUI_E2E_REPO'] ?? defaultRepoRoot);
  const defaultOut = join(
    tmpdir(),
    'qwen-tui-streaming-clear-storm',
    basename(repoRoot),
  );
  const outputDir = resolve(process.env['QWEN_TUI_E2E_OUT'] ?? defaultOut);
  const minClearTerminalPairs = envNumber('QWEN_TUI_E2E_MIN_CLEAR_PAIRS', 0);
  const maxClearTerminalPairs = envNumber('QWEN_TUI_E2E_MAX_CLEAR_PAIRS', 0);
  const minFrames = envNumber('QWEN_TUI_E2E_MIN_FRAMES', 40);
  const terminalCols = envNumber(
    'QWEN_TUI_E2E_TERMINAL_COLS',
    DEFAULT_TERMINAL_COLS,
  );
  const terminalRows = envNumber(
    'QWEN_TUI_E2E_TERMINAL_ROWS',
    DEFAULT_TERMINAL_ROWS,
  );
  const streamingResizeCols = envNumberList(
    'QWEN_TUI_E2E_STREAMING_RESIZE_COLS',
  );
  const streamingResizeEveryFrames = Math.max(
    1,
    envNumber('QWEN_TUI_E2E_STREAMING_RESIZE_EVERY_FRAMES', 8),
  );
  const streamPayload = process.env['QWEN_TUI_E2E_STREAM_PAYLOAD'] ?? 'default';
  const frameCount = Math.max(
    1,
    envNumber('QWEN_TUI_E2E_FRAME_COUNT', FRAME_COUNT),
  );

  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true });
  }
  mkdirSync(outputDir, { recursive: true });

  const fakeServer = await startFakeOpenAIServer(streamPayload);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEV: 'true',
    FORCE_COLOR: '1',
    NODE_NO_WARNINGS: '1',
    QWEN_CODE_DISABLE_SYNCHRONIZED_OUTPUT: '1',
    QWEN_CODE_NO_RELAUNCH: '1',
    QWEN_CODE_SIMPLE: '1',
    QWEN_SANDBOX: 'false',
    TERM: 'xterm-256color',
  };
  delete env['NO_COLOR'];

  const terminal = await TerminalCapture.create({
    cols: terminalCols,
    rows: terminalRows,
    cwd: repoRoot,
    outputDir,
    title: 'streaming clear storm',
    theme: 'github-dark',
    chrome: true,
    fontSize: 14,
    env,
  });
  const frames: string[] = [];
  const frameHiddenMarkerCounts: number[] = [];
  const frameRawMermaidFenceCounts: number[] = [];
  const frameBlankRuns: number[] = [];
  const preDoneFrameBlankRuns: number[] = [];
  const frameStallSentinelOccurrenceCounts: number[] = [];
  const postDoneViewportStallSentinelOccurrenceCounts: number[] = [];
  const frameTableSentinelOccurrenceCounts: number[] = [];
  const preDoneFrameTableSentinelOccurrenceCounts: number[] = [];
  const frameReasoningSentinelOccurrenceCounts: number[] = [];
  const preDoneFrameOpenFenceSentinelOccurrenceCounts: number[] = [];
  const preDoneFrameStructuralRepeatOccurrenceCounts: number[] = [];
  const preDoneFrameGenericRepeatOccurrenceCounts: number[] = [];
  const frameRecoveryOverlapOccurrenceCounts: number[] = [];

  const recordMarkdownFrameMetrics = async () => {
    if (
      streamPayload !== 'markdown' &&
      streamPayload !== 'markdown-stall' &&
      streamPayload !== 'markdown-blank-tail' &&
      !isMarkdownTablePayload(streamPayload) &&
      !isReasoningScrollbackPayload(streamPayload) &&
      !isMarkdownOpenFenceStallPayload(streamPayload) &&
      !isMarkdownStructuralRepeatStallPayload(streamPayload) &&
      !isMarkdownGenericRepeatStallPayload(streamPayload) &&
      !isRecoveryOverlapPayload(streamPayload)
    ) {
      return;
    }

    const screen = await terminal.getScreenText();
    const viewport = await terminal.getViewportText();
    const blankRun = maxConsecutiveBlankLines(viewport);
    frameBlankRuns.push(blankRun);
    if (!terminal.getOutput().includes(STREAM_DONE)) {
      preDoneFrameBlankRuns.push(blankRun);
    }
    frameHiddenMarkerCounts.push(
      countPattern(screen, /\.\.\. first \d+ lines hidden \.\.\./g),
    );
    frameRawMermaidFenceCounts.push(countOccurrences(screen, '```mermaid'));
    if (
      streamPayload === 'markdown-stall' ||
      streamPayload === 'markdown-blank-tail'
    ) {
      frameStallSentinelOccurrenceCounts.push(countStallSentinels(screen));
      if (terminal.getOutput().includes(STREAM_DONE)) {
        const viewport = await terminal.getViewportText();
        postDoneViewportStallSentinelOccurrenceCounts.push(
          countStallSentinels(viewport),
        );
      }
    }
    if (isMarkdownTablePayload(streamPayload)) {
      const tableSentinelCount = countTableSentinels(screen);
      frameTableSentinelOccurrenceCounts.push(tableSentinelCount);
      if (!terminal.getOutput().includes(STREAM_DONE)) {
        preDoneFrameTableSentinelOccurrenceCounts.push(tableSentinelCount);
      }
    }
    if (isReasoningScrollbackPayload(streamPayload)) {
      frameReasoningSentinelOccurrenceCounts.push(
        countReasoningSentinels(screen),
      );
    }
    if (
      isMarkdownOpenFenceStallPayload(streamPayload) &&
      !terminal.getOutput().includes(STREAM_DONE)
    ) {
      preDoneFrameOpenFenceSentinelOccurrenceCounts.push(
        countOpenFenceSentinels(screen),
      );
    }
    if (
      isMarkdownStructuralRepeatStallPayload(streamPayload) &&
      !terminal.getOutput().includes(STREAM_DONE)
    ) {
      preDoneFrameStructuralRepeatOccurrenceCounts.push(
        countStructuralRepeatSentinels(screen),
      );
    }
    if (
      isMarkdownGenericRepeatStallPayload(streamPayload) &&
      !terminal.getOutput().includes(STREAM_DONE)
    ) {
      preDoneFrameGenericRepeatOccurrenceCounts.push(
        countGenericRepeatSentinels(screen),
      );
    }
    if (isRecoveryOverlapPayload(streamPayload)) {
      frameRecoveryOverlapOccurrenceCounts.push(
        countRecoveryOverlapSentinels(screen),
      );
    }
  };

  try {
    await terminal.spawn('node', qwenArgs(fakeServer.baseUrl));
    terminal.startAutoFlush(LIVE_FLUSH_INTERVAL_MS);
    await terminal.waitFor('Type your message', { timeout: 30000 });
    frames.push(await terminal.capture('00-ready.png'));
    await terminal.type('Run the deterministic streaming clear-storm test.');
    frames.push(await terminal.capture('01-prompt-entered.png'));

    const rawBefore = terminal.getRawOutput().length;
    await terminal.type('\n');

    let resizeIndex = 0;
    for (let index = 0; index < frameCount; index += 1) {
      if (
        streamingResizeCols.length > 0 &&
        index % streamingResizeEveryFrames === 0
      ) {
        const cols =
          streamingResizeCols[resizeIndex % streamingResizeCols.length]!;
        await terminal.resize(cols, terminalRows);
        resizeIndex += 1;
      }

      await sleep(FRAME_INTERVAL_MS);
      const filename = `02-stream-${String(index + 1).padStart(2, '0')}.png`;
      frames.push(await terminal.capture(filename));
      await recordMarkdownFrameMetrics();
    }

    await terminal.idle(3000, 90000);
    await terminal.stopAutoFlush();
    frames.push(await terminal.capture('03-final.png'));

    const finalScreen = await terminal.getScreenText();
    const finalViewport = await terminal.getViewportText();
    const raw = terminal.getRawOutput();
    const streamDelta = raw.slice(rawBefore);
    const counts = captureCounts(streamDelta);
    const hiddenMarkerCount = countPattern(
      finalScreen,
      /\.\.\. first \d+ lines hidden \.\.\./g,
    );
    const rawMermaidFenceCount = countOccurrences(finalScreen, '```mermaid');
    const maxFrameHiddenMarkerCount = Math.max(0, ...frameHiddenMarkerCounts);
    const maxFrameRawMermaidFenceCount = Math.max(
      0,
      ...frameRawMermaidFenceCounts,
    );
    const maxFrameBlankRun = Math.max(0, ...frameBlankRuns);
    const maxPreDoneFrameBlankRun = Math.max(0, ...preDoneFrameBlankRuns);
    const finalScreenBlankRun = maxConsecutiveBlankLines(finalScreen);
    const finalViewportBlankRun = maxConsecutiveBlankLines(finalViewport);
    const stallSentinelExpectedCount =
      streamPayload === 'markdown-stall' ||
      streamPayload === 'markdown-blank-tail'
        ? STALL_SENTINELS.length
        : 0;
    const stallSentinelOccurrenceCount =
      streamPayload === 'markdown-stall' ||
      streamPayload === 'markdown-blank-tail'
        ? countStallSentinels(finalScreen)
        : 0;
    const maxFrameStallSentinelOccurrenceCount = Math.max(
      0,
      ...frameStallSentinelOccurrenceCounts,
    );
    const stallSentinelAmplificationRatio = amplificationRatio(
      stallSentinelOccurrenceCount,
      stallSentinelExpectedCount,
    );
    const maxFrameStallSentinelAmplificationRatio = amplificationRatio(
      maxFrameStallSentinelOccurrenceCount,
      stallSentinelExpectedCount,
    );
    const minPostDoneViewportStallSentinelOccurrenceCount =
      postDoneViewportStallSentinelOccurrenceCounts.length > 0
        ? Math.min(...postDoneViewportStallSentinelOccurrenceCounts)
        : null;
    const tableSentinelExpectedCount = isMarkdownTablePayload(streamPayload)
      ? TABLE_SENTINELS.length
      : 0;
    const tableSentinelOccurrenceCount = isMarkdownTablePayload(streamPayload)
      ? countTableSentinels(finalScreen)
      : 0;
    const maxFrameTableSentinelOccurrenceCount = Math.max(
      0,
      ...frameTableSentinelOccurrenceCounts,
    );
    const maxPreDoneFrameTableSentinelOccurrenceCount = Math.max(
      0,
      ...preDoneFrameTableSentinelOccurrenceCounts,
    );
    const tableSentinelAmplificationRatio = amplificationRatio(
      tableSentinelOccurrenceCount,
      tableSentinelExpectedCount,
    );
    const maxFrameTableSentinelAmplificationRatio = amplificationRatio(
      maxFrameTableSentinelOccurrenceCount,
      tableSentinelExpectedCount,
    );
    const maxPreDoneFrameTableSentinelAmplificationRatio = amplificationRatio(
      maxPreDoneFrameTableSentinelOccurrenceCount,
      tableSentinelExpectedCount,
    );
    const reasoningSentinelExpectedCount = isReasoningScrollbackPayload(
      streamPayload,
    )
      ? REASONING_SENTINELS.length
      : 0;
    const reasoningSentinelOccurrenceCount = isReasoningScrollbackPayload(
      streamPayload,
    )
      ? countReasoningSentinels(finalScreen)
      : 0;
    const maxFrameReasoningSentinelOccurrenceCount = Math.max(
      0,
      ...frameReasoningSentinelOccurrenceCounts,
    );
    const reasoningSentinelAmplificationRatio = amplificationRatio(
      reasoningSentinelOccurrenceCount,
      reasoningSentinelExpectedCount,
    );
    const maxFrameReasoningSentinelAmplificationRatio = amplificationRatio(
      maxFrameReasoningSentinelOccurrenceCount,
      reasoningSentinelExpectedCount,
    );
    const openFenceSentinelExpectedCount = isMarkdownOpenFenceStallPayload(
      streamPayload,
    )
      ? OPEN_FENCE_SENTINELS.length
      : 0;
    const openFenceSentinelOccurrenceCount = isMarkdownOpenFenceStallPayload(
      streamPayload,
    )
      ? countOpenFenceSentinels(finalScreen)
      : 0;
    const maxPreDoneFrameOpenFenceSentinelOccurrenceCount = Math.max(
      0,
      ...preDoneFrameOpenFenceSentinelOccurrenceCounts,
    );
    const openFenceLivePreviewSeen =
      !isMarkdownOpenFenceStallPayload(streamPayload) ||
      maxPreDoneFrameOpenFenceSentinelOccurrenceCount > 0;
    const openFenceSentinelAmplificationRatio = amplificationRatio(
      openFenceSentinelOccurrenceCount,
      openFenceSentinelExpectedCount,
    );
    const maxPreDoneFrameOpenFenceSentinelAmplificationRatio =
      amplificationRatio(
        maxPreDoneFrameOpenFenceSentinelOccurrenceCount,
        openFenceSentinelExpectedCount,
      );
    const structuralRepeatExpectedPreDoneCount =
      isMarkdownStructuralRepeatStallPayload(streamPayload)
        ? STRUCTURAL_REPEAT_SENTINELS.length
        : 0;
    const structuralRepeatOccurrenceCount =
      isMarkdownStructuralRepeatStallPayload(streamPayload)
        ? countStructuralRepeatSentinels(finalScreen)
        : 0;
    const maxPreDoneFrameStructuralRepeatOccurrenceCount = Math.max(
      0,
      ...preDoneFrameStructuralRepeatOccurrenceCounts,
    );
    const structuralRepeatAmplificationRatio = amplificationRatio(
      structuralRepeatOccurrenceCount,
      structuralRepeatExpectedPreDoneCount,
    );
    const maxPreDoneFrameStructuralRepeatAmplificationRatio =
      amplificationRatio(
        maxPreDoneFrameStructuralRepeatOccurrenceCount,
        structuralRepeatExpectedPreDoneCount,
      );
    const genericRepeatExpectedPreDoneCount =
      isMarkdownGenericRepeatStallPayload(streamPayload)
        ? MAX_PENDING_PREVIEW_REPEAT_LINES
        : 0;
    const genericRepeatOccurrenceCount = isMarkdownGenericRepeatStallPayload(
      streamPayload,
    )
      ? countGenericRepeatSentinels(finalScreen)
      : 0;
    const maxPreDoneFrameGenericRepeatOccurrenceCount = Math.max(
      0,
      ...preDoneFrameGenericRepeatOccurrenceCounts,
    );
    const genericRepeatAmplificationRatio = amplificationRatio(
      genericRepeatOccurrenceCount,
      genericRepeatExpectedPreDoneCount,
    );
    const maxPreDoneFrameGenericRepeatAmplificationRatio = amplificationRatio(
      maxPreDoneFrameGenericRepeatOccurrenceCount,
      genericRepeatExpectedPreDoneCount,
    );
    const recoveryOverlapExpectedCount = isRecoveryOverlapPayload(streamPayload)
      ? 1
      : 0;
    const recoveryOverlapOccurrenceCount = isRecoveryOverlapPayload(
      streamPayload,
    )
      ? countRecoveryOverlapSentinels(finalScreen)
      : 0;
    const maxFrameRecoveryOverlapOccurrenceCount = Math.max(
      0,
      ...frameRecoveryOverlapOccurrenceCounts,
    );
    const recoveryOverlapAmplificationRatio = amplificationRatio(
      recoveryOverlapOccurrenceCount,
      recoveryOverlapExpectedCount,
    );
    const maxFrameRecoveryOverlapAmplificationRatio = amplificationRatio(
      maxFrameRecoveryOverlapOccurrenceCount,
      recoveryOverlapExpectedCount,
    );
    const gifPath = generateGif(frames, outputDir);
    const markdownPass =
      (streamPayload !== 'markdown' && streamPayload !== 'markdown-stall') ||
      (hiddenMarkerCount === 0 &&
        rawMermaidFenceCount === 0 &&
        maxFrameHiddenMarkerCount === 0 &&
        maxFrameRawMermaidFenceCount === 0);
    const markdownStallPass =
      (streamPayload !== 'markdown-stall' &&
        streamPayload !== 'markdown-blank-tail') ||
      (stallSentinelOccurrenceCount <= stallSentinelExpectedCount &&
        maxFrameStallSentinelOccurrenceCount <= stallSentinelExpectedCount);
    const markdownBlankTailPass =
      streamPayload !== 'markdown-blank-tail' ||
      (minPostDoneViewportStallSentinelOccurrenceCount !== null &&
        minPostDoneViewportStallSentinelOccurrenceCount > 0);
    const markdownTablePass =
      !isMarkdownTablePayload(streamPayload) ||
      (tableSentinelOccurrenceCount <= tableSentinelExpectedCount &&
        maxFrameTableSentinelOccurrenceCount <= tableSentinelExpectedCount &&
        (streamPayload !== 'markdown-table-stall' ||
          maxPreDoneFrameTableSentinelOccurrenceCount <=
            tableSentinelExpectedCount));
    const reasoningScrollbackPass =
      !isReasoningScrollbackPayload(streamPayload) ||
      (reasoningSentinelOccurrenceCount === 0 &&
        maxFrameReasoningSentinelOccurrenceCount === 0);
    const markdownOpenFenceStallPass =
      !isMarkdownOpenFenceStallPayload(streamPayload) ||
      (openFenceLivePreviewSeen &&
        maxPreDoneFrameOpenFenceSentinelOccurrenceCount <=
          openFenceSentinelExpectedCount);
    const markdownStructuralRepeatStallPass =
      !isMarkdownStructuralRepeatStallPayload(streamPayload) ||
      maxPreDoneFrameStructuralRepeatOccurrenceCount <=
        structuralRepeatExpectedPreDoneCount;
    const markdownGenericRepeatStallPass =
      !isMarkdownGenericRepeatStallPayload(streamPayload) ||
      (genericRepeatOccurrenceCount <= genericRepeatExpectedPreDoneCount &&
        maxPreDoneFrameGenericRepeatOccurrenceCount <=
          genericRepeatExpectedPreDoneCount);
    const recoveryOverlapPass =
      !isRecoveryOverlapPayload(streamPayload) ||
      (recoveryOverlapOccurrenceCount === recoveryOverlapExpectedCount &&
        maxFrameRecoveryOverlapOccurrenceCount <= recoveryOverlapExpectedCount);
    const pass =
      counts.clearTerminalPairCount >= minClearTerminalPairs &&
      counts.clearTerminalPairCount <= maxClearTerminalPairs &&
      frames.length >= minFrames &&
      countOccurrences(finalScreen, STREAM_DONE) === 1 &&
      markdownPass &&
      markdownStallPass &&
      markdownBlankTailPass &&
      markdownTablePass &&
      reasoningScrollbackPass &&
      markdownOpenFenceStallPass &&
      markdownStructuralRepeatStallPass &&
      markdownGenericRepeatStallPass &&
      recoveryOverlapPass;

    const summary: Summary = {
      repoRoot,
      outputDir,
      gifPath,
      streamPayload,
      framesCaptured: frames.length,
      rawBytes: raw.length,
      streamDeltaBytes: streamDelta.length,
      ...counts,
      finalScreenLines: finalScreen.split('\n').length,
      finalDoneCount: countOccurrences(finalScreen, STREAM_DONE),
      requestCount: fakeServer.getRequestCount(),
      hiddenMarkerCount,
      rawMermaidFenceCount,
      maxFrameHiddenMarkerCount,
      maxFrameRawMermaidFenceCount,
      maxFrameBlankRun,
      maxPreDoneFrameBlankRun,
      finalScreenBlankRun,
      finalViewportBlankRun,
      stallSentinelExpectedCount,
      stallSentinelOccurrenceCount,
      maxFrameStallSentinelOccurrenceCount,
      stallSentinelAmplificationRatio,
      maxFrameStallSentinelAmplificationRatio,
      minPostDoneViewportStallSentinelOccurrenceCount,
      tableSentinelExpectedCount,
      tableSentinelOccurrenceCount,
      maxFrameTableSentinelOccurrenceCount,
      maxPreDoneFrameTableSentinelOccurrenceCount,
      tableSentinelAmplificationRatio,
      maxFrameTableSentinelAmplificationRatio,
      maxPreDoneFrameTableSentinelAmplificationRatio,
      reasoningSentinelExpectedCount,
      reasoningSentinelOccurrenceCount,
      maxFrameReasoningSentinelOccurrenceCount,
      reasoningSentinelAmplificationRatio,
      maxFrameReasoningSentinelAmplificationRatio,
      openFenceSentinelExpectedCount,
      openFenceSentinelOccurrenceCount,
      maxPreDoneFrameOpenFenceSentinelOccurrenceCount,
      openFenceLivePreviewSeen,
      openFenceSentinelAmplificationRatio,
      maxPreDoneFrameOpenFenceSentinelAmplificationRatio,
      structuralRepeatExpectedPreDoneCount,
      structuralRepeatOccurrenceCount,
      maxPreDoneFrameStructuralRepeatOccurrenceCount,
      structuralRepeatAmplificationRatio,
      maxPreDoneFrameStructuralRepeatAmplificationRatio,
      genericRepeatExpectedPreDoneCount,
      genericRepeatOccurrenceCount,
      maxPreDoneFrameGenericRepeatOccurrenceCount,
      genericRepeatAmplificationRatio,
      maxPreDoneFrameGenericRepeatAmplificationRatio,
      recoveryOverlapExpectedCount,
      recoveryOverlapOccurrenceCount,
      maxFrameRecoveryOverlapOccurrenceCount,
      recoveryOverlapAmplificationRatio,
      maxFrameRecoveryOverlapAmplificationRatio,
      terminal: {
        cols: terminalCols,
        rows: terminalRows,
        resizeCols: streamingResizeCols,
      },
      limits: {
        minClearTerminalPairs,
        maxClearTerminalPairs: serializeNumberLimit(maxClearTerminalPairs),
        minFrames,
      },
      pass,
    };

    writeFileSync(
      join(outputDir, 'summary.json'),
      JSON.stringify(summary, null, 2),
    );
    writeFileSync(join(outputDir, 'final.screen.txt'), finalScreen);
    writeFileSync(join(outputDir, 'stream.raw.ansi.log'), streamDelta);

    console.log(JSON.stringify(summary, null, 2));

    if (!pass) {
      process.exitCode = 1;
    }
  } finally {
    await terminal.close();
    await fakeServer.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
