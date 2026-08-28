/* eslint-disable react/no-unknown-property */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/** @jsxImportSource @opentui/react */

/**
 * Shared message-rendering helpers for the OpenTUI backend, aligned with the
 * original ink rendering semantics (packages/cli/src/ui/components/
 * HistoryItemDisplay.tsx → UserMessage / AssistantMessage / ThinkMessage /
 * ToolMessage). The ink components render:
 *
 *  - user turns as `> text` in theme.text.accent;
 *  - assistant turns behind a `◆` (ICON.DIAMOND) accent prefix with a
 *    markdown body;
 *  - thinking turns as dim-italic `∵`/`∴` (BECAUSE/THEREFORE) lines that
 *    collapse to a one-line hint when done;
 *  - tool turns with a fixed-width TOOL_STATUS glyph (✓/o/⊷/?/-/x) colored by
 *    status, a bold tool name and a dim description, result below.
 *
 * The pure `*-Meta` helpers below compute the exact glyph/color/label the ink
 * components produce so they can be unit-tested; TodoRows and AnsiRows are
 * the shared sub-renderers the backend's tool cards embed.
 */

import { C } from './theme.js';
import { TOOL_DISPLAY_BY_NAME } from '../utils/tool-display-map.js';
import { ICON } from '../constants.js';
import {
  getCachedStringWidth,
  sanitizeMultilineForDisplay,
  toCodePoints,
} from '../utils/textUtils.js';
import { formatMemoryUsage } from '../utils/formatters.js';
import type { AnsiToken } from '@qwen-code/qwen-code-core';
import type { LiveToolItem } from './live-session-model.js';
import type { TodoItem } from '../components/TodoDisplay.js';

/** The original TOOL_STATUS glyphs (ui/constants.ts). */
export const TOOL_STATUS = {
  SUCCESS: '✓',
  PENDING: 'o',
  EXECUTING: '⊷',
  CONFIRMING: '?',
  CANCELED: '-',
  ERROR: 'x',
} as const;

/** The original narrow-presentation icons (ui/constants.ts). */
export const MESSAGE_ICON = {
  DIAMOND: '◆',
  THEREFORE: '∴',
  BECAUSE: '∵',
  CIRCLE_FILLED: '●',
} as const;

/** Width the ink ToolStatusIndicator reserves for the glyph column. */
export const STATUS_INDICATOR_WIDTH = 2;

/**
 * Theme-aware mouse-selection colors. OpenTUI's default invert fallback
 * (selection bg = cell fg, fg = black) is unreadable on light themes, so
 * every selectable text/code renderable gets explicit colors.
 */
export const selectionProps = () => ({
  selectionBg: C.selectionBg,
  selectionFg: C.selectionFg,
});

/** TextAttributes bitmask (1 << 7) for the canceled strikethrough. */
const STRIKETHROUGH_ATTR = 128;

/** ink TodoDisplay STATUS_ICONS (components/TodoDisplay.tsx). */
const TODO_STATUS_ICONS = {
  pending: ICON.CIRCLE_EMPTY,
  in_progress: ICON.CIRCLE_LEFT_HALF,
  completed: ICON.CIRCLE_FILLED,
} as const;

/** ink ToolMessage MAXIMUM_RESULT_DISPLAY_CHARACTERS. */
export const MAX_RESULT_DISPLAY_CHARACTERS = 1000000;

/** ink AppContainer staticAreaMaxItemHeight: max(terminalHeight * 4, 100). */
export function maxHistoryItemRows(terminalHeight: number): number {
  return Math.max(Math.floor(terminalHeight) * 4, 100);
}

/** ink StringResultRenderer: over-long results keep the trailing content. */
export function truncateResultDisplayChars(text: string): string {
  return text.length > MAX_RESULT_DISPLAY_CHARACTERS
    ? '...' + text.slice(-MAX_RESULT_DISPLAY_CHARACTERS)
    : text;
}

export interface TailWindow<T> {
  visible: readonly T[];
  hiddenCount: number;
}

/**
 * ink MaxSizedBox (overflowDirection 'top') parity: an item taller than
 * `maxRows` keeps its LAST maxRows-1 rows; the hidden head is summarized by
 * a `... first N lines hidden ...` indicator (hiddenLinesLabel).
 */
export function tailWindow<T>(
  lines: readonly T[],
  maxRows: number,
): TailWindow<T> {
  const target = Math.max(Math.round(maxRows), 2);
  if (lines.length <= target) return { visible: lines, hiddenCount: 0 };
  const visibleContentHeight = target - 1;
  return {
    visible: lines.slice(lines.length - visibleContentHeight),
    hiddenCount: lines.length - visibleContentHeight,
  };
}

/** ink MaxSizedBox hidden-lines indicator text. */
export function hiddenLinesLabel(hiddenCount: number): string {
  return `... first ${hiddenCount} line${hiddenCount === 1 ? '' : 's'} hidden ...`;
}

/**
 * Tool-card naming/status parity with the original ToolMessage: a card line
 * is `{glyph} {DisplayName} {description}`, where the display name comes
 * from the shared internal-name → display-name map
 * (`run_shell_command` → `Shell`, ui/utils/tool-display-map.ts) and the
 * description reproduces the tool invocation's own `getDescription()` — a
 * shell card renders `echo PARITY-OK (Echo PARITY-OK)`. The status glyph
 * alone carries the outcome; the original appends no `· ok` / `· skipped`
 * suffix, so generic summaries are suppressed (custom ones like a line
 * count stay).
 */
export function toolCardName(rawName: string): string {
  return TOOL_DISPLAY_BY_NAME[rawName] ?? rawName;
}

/** Tool summaries that carry no information beyond the status glyph. */
export const GENERIC_TOOL_SUMMARIES: ReadonlySet<string> = new Set([
  'ok',
  'error',
  'cancelled',
  'canceled',
  'interrupted',
  'skipped',
]);

export function toolCardSummarySuffix(
  done: boolean,
  summary: string | undefined,
): string {
  if (!done || !summary || GENERIC_TOOL_SUMMARIES.has(summary)) return '';
  return ` · ${summary}`;
}

/**
 * Reconstructs the invocation description from the tool-call args for
 * streams that carry no scheduler invocation (scripted/demo replay): parity
 * of the common getDescription() shapes for the built-in tools. Live
 * sessions instead carry the real description (tool-description event) and
 * never read this fallback.
 */
/** One-line, sanitized card text: fold newlines, then neutralize ANSI
 * sequences and bare control bytes (model-controlled args must not reach
 * the terminal raw). */
export function toolCardText(v: string): string {
  return sanitizeMultilineForDisplay(v.replace(/\s*\n\s*/g, ' ').trim());
}

export function toolCardDescription(rawName: string, args?: string): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(args ?? '{}') as Record<string, unknown>;
  } catch {
    return '';
  }
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const oneLine = toolCardText;
  switch (rawName) {
    case 'run_shell_command': {
      const cmd = str(parsed['command'] ?? parsed['cmd']);
      if (!cmd) return '';
      const desc = str(parsed['description']);
      return desc ? `${oneLine(cmd)} (${oneLine(desc)})` : oneLine(cmd);
    }
    case 'read_file':
    case 'write_file':
    case 'edit':
    case 'notebook_edit': {
      const p = str(
        parsed['file_path'] ?? parsed['path'] ?? parsed['filePath'],
      );
      return p ? oneLine(p) : '';
    }
    case 'list_directory':
    case 'glob': {
      const p = str(parsed['path'] ?? parsed['dir'] ?? parsed['pattern']);
      return p ? oneLine(p) : '';
    }
    case 'grep_search': {
      const pat = str(parsed['pattern']);
      return pat ? oneLine(pat) : '';
    }
    default:
      return '';
  }
}

export function userMessageMeta(): { glyph: string; color: string } {
  // UserMessage → PrefixedTextMessage with theme.text.accent (purple).
  return { glyph: '>', color: C.purple };
}

export function assistantMessageMeta(): { glyph: string; color: string } {
  // AssistantMessage → ICON.DIAMOND prefix, theme.text.accent.
  return { glyph: MESSAGE_ICON.DIAMOND, color: C.purple };
}

export interface ThinkingMeta {
  icon: string;
  label: string;
  /** Collapsed hint suffix; empty when the block is expanded. */
  hint: string;
  color: string;
  collapsed: boolean;
}

/**
 * ThinkMessage semantics: a live thought shows `∵ Thinking…`, a committed
 * thought collapses to `∴ Thought for … (… to expand)` unless expanded. The
 * click hint mirrors the VP-mode "click or ctrl+o" affordance.
 */
export function thinkingMeta(
  done: boolean,
  expanded: boolean,
  clickable: boolean,
): ThinkingMeta {
  const expandHint = clickable
    ? '(click or ctrl+o to expand)'
    : '(ctrl+o to expand)';
  if (!done) {
    return {
      icon: MESSAGE_ICON.BECAUSE,
      label: 'Thinking…',
      hint: '',
      color: C.dim,
      collapsed: false,
    };
  }
  if (!expanded) {
    return {
      icon: MESSAGE_ICON.THEREFORE,
      label: 'Thought',
      hint: expandHint,
      color: C.dim,
      collapsed: true,
    };
  }
  return {
    icon: MESSAGE_ICON.THEREFORE,
    label: 'Thought',
    hint: '(ctrl+o to collapse)',
    color: C.dim,
    collapsed: false,
  };
}

export interface ToolStatusMeta {
  glyph: string;
  color: string;
  /** Ink renders the tool name struck through when canceled. */
  strikethrough: boolean;
}

/**
 * ToolStatusIndicator + ToolInfo semantics for one live tool item: pending
 * `o` (green), executing `⊷`, success `✓` (green), confirming `?`, canceled
 * `-`, error `x` (red).
 */
export function toolStatusMeta(item: LiveToolItem): ToolStatusMeta {
  if (item.confirm === 'pending' && !item.done) {
    return {
      glyph: TOOL_STATUS.CONFIRMING,
      color: C.yellow,
      strikethrough: false,
    };
  }
  if (!item.done) {
    return {
      glyph: TOOL_STATUS.EXECUTING,
      color: C.text,
      strikethrough: false,
    };
  }
  if (item.success) {
    return { glyph: TOOL_STATUS.SUCCESS, color: C.green, strikethrough: false };
  }
  const canceled =
    item.summary === 'interrupted' || item.summary === 'canceled';
  if (canceled) {
    return { glyph: TOOL_STATUS.CANCELED, color: C.text, strikethrough: true };
  }
  return { glyph: TOOL_STATUS.ERROR, color: C.red, strikethrough: false };
}

/**
 * ink TodoDisplay parity: status-icon column (width 3) + content column.
 * Completed rows render Foreground struck through, in_progress AccentGreen,
 * pending Foreground — the same color for icon and text.
 */
export function TodoRows({ todos }: { todos: readonly TodoItem[] }) {
  if (todos.length === 0) {
    return null;
  }
  return (
    <box flexDirection="column">
      {todos.map((todo) => (
        <TodoItemRow key={todo.id} todo={todo} />
      ))}
    </box>
  );
}

function TodoItemRow({ todo }: { todo: TodoItem }) {
  const statusIcon = TODO_STATUS_ICONS[todo.status];
  const isCompleted = todo.status === 'completed';
  const isInProgress = todo.status === 'in_progress';
  const itemColor = isCompleted ? C.text : isInProgress ? C.green : C.text;
  return (
    <box flexDirection="row" minHeight={1}>
      <box width={3}>
        <text fg={itemColor} {...selectionProps()}>
          {statusIcon}
        </text>
      </box>
      <box flexGrow={1}>
        <text
          fg={itemColor}
          attributes={isCompleted ? STRIKETHROUGH_ATTR : 0}
          {...selectionProps()}
        >
          {todo.content}
        </text>
      </box>
    </box>
  );
}

/** ink AnsiOutput DEFAULT_HEIGHT (components/AnsiOutput.tsx). */
const ANSI_DEFAULT_HEIGHT = 24;

/**
 * Line-level truncate (ink Text wrap="truncate" parity — a hard cut, no
 * ellipsis): walks tokens left-to-right keeping whole code points until the
 * visual width budget is spent.
 */
export function truncateTokenLine(
  line: readonly AnsiToken[],
  maxWidth: number,
): AnsiToken[] {
  if (maxWidth <= 0) return [];
  let width = 0;
  const kept: AnsiToken[] = [];
  for (const token of line) {
    const tokenWidth = getCachedStringWidth(token.text);
    if (width + tokenWidth <= maxWidth) {
      if (tokenWidth > 0 || kept.length === 0) kept.push(token);
      width += tokenWidth;
      continue;
    }
    let partial = '';
    for (const cp of toCodePoints(token.text)) {
      const cpWidth = getCachedStringWidth(cp);
      if (width + cpWidth > maxWidth) break;
      partial += cp;
      width += cpWidth;
    }
    if (partial) kept.push({ ...token, text: partial });
    break;
  }
  return kept;
}

/** ink AnsiToken → opentui text props (BOLD=1 | DIM=2 | ITALIC=4 | UNDERLINE=8). */
function ansiTokenProps(token: AnsiToken): {
  fg: string | undefined;
  bg: string | undefined;
  attributes: number;
} {
  const fg = token.inverse ? token.bg : token.fg;
  const bg = token.inverse ? token.fg : token.bg;
  return {
    fg: fg || undefined,
    bg: bg || undefined,
    attributes:
      (token.bold ? 1 : 0) |
      (token.dim ? 2 : 0) |
      (token.italic ? 4 : 0) |
      (token.underline ? 8 : 0),
  };
}

/**
 * ink AnsiOutputText + ShellStatsBar parity: keeps the trailing 24 lines of
 * the token grid, truncates each line to `maxWidth`, and appends the
 * "+N lines / KB" stats bar when the shell output exceeded the window.
 */
export function AnsiRows({
  grid,
  maxWidth,
  totalLines,
  totalBytes,
}: {
  grid: ReadonlyArray<readonly AnsiToken[]>;
  maxWidth: number;
  totalLines?: number;
  totalBytes?: number;
}) {
  const windowed = tailWindow(grid, ANSI_DEFAULT_HEIGHT);
  const stats: string[] = [];
  if (totalLines && totalLines > ANSI_DEFAULT_HEIGHT) {
    stats.push(`+${totalLines - ANSI_DEFAULT_HEIGHT} lines`);
  }
  if (totalBytes && totalBytes > 0) {
    stats.push(formatMemoryUsage(totalBytes));
  }
  return (
    <box flexDirection="column">
      {windowed.hiddenCount > 0 && (
        <text fg={C.dim} {...selectionProps()}>
          {hiddenLinesLabel(windowed.hiddenCount)}
        </text>
      )}
      {windowed.visible.map((line, i) => (
        <box key={`${i}`} flexDirection="row">
          {truncateTokenLine(line, maxWidth).map((token, j) => {
            const style = ansiTokenProps(token);
            return (
              <text
                key={`${j}`}
                fg={style.fg ?? C.text}
                bg={style.bg}
                attributes={style.attributes}
                {...selectionProps()}
              >
                {token.text}
              </text>
            );
          })}
        </box>
      ))}
      {stats.length > 0 && (
        <box flexDirection="row">
          {stats.map((part, i) => (
            <box key={`${i}`} flexDirection="row">
              {i > 0 && <text> </text>}
              <text fg={C.dim} {...selectionProps()}>
                {part}
              </text>
            </box>
          ))}
        </box>
      )}
    </box>
  );
}
