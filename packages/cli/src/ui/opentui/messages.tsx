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

/**
 * Total physical rows `rows` occupy when soft-wrapped to `cols` columns —
 * the shared total behind headWindowPhysical, tailWindowPhysical and
 * pendingCardMaxRows's dialog-body measure, so all three agree by
 * construction. `stopAfter` ends the scan early for callers whose consumers
 * all clamp past a threshold: every larger total produces the identical
 * clamped outcome.
 */
function physicalRowsTotal(
  rows: readonly string[],
  cols: number,
  stopAfter = Number.POSITIVE_INFINITY,
): number {
  let sum = 0;
  for (const row of rows) {
    sum += physicalRowCount(row, cols);
    if (sum > stopAfter) break;
  }
  return sum;
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
  const total = physicalRowsTotal(rows, cols);
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
  const total = physicalRowsTotal(rows, cols);
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
 * Rows a pending card's confirmation dialog does not own. Above the card's
 * description rows: the banner (6), the startup notices a fresh session
 * shows (≈ 3), the prompt echo with its turn margin (2), and the card's own
 * hidden-tail and awaiting rows (2). In the dialog itself, around the body:
 * the frame's border and padding (4), title (1), body margins (2), question
 * row (1), outcome list (2 — 4 when a trusted folder adds the
 * always-allow rows, a difference the padding below absorbs), footer hint
 * (1) ≈ 11. The sum (≈ 24, padded to 26 against notice timing) is what an
 * 80-row viewport measured: at 14 the expanded tail and the outcome list
 * ran off the bottom of the screen (mem0 e2e regression).
 * dialogs-confirm's EXPANDED_BODY_RESERVE_ROWS prices the same region from
 * the dialog's side; keep the two consistent when the dialog chrome
 * changes.
 *
 * Known limit: the transcript region above the card is priced at its
 * FRESH-session height (the ≈ 13 rows enumerated above); nothing recomputes
 * it as the session grows, so from the second exchange onward the card
 * keeps budget rows the viewport no longer has — measured on the mcp shape
 * at h=80 with 7 parked cards, 16 painted rows above the card already clip
 * the mounted dialog's bottom border and 20 put it off screen. Charging the
 * painted height needs a per-item transcript height model (or a
 * layout-level transcript window), a follow-up beyond this PR; until then
 * the padded reserve covers a fresh session only.
 */
export const DIALOG_EXPANDED_RESERVE_ROWS = 26;

/**
 * Collapsed row cap for a confirmation dialog's body (dialogs-confirm's
 * TextBody and DiffBody). Longer plain-text bodies expand on ctrl-s, which
 * is the transition pendingCardMaxRows's expanded-dialog bound keys on.
 */
export const CONFIRM_BODY_COLLAPSED_ROWS = 20;

/**
 * The collapsed-dialog bound's non-body rows: the transcript region above
 * the card plus the dialog's frame, title/question, outcome list and
 * footer. This IS the expanded reserve — both bounds price the same region
 * and differ only in the body height charged, and making that one quantity
 * by construction is why a body fitting the collapsed window always makes
 * the two bounds coincide (the expanded bound only binds past the window),
 * so dialogBodyMeasure needs no collapsed/expanded gate.
 */
const COLLAPSED_DIALOG_CHROME_ROWS = DIALOG_EXPANDED_RESERVE_ROWS;

/**
 * Collapsed body rows of an mcp confirmation dialog — the server and tool
 * name lines plus body margins. It is the one fixed-body dialog whose
 * collapsed footprint is measurably smaller than the collapsed window;
 * every other dialog can fill the window, so they charge it in full.
 */
const MCP_CONFIRM_BODY_ROWS = 5;

/**
 * Measured at a 110-column terminal the card's flex row gives the
 * description ~79 of the 108 columns capToolCardDescription budgets with
 * (the name column takes the rest), so a budget of B rows renders about
 * B / 0.73 rows. Budgeting at 0.7 keeps the estimate on the safe side of
 * that inflation across plausible name lengths.
 */
const CARD_DESC_WRAP_RATIO = 0.7;

/**
 * What the transcript knows about the pending call's confirmation dialog.
 * `type` is confirmationDetails.type; `body` is the text the dialog renders
 * for the types whose body is a plain text block (info's prompt, plan's
 * plan, exec's command — see event-adapter's confirmationDialogBody, which
 * mirrors dialogs-confirm's ConfirmationBody switch); `extra` is the rows
 * the dialog renders OUTSIDE the body window (info's urls block, exec's
 * warnings).
 */
export interface PendingDialogBody {
  type?: string;
  body?: string;
  extra?: string;
}

/**
 * The pending confirmation dialog's body in physical rows: `expanded` is
 * the body's full height, charged by the expanded-dialog bound — or null
 * for the fixed-body types whose dialogs render no measurable text;
 * `collapsed` is the body height the collapsed-dialog bound charges, and is
 * present only where it can decide the price. For a measured body the
 * expanded bound always dominates: the two bounds subtract the same chrome
 * quantity (COLLAPSED_DIALOG_CHROME_ROWS IS DIALOG_EXPANDED_RESERVE_ROWS)
 * and the collapsed window never charges MORE than the full body, so the
 * collapsed term cannot win the min and is omitted. The collapsed bound is
 * live only for the fixed-body types and the body-less proxy.
 *
 * info and plan render an expandable TextBody and exec renders its command
 * in full (no window at all), so for them the body's OWN rows decide
 * (measured like TextBody: sanitized, split on newlines, each logical row
 * charged its wrapped height): a many-short-line plan folds to one card row
 * but fills the dialog, and a multi-line command folds to one card row but
 * renders every line. Rows the dialog renders OUTSIDE the body window —
 * info's urls block and exec's warnings, carried as `extra` — charge in
 * addition to the measured body, the same split the render makes (TextBody
 * windows only the prompt). The named
 * fixed-body types return a null expansion: mcp's dialog body is two fixed
 * lines and the card is the only surface carrying the call's arguments
 * (R5-9); edit's dialog is a tail-windowed diff below an UNBOUNDED warnings
 * list, but edit-kind cards carry a one-row description (the edit tools
 * return just the path), so there is nothing to yield; ask_user_question's
 * question/options list is fixed at ask time. Everything else — a typed
 * confirmation whose body text never arrived, and any type this module does
 * not know (a future ToolCallConfirmationDetails variant, a version-skewed
 * wire event) — keeps the folded card-payload proxy: there the yield is
 * what brings the outcome list back on screen, so the safe side is
 * yielding.
 */
function dialogBodyMeasure(
  dialog: PendingDialogBody | undefined,
  payloadRows: number,
  dialogWidth: number,
  measureCap: number,
): { expanded: number | null; collapsed?: number } {
  const type = dialog?.type;
  if (
    (type === 'info' || type === 'plan' || type === 'exec') &&
    dialog?.body !== undefined
  ) {
    const cols = Math.max(dialogWidth - 2, 10);
    // String widths count TAB as 0 columns while the renderer advances it
    // exactly 2 (customBanner's detab convention), so measure the detabbed
    // text — the same detabbed rows TextBody windows in dialogs-confirm.
    const detabbed = (text: string) =>
      sanitizeTerminalText(text).replace(/\t/g, '  ');
    const rows = physicalRowsTotal(
      detabbed(dialog.body).split('\n'),
      cols,
      measureCap,
    );
    const extra =
      dialog.extra === undefined
        ? 0
        : physicalRowsTotal(
            detabbed(dialog.extra).split('\n'),
            cols,
            measureCap,
          );
    return { expanded: rows + extra };
  }
  if (type === 'mcp' || type === 'edit' || type === 'ask_user_question') {
    return {
      expanded: null,
      collapsed:
        type === 'mcp' ? MCP_CONFIRM_BODY_ROWS : CONFIRM_BODY_COLLAPSED_ROWS,
    };
  }
  return { expanded: payloadRows, collapsed: CONFIRM_BODY_COLLAPSED_ROWS };
}

/**
 * Description budget for a pending tool card, bounded three ways: never
 * past the ink-parity history cap, never so tall that the pending cards
 * plus the confirmation dialog's collapsed body overflow the viewport, and
 * — when the dialog will show a taller body on ctrl-s expansion (a
 * hook-forced info confirmation duplicates the card's description; a plan
 * body is much taller than its folded card row) — shrunk so the expanded
 * body plus chrome still fits. Both dialog bounds are priced in budget
 * rows: a budget row renders ~1/0.7 physical rows, so the physical rows the
 * region above the card and the dialog occupy are converted by
 * CARD_DESC_WRAP_RATIO — spending them unconverted over-budgets the card
 * ~1.37x and the dialog's question row and outcome list leave the screen —
 * and both bounds are shared between the `pendingCount` cards awaiting
 * approval, since N parked calls each painting the full region push the
 * first call's dialog off the alt screen. `descriptionWidth` is the display
 * width of the text the card would print; a lone pending card never drops
 * below the settled cap (the short-terminal fallback), but once siblings
 * share the region the floor drops to one row — a floor at the settled cap
 * would lift the divided bound back up from the batch size where it falls
 * below it, and N cards at the cap grow the region linearly past the
 * viewport with nothing left to give. Before the division the shared region
 * also spends each sibling card's own chrome — the hidden-tail label and
 * awaiting row a parked card paints outside its budgeted description rows,
 * two rows per card past the first (the reserve already charges one
 * card's) — or eight cards priced at 4 budget rows would still paint 7 rows
 * each and overflow a 49-row region.
 */
export function pendingCardMaxRows(
  terminalHeight: number,
  descriptionWidth: number,
  width: number,
  dialog?: PendingDialogBody,
  pendingCount = 1,
): number {
  const h = Math.floor(terminalHeight);
  const payloadRows = Math.ceil(
    descriptionWidth / Math.max(width - STATUS_INDICATOR_WIDTH, 10),
  );
  // The card's payload folds on the transcript's width, but the dialog's
  // body measures on the dialog's own content columns: the frame's border
  // and padding spend 4 columns (dialogs-shared's "one column of border and
  // one of padding on each side"), and start-opentui-ui passes
  // availableWidth as terminalWidth - 4 — so the dialog's column basis here
  // IS width (dialogWidth = width + 2, minus the headWindowPhysical-style
  // measure's own 2 columns). The measure stops once the count can no
  // longer change the clamped outcome: every total past
  // h - DIALOG_EXPANDED_RESERVE_ROWS bottoms the expanded bound out at the
  // floor.
  const body = dialogBodyMeasure(
    dialog,
    payloadRows,
    width + 2,
    Math.max(h - DIALOG_EXPANDED_RESERVE_ROWS, CONFIRM_BODY_COLLAPSED_ROWS),
  );
  // Each parked card also paints its hidden-tail label and awaiting row
  // OUTSIDE the budgeted description rows; the reserve charges those two
  // chrome rows once, so every sibling past the first spends them from the
  // shared region before it is divided (eight cards priced at 4 budget rows
  // would otherwise paint 7 rows each and overflow a 49-row region).
  const siblingChromeRows = Math.max(pendingCount - 1, 0) * 2;
  const expandedDialogBound =
    body.expanded === null
      ? Number.POSITIVE_INFINITY
      : Math.floor(
          ((h -
            DIALOG_EXPANDED_RESERVE_ROWS -
            body.expanded -
            siblingChromeRows) *
            CARD_DESC_WRAP_RATIO) /
            Math.max(pendingCount, 1),
        );
  const collapsedDialogBound =
    body.collapsed === undefined
      ? Number.POSITIVE_INFINITY
      : Math.floor(
          ((h -
            COLLAPSED_DIALOG_CHROME_ROWS -
            body.collapsed -
            siblingChromeRows) *
            CARD_DESC_WRAP_RATIO) /
            Math.max(pendingCount, 1),
        );
  return Math.max(
    pendingCount > 1 ? 1 : TOOL_CARD_DESCRIPTION_ROWS,
    Math.min(
      maxHistoryItemRows(terminalHeight),
      collapsedDialogBound,
      expandedDialogBound,
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
