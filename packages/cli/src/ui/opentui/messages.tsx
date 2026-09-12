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
import { ICON, TOOL_STATUS } from '../constants.js';
import {
  getCachedStringWidth,
  sanitizeMultilineForDisplay,
  sanitizeTerminalText,
  toCodePoints,
} from '../utils/textUtils.js';
import { formatMemoryUsage } from '../utils/formatters.js';
import { formatDuration } from '../utils/displayUtils.js';
import type { AnsiToken } from '@qwen-code/qwen-code-core';
import type { LiveToolItem } from './live-session-model.js';
import type { TodoItem } from '../components/TodoDisplay.js';

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

/** Physical rows a logical row occupies when soft-wrapped to `cols` columns. */
function physicalRowCount(row: string, cols: number): number {
  return Math.max(1, Math.ceil(getCachedStringWidth(row) / cols));
}

/** Cuts a row to `maxCols` display columns without splitting a surrogate pair. */
function sliceRowToWidth(
  row: string,
  maxCols: number,
  side: 'head' | 'tail',
): string {
  const points = toCodePoints(row);
  const ordered = side === 'head' ? points : [...points].reverse();
  let used = 0;
  let taken = 0;
  for (const cp of ordered) {
    const cpWidth = getCachedStringWidth(cp);
    if (used + cpWidth > maxCols) break;
    used += cpWidth;
    taken += 1;
  }
  const kept = ordered.slice(0, taken);
  return (side === 'tail' ? kept.reverse() : kept).join('');
}

/**
 * Physical-height head window (ink MaxSizedBox overflowDirection 'bottom'
 * parity): the cap counts WRAPPED rows at width - 2 display columns (not
 * UTF-16 code units — wide-character bodies would otherwise be undercounted
 * ~2x and silently never engage the cap), because a
 * single logical row — e.g. a JSON.stringify'd confirmation payload — can
 * wrap to dozens of physical rows that a logical-row window never bounds.
 * An over-budget tail logical row is sliced to its head display columns; the
 * hidden tail is summarized by hiddenTailLinesLabel.
 */
export function headWindowPhysical(
  rows: readonly string[],
  width: number,
  maxRows: number,
): { visible: string[]; hiddenRows: number } {
  const cols = Math.max(width - 2, 10);
  const height = (row: string) => physicalRowCount(row, cols);
  const total = rows.reduce((sum, row) => sum + height(row), 0);
  if (total <= maxRows) return { visible: [...rows], hiddenRows: 0 };
  const budget = Math.max(maxRows - 1, 1);
  const visible: string[] = [];
  let used = 0;
  for (const row of rows) {
    const h = height(row);
    if (used + h <= budget) {
      visible.push(row);
      used += h;
      continue;
    }
    const remaining = budget - used;
    if (remaining > 0) {
      visible.push(sliceRowToWidth(row, remaining * cols, 'head'));
      used = budget;
    }
    break;
  }
  return { visible, hiddenRows: Math.max(total - used, 1) };
}

/** ink MaxSizedBox bottom-overflow hidden-tail indicator text. */
export function hiddenTailLinesLabel(hiddenCount: number): string {
  return `... last ${hiddenCount} line${hiddenCount === 1 ? '' : 's'} hidden ...`;
}

/**
 * Physical-height tail window — the expand-side mirror of headWindowPhysical:
 * keeps the LAST rows whose wrapped height fits the budget, slicing an
 * over-budget head logical row to its tail characters. OpenTUI paints a
 * fixed alt-screen viewport, so an expanded dialog body taller than the
 * screen must surface its tail (where the content ends) instead of letting
 * the screen clip it away.
 */
export function tailWindowPhysical(
  rows: readonly string[],
  width: number,
  maxRows: number,
): { visible: string[]; hiddenRows: number } {
  const cols = Math.max(width - 2, 10);
  const height = (row: string) => physicalRowCount(row, cols);
  const total = rows.reduce((sum, row) => sum + height(row), 0);
  if (total <= maxRows) return { visible: [...rows], hiddenRows: 0 };
  const budget = Math.max(maxRows, 1);
  const visible: string[] = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const h = height(row);
    if (used + h <= budget) {
      visible.unshift(row);
      used += h;
      continue;
    }
    const remaining = budget - used;
    if (remaining > 0) {
      visible.unshift(sliceRowToWidth(row, remaining * cols, 'tail'));
      used = budget;
    }
    break;
  }
  return { visible, hiddenRows: Math.max(total - used, 1) };
}

/**
 * Row budget for a tool card's inline description. Ink bounds an over-tall
 * card through the static-area height distribution (MaxSizedBox); OpenTUI
 * caps the description head here until that distribution exists — without it
 * an MCP tool's whole args JSON (one logical row wrapping to dozens of
 * physical rows) floods the transcript column.
 */
export const TOOL_CARD_DESCRIPTION_ROWS = 5;

/**
 * Rows reserved below a pending tool card so the confirmation dialog's
 * COLLAPSED body (frame + title/question + 20-row body + outcome list +
 * footer ≈ 36 rows) still ends inside the viewport. Excludes any payload
 * the dialog only reveals on ctrl-s expansion — that bound lives in
 * pendingCardMaxRows.
 */
export const PENDING_CARD_VIEWPORT_RESERVE_ROWS = 46;

/**
 * Rows on screen an expanded confirmation dialog never gets for its body,
 * charged to the pending card above it: the banner (≈ 6), the startup
 * notices a fresh session shows (≈ 3), the prompt echo with its turn margin
 * (2), and the card's own hidden-tail and awaiting rows (2). A session
 * without a banner or notices over-reserves. While the collapsed bound
 * binds that only shrinks a card whose payload the dialog is already
 * rendering — the safe direction; above roughly 90 rows the converted
 * empty-body bound binds instead and the over-reserve costs every pending
 * card, payload or not (R3-3).
 */
export const DIALOG_ABOVE_CARD_RESERVE_ROWS = 13;

/**
 * Rows the confirmation dialog spends around its body: the frame's border
 * and padding (4), title (1), body margins (2), question row (1), outcome
 * list (2–4), footer hint (1) ≈ 12–14. dialogs-confirm.test.tsx pins a real
 * render against exactly this share, so growing the dialog's chrome means
 * growing it here first.
 */
export const DIALOG_CHROME_RESERVE_ROWS = 14;

/**
 * Rows an expanded confirmation dialog can count on being unavailable to the
 * pending card above it — the two shares above, split so the halves sum to
 * it by construction and the chrome half can be pinned on its own. At the
 * pre-fix value of 14 the expanded tail and the outcome list ran off the
 * bottom of the screen (mem0 e2e regression).
 */
export const DIALOG_EXPANDED_RESERVE_ROWS =
  DIALOG_ABOVE_CARD_RESERVE_ROWS + DIALOG_CHROME_RESERVE_ROWS;

/**
 * The confirmation dialog's collapsed body cap. TextBody caps PAINTED rows
 * (headWindowPhysical) and offers ctrl-s expansion; DiffBody caps LOGICAL
 * diff lines (tailWindow) and offers none, so a wide-lined diff paints
 * several times this many rows.
 */
export const CONFIRMATION_BODY_MAX_ROWS = 20;

/**
 * Measured at a 110-column terminal the card's flex row gives the
 * description ~79 of the 108 columns capToolCardDescription budgets with
 * (the name column takes the rest), so a budget of B rows renders about
 * B / 0.73 rows. Budgeting at 0.7 keeps the estimate on the safe side of
 * that inflation across plausible name lengths.
 */
const CARD_DESC_WRAP_RATIO = 0.7;

/**
 * Description budget for a pending tool card, bounded three ways: never
 * past the ink-parity history cap, never so tall that the confirmation
 * dialog's collapsed body overflows the viewport, and never so tall that
 * the card plus the dialog (reserve rows and payload body) overflows it
 * either — the third bound converts those painted rows into budget rows.
 * `dialogBody` is the text the dialog
 * renders as its payload body (a hook confirmation's reason, a plan, or an
 * exec command, threaded onto the live item as `confirmBody`); it is
 * undefined for the types whose dialog carries no payload text — an mcp
 * dialog shows only the server and tool names, an edit dialog windows its
 * diff, ask_user_question runs its own flow — so those cards are charged no
 * body rows. At ordinary terminal heights that leaves them the collapsed
 * budget, which the card needs as the only surface carrying the arguments
 * (R5-9); above roughly 90 rows the converted empty-body bound is the
 * tighter one and they yield rows their dialog never paints (R3-3).
 * `pendingCount` splits both allowances across the pending siblings: one
 * dialog renders below the whole transcript, so the parked siblings share
 * the rows a lone card would get — the collapsed allowance divided so the
 * cards' sum is charged against that dialog, and the dialog bound divided
 * so the converted operand does not silently stop binding exactly where
 * the split matters (R3-1). The split is a no-op at 1, and the transcript
 * view passes 1 for the FIRST pending card: the rendered dialog belongs
 * to it (waitingToolCalls[0], pushed in transcript order), so it keeps
 * the full allowance — for an mcp call that card is the only surface
 * carrying the arguments being approved (R4-1), and the allowance rotates
 * to the next sibling as each call settles. Short terminals fall back to
 * the settled cap.
 */
export function pendingCardMaxRows(
  terminalHeight: number,
  dialogBody: string | undefined,
  width: number,
  pendingCount = 1,
): number {
  const h = Math.floor(terminalHeight);
  // Measure on the dialog's own basis: the dialog body counts WRAPPED rows
  // at the raw terminal width minus the frame's two columns
  // (headWindowPhysical), and the card's width is already four short of the
  // terminal (the transcript margins), so the body measures at width + 2 —
  // measuring at the card's own text width would engage the bound for
  // payloads the collapsed dialog still shows in full. The body keeps its
  // LFs (an exec command renders uncapped), so each physical row counts.
  const bodyRows = (
    dialogBody === undefined ? [] : sanitizeTerminalText(dialogBody).split('\n')
  ).reduce(
    (sum, row) => sum + physicalRowCount(row, Math.max(width + 2, 10)),
    0,
  );
  // The dialog bound charges reserve AND body, converted from painted rows
  // at CARD_DESC_WRAP_RATIO: a budget row paints ~1/0.7 screen rows, so an
  // unconverted operand leaves the card ~1.4x taller than the rows the
  // dialog was charged and its outcome list falls off the viewport (R1-3).
  // It applies unconditionally — gating it on the body outgrowing the
  // collapsed window made the UNCONVERTED collapsed bound the binding one
  // exactly inside that window. The sibling count divides it too: granted
  // in full to each of N parked cards the unconverted collapsed operand
  // binds instead and the split goes inert (R3-1).
  const dialogBound = Math.floor(
    ((h - DIALOG_EXPANDED_RESERVE_ROWS - bodyRows) * CARD_DESC_WRAP_RATIO) /
      pendingCount,
  );
  return Math.max(
    TOOL_CARD_DESCRIPTION_ROWS,
    Math.min(
      maxHistoryItemRows(terminalHeight),
      Math.floor((h - PENDING_CARD_VIEWPORT_RESERVE_ROWS) / pendingCount),
      dialogBound,
    ),
  );
}

/**
 * Keeps the head of a description that would wrap past `maxRows` at the
 * given width; the hidden tail is summarized by hiddenTailLinesLabel. Rows
 * are measured in terminal display columns (not UTF-16 code units) so
 * wide-character payloads engage the cap (name + description wrap inside
 * width - STATUS_INDICATOR_WIDTH columns).
 */
export function capToolCardDescription(
  description: string,
  name: string,
  width: number,
  maxRows: number,
): { description: string; hiddenRows: number } {
  const cols = Math.max(width - STATUS_INDICATOR_WIDTH, 10);
  const nameCols = getCachedStringWidth(name) + 1;
  const rows = Math.ceil((nameCols + getCachedStringWidth(description)) / cols);
  if (rows <= maxRows) return { description, hiddenRows: 0 };
  const descRows = Math.max(maxRows - 1, 1);
  const visibleCols = Math.max(descRows * cols - nameCols, 0);
  return {
    description: sliceRowToWidth(description, visibleCols, 'head'),
    hiddenRows: Math.max(rows - descRows, 1),
  };
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
  return { glyph: ICON.DIAMOND, color: C.purple };
}

/** ink ConversationMessages: under this a committed thought reads "briefly". */
const BRIEF_THOUGHT_THRESHOLD_MS = 1_000;

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
  durationMs?: number,
): ThinkingMeta {
  const expandHint = clickable
    ? '(click or ctrl+o to expand)'
    : '(ctrl+o to expand)';
  const completedLabel =
    durationMs === undefined
      ? null
      : durationMs < BRIEF_THOUGHT_THRESHOLD_MS
        ? 'Thought briefly'
        : `Thought for ${formatDuration(durationMs)}`;
  if (!done) {
    return {
      icon: ICON.BECAUSE,
      label: 'Thinking…',
      hint: '',
      color: C.dim,
      collapsed: false,
    };
  }
  if (!expanded) {
    return {
      icon: ICON.THEREFORE,
      label: completedLabel ?? 'Thinking',
      hint: expandHint,
      color: C.dim,
      collapsed: true,
    };
  }
  return {
    icon: ICON.THEREFORE,
    label: completedLabel ?? 'Thinking…',
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
  // Both spellings appear in producers: the event adapter and the client
  // tool-run emit 'cancelled' (two Ls); 'canceled' is kept for any other
  // source. 'interrupted' is the ESC-abort summary.
  const canceled =
    item.summary === 'interrupted' ||
    item.summary === 'canceled' ||
    item.summary === 'cancelled';
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
