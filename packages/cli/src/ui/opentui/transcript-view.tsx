/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Transcript renderer for the OpenTUI backend (Batch 6): maps the folded
 * {@link LiveHistoryItem} list onto screen rows, reusing the ink-parity
 * helpers in messages.tsx (glyphs, colors, tail windows, todo/ansi rows) and
 * the native `<markdown>` renderable for assistant bodies.
 *
 * Every history kind renders something — a kind that fell through would be a
 * silent no-op, which the composition-root contract forbids.
 */

import { useEffect, useMemo, useRef, useState, type ErrorInfo } from 'react';
import { useRenderer } from '@opentui/react';
import type { Renderable, ScrollBoxRenderable } from '@opentui/core';
import { AgentStatus } from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { C, SYNTAX, SYNTAX_DIM, type Palette } from './theme.js';
import {
  AnsiRows,
  TOOL_CARD_DESCRIPTION_ROWS,
  TodoRows,
  assistantMessageMeta,
  capToolCardDescription,
  hiddenLinesLabel,
  hiddenTailLinesLabel,
  maxHistoryItemRows,
  pendingCardMaxRows,
  selectionProps,
  STATUS_INDICATOR_WIDTH,
  tailWindow,
  thinkingMeta,
  toolCardDescription,
  toolCardName,
  toolCardSummarySuffix,
  toolCardText,
  toolStatusMeta,
  truncateResultDisplayChars,
  userMessageMeta,
} from './messages.js';
import {
  describeGoalCard,
  describeLegacyGoalCard,
  type GoalCardColor,
  type LiveGoalLegacyData,
  type LiveHistoryItem,
  type LiveThinkingItem,
  type LiveToolItem,
  type LiveArenaSessionItem,
} from './live-session-model.js';
import { renderDiffBody } from './diff-render.js';
import {
  ESTIMATED_FIRST_ITEM_ROWS,
  ESTIMATED_ITEM_ROWS,
  computeTranscriptWindow,
  itemOffsets,
  type TranscriptWindow,
} from './transcript-window.js';
import { assistantMarkdownForRender } from './markdown-heal.js';
import { OpenTuiErrorBoundary } from './opentui-error-boundary.js';
import { formatInlineToolArgsJson } from '../components/messages/ToolMessage.js';
import {
  getCachedStringWidth,
  sanitizeTerminalText,
} from '../utils/textUtils.js';
import { getCompressionStatusText } from '../utils/compression-text.js';
import { ICON } from '../constants.js';
import { formatClockTime, formatDuration } from '../utils/formatters.js';
import { getArenaStatusLabel } from '../utils/displayUtils.js';
import type { ArenaAgentCardData } from '../types.js';

/** ink HistoryItemDisplay picks between two hints by whether the card is
 *  clickable; `ui.mouseTracking: false` hands the pointer back to the
 *  terminal, so only the key hint is offered. */
function expandHint(clickable: boolean): string {
  return clickable ? 'click to expand' : 'ctrl+o to expand';
}

/** Keys, not colours: `C` is mutated in place when the theme is applied,
 *  which happens after this module is imported. */
const GOAL_COLOR_KEY = {
  accent: 'accent',
  warning: 'yellow',
  error: 'red',
  success: 'green',
  secondary: 'dim',
} as const satisfies Record<GoalCardColor, keyof Palette>;

function goalColor(color: GoalCardColor): string {
  return C[GOAL_COLOR_KEY[color]];
}

export interface TranscriptViewProps {
  items: readonly LiveHistoryItem[];
  /** Width budget for ANSI grids / wrapping (defaults to a safe 80). */
  availableWidth?: number;
  /** Terminal height; per-item row caps follow ink staticAreaMaxItemHeight. */
  availableTerminalHeight?: number;
  /** ink's app-wide ctrl+O toggle: forces every committed thought open. */
  thoughtsExpanded?: boolean;
  /** `ui.showToolCallArgs`: ink draws each call's raw arguments on their own
   * line under the card header. */
  showToolCallArgs?: boolean;
  /** `output.showTimestamps`: ink stamps `[HH:MM:SS]` above each assistant row. */
  showTimestamps?: boolean;
  /** `ui.showToolCallDetails`: false collapses every tool card to its header
   * plus an expand hint, the way ink's CollapsibleToolGroupMessage does. */
  showToolCallDetails?: boolean;
  /** `ui.mouseTracking`: false means the renderer takes no pointer events, so
   * the expand hints must not offer a click. */
  mouseTracking?: boolean;
  /** The call whose confirmation is on screen. ink's trailing marker points at
   * the call the user can answer, and only the waiting queue knows which that
   * is: a PreToolUse `ask` hook re-arms an already approved call by appending it
   * *behind* another waiting call, while its card goes back to pending in place,
   * so transcript order and queue order disagree. */
  awaitingCallId?: string;
  /**
   * Which end of the transcript is on screen before the first frame reports a
   * real scroll position. The app shell pins its scroll region to the bottom,
   * so it wants the tail; the session preview is a clipped, non-scrolling pane
   * that reads from the first turn down.
   */
  initialAnchor?: 'top' | 'bottom';
}

/** ink HistoryItemDisplay getHistoryItemMarginTop: conversation turns and the
 * arena cards get a blank row above them, while status, tool and goal rows stay
 * flush against whatever precedes them. `user` reaches the same total in ink by
 * declaring the margin inside its own message component. `task` and `image`
 * have no ink counterpart; both follow the tool rows they render beside. */
function itemMarginTop(kind: LiveHistoryItem['kind']): number {
  switch (kind) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'user-shell':
    case 'arena-agent':
    case 'arena-session':
      return 1;
    default:
      return 0;
  }
}

/** Stands in for "pinned to the last row" before the first frame reports a
 *  real offset; `computeTranscriptWindow` clamps it to the bottom. */
const ANCHOR_BOTTOM = Number.MAX_SAFE_INTEGER;

const transcriptLogger = createDebugLogger('OPEN_TUI_TRANSCRIPT');

/**
 * The whole point of a per-item boundary: @opentui/react's own root boundary
 * answers a render error with a red `text` fallback that calls `jsxDEV`, which
 * the bundled CLI does not provide, so the fallback throws too and React
 * unmounts the entire root, leaving a blank screen with no message. An item
 * that renders nothing costs one row of transcript and keeps the banner, the
 * composer and the exit path alive.
 */
function renderNothing(): null {
  return null;
}

function logItemFailure(
  error: Error,
  item: LiveHistoryItem,
  info: ErrorInfo,
): void {
  transcriptLogger.error(
    `[TRANSCRIPT_ITEM_ERROR] kind=${item.kind} id=${item.id} ` +
      `${error.message}\n${info.componentStack ?? ''}\n${error.stack ?? ''}`,
  );
}

function findScrollHost(node: Renderable | null): ScrollBoxRenderable | null {
  for (
    let cur: Renderable | null = node;
    cur;
    cur = cur.parent as Renderable | null
  ) {
    const host = cur as unknown as Partial<ScrollBoxRenderable>;
    if (
      typeof host.scrollTop === 'number' &&
      host.content &&
      host.viewport &&
      host.verticalScrollBar
    ) {
      return cur as unknown as ScrollBoxRenderable;
    }
  }
  return null;
}

function sameWindow(a: TranscriptWindow, b: TranscriptWindow): boolean {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.topPad === b.topPad &&
    a.bottomPad === b.bottomPad
  );
}

/** The model's own item identity, and the one `findToolIndex` uses: a subagent
 *  call mints a tool card and a task card from one call id, so `id` alone is
 *  not unique among live items and two of them would share one height slot. */
function itemKey(item: LiveHistoryItem): string {
  return `${item.kind}:${item.id}`;
}

interface MountedNode {
  item: LiveHistoryItem;
  node: Renderable;
}

/** The rows Yoga laid out, or `undefined` for a node not laid out yet.
 *  `Renderable.height` is clamped to at least one row, so reading it back would
 *  charge a row to an item that paints nothing — which `renderNothing` and a
 *  hidden goal card both are. Reading Yoga instead is what ink's own
 *  virtualized list does (`VirtualizedList.tsx`, `getComputedHeight()`). */
function laidOutRows(node: Renderable): number | undefined {
  if (!(node.height > 0)) return undefined;
  const { yogaNode } = node as unknown as {
    yogaNode: { getComputedHeight(): number };
  };
  return yogaNode.getComputedHeight();
}

/**
 * Row-budgeted windowing: only the items near the viewport are mounted, and
 * spacers stand in for the rest so the scroll geometry still spans the whole
 * transcript. See ./transcript-window.ts for why mounting everything blanks the
 * screen on a long session.
 *
 * Two signals, because they fire at the two moments that matter. The scroll
 * bar's `change` event is emitted synchronously as the position moves, before
 * the renderer paints, so an absolute jump — a track click or a thumb drag,
 * which can land anywhere in the transcript — still gets a window that covers
 * it in the same frame. The renderer's `frame` event fires after layout, which
 * is the only moment an item's real row count can be read. Both recompute the
 * window; only the frame measures. Idle costs nothing: neither event fires.
 */
function useTranscriptWindow(
  items: readonly LiveHistoryItem[],
  availableTerminalHeight: number,
  initialAnchor: 'top' | 'bottom',
) {
  const renderer = useRenderer();
  const rootRef = useRef<Renderable | null>(null);
  /** Measured rows per item identity, kept after the item scrolls out of the
   *  window so an estimate is never re-applied to something already measured. A
   *  resize does not clear it: the mounted items are re-measured on the next
   *  frame, and dropping the whole table would renumber every row offset
   *  underneath a scroll position that is itself counted in rows. */
  const heightsRef = useRef(new Map<string, number>());
  /** The laid-out node per mounted item identity, written by the item's own ref
   *  callback and dropped when it unmounts. Measuring through this rather than
   *  through the root's child list keeps the JSX child order out of the
   *  arithmetic — the spacers and the error boundary already have to sit
   *  exactly where they do for that order to name an item. */
  const nodesRef = useRef(new Map<string, MountedNode>());
  /** Rows the table charged each item an upward window move pulled in above the
   *  viewport, keyed by identity and dropped once the item is measured. Keyed by
   *  identity rather than index because `task-end` splices the task card out by
   *  index, shifting every index above it. The top spacer is short by whatever
   *  these turn out to cost. */
  const enteredRef = useRef(new Map<string, number>());
  const offsetsRef = useRef<number[]>([0]);
  const itemsRef = useRef(items);
  const mountedRef = useRef<TranscriptWindow>({
    start: 0,
    end: 0,
    topPad: 0,
    bottomPad: 0,
  });
  /** `rows: 0` means no scroll host has reported a viewport yet, so the height
   *  prop is the fallback — read every render, which keeps a host-less pane
   *  (the session preview) in step across a resize. */
  const scrollRef = useRef({
    top: initialAnchor === 'bottom' ? ANCHOR_BOTTOM : 0,
    rows: 0,
  });
  const [revision, setRevision] = useState(0);

  const offsets = useMemo(() => {
    const measured = heightsRef.current;
    return itemOffsets(
      items.map(
        (item, index) =>
          measured.get(itemKey(item)) ??
          (index === 0 ? ESTIMATED_FIRST_ITEM_ROWS : ESTIMATED_ITEM_ROWS),
      ),
    );
    // Measured heights live in a ref that the frame handler mutates, so
    // `revision` is what tells this memo one of them changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, revision]);

  itemsRef.current = items;
  offsetsRef.current = offsets;

  const win = computeTranscriptWindow({
    itemCount: items.length,
    offsets,
    scrollTop: scrollRef.current.top,
    viewportRows: scrollRef.current.rows || availableTerminalHeight,
  });
  // Recorded here rather than in the frame handler: the render body is what
  // mounts a window, so it is also what can say which items the move pulled in
  // above the viewport.
  const pulledIn = enteredRef.current;
  const painted = mountedRef.current;
  if (win.end > painted.start && win.start < painted.end) {
    // These were spacer rows charged at whatever the table said, which for an
    // item that was never mounted is the estimate. What they turn out to cost
    // is settled on the frame that measures them.
    for (let index = win.start; index < painted.start; index++) {
      const key = itemKey(items[index]);
      // An identity the previous commit already mounted is not a pull-in: its
      // rows are painted, not charged to a spacer. Skipping it is what keeps a
      // `task-end` splice above the window — which shifts the index space this
      // loop walks — from charging items that never left the screen.
      if (nodesRef.current.has(key) || pulledIn.has(key)) continue;
      pulledIn.set(key, (offsets[index + 1] ?? 0) - (offsets[index] ?? 0));
    }
  } else {
    // A jump lands somewhere the painted state says nothing about, so there is
    // no reading position to carry over and nothing left to settle.
    pulledIn.clear();
  }
  mountedRef.current = win;

  useEffect(() => {
    if (!renderer?.on) return;
    let bar: ScrollBoxRenderable['verticalScrollBar'] | null = null;

    const locate = () => {
      const root = rootRef.current;
      if (!root) return null;
      const host = findScrollHost(root);
      return host ? { root, host } : null;
    };

    /** Samples the host's real position for the render body to read back, and
     *  reports whether it implies a window other than the mounted one. */
    const syncWindow = (root: Renderable, host: ScrollBoxRenderable) => {
      // `y` is absolute, so the difference is the offset inside the scroll
      // content and cancels the translation the scroll position applies.
      const top =
        Math.round(host.scrollTop) - Math.round(root.y - host.content.y);
      const rows = Math.max(1, Math.round(host.viewport.height));
      scrollRef.current = { top, rows };
      // Compared against the painted window rather than adopted here: the
      // render body is what mounts a window, so it is also what records which
      // items the move pulled in.
      const next = computeTranscriptWindow({
        itemCount: itemsRef.current.length,
        offsets: offsetsRef.current,
        scrollTop: top,
        viewportRows: rows,
      });
      return !sameWindow(next, mountedRef.current);
    };

    const onScroll = () => {
      const found = locate();
      if (!found) return;
      if (syncWindow(found.root, found.host)) setRevision((value) => value + 1);
    };

    const onFrame = () => {
      const root = rootRef.current;
      if (!root) return;

      const measured = heightsRef.current;
      const entered = enteredRef.current;
      let revised = false;
      let owed = 0;
      for (const { item, node } of nodesRef.current.values()) {
        const laidOut = laidOutRows(node);
        if (laidOut === undefined) continue;
        const key = itemKey(item);
        const rows = Math.round(laidOut) + itemMarginTop(item.kind);
        // Consumed on every measurement, not only the first: a height recorded
        // before the item left the window can go stale while it is unmounted (a
        // resize, or ctrl+O flipping every card at once), so what says the
        // spacer above the reader was charged wrong is the charge itself.
        const charged = entered.get(key);
        if (charged !== undefined) {
          entered.delete(key);
          // The spacer rows this item replaced, minus the rows it paints.
          owed += charged - rows;
        }
        const known = measured.get(key);
        if (known === rows) continue;
        measured.set(key, rows);
        revised = true;
      }

      // Measuring needs only the root; the settlement and the window sync need
      // a host. Splitting them is what lets the session preview — which mounts
      // outside the shell's scrollbox, so `findScrollHost` never matches —
      // record real heights instead of staying sized from estimates for its
      // whole life.
      const found = locate();
      let changed = revised;
      if (found) {
        const { host } = found;
        if (bar !== host.verticalScrollBar) {
          bar?.off('change', onScroll);
          bar = host.verticalScrollBar;
          bar.on('change', onScroll);
        }
        if (owed !== 0) {
          // Measuring an item that was already mounted owes nothing: it is
          // painted at the height just read, and both spacers come from offsets
          // a change inside the window leaves alone. An item the window pulled
          // in above the viewport is different — the spacer rows it replaced
          // were charged at the estimate, which is the only number that exists
          // before it is laid out, so the table under it shrank by the
          // difference and the reader is now that many rows away from the
          // content they were on. Settling it into the scroll position is what
          // makes a three-row wheel tick travel three rows over one-row turns
          // instead of one. See Decision 5.
          const rows = Math.max(1, Math.round(host.viewport.height));
          const tail = Math.max(0, host.scrollHeight - rows);
          const from = Math.round(host.scrollTop);
          const to = Math.max(0, from - owed);
          // The setter recomputes `_hasManualScroll` from wherever the write
          // lands, and a position one row off the tail takes the shell's bottom
          // pin off for the rest of the session — that was R1-4. Settle only
          // where the reader's own scrolling has already gone, and never onto
          // the tail, so the write cannot change what the pin is doing.
          if (from < tail && to < tail) host.scrollTop = to;
        }
        changed = syncWindow(found.root, host) || changed;
      }
      if (changed) setRevision((value) => value + 1);
    };

    renderer.on('frame', onFrame);
    return () => {
      renderer.off('frame', onFrame);
      bar?.off('change', onScroll);
    };
  }, [renderer]);

  return { rootRef, nodesRef, win };
}

export function OpenTuiTranscriptView({
  items,
  availableWidth = 80,
  availableTerminalHeight = 24,
  thoughtsExpanded = false,
  showToolCallArgs = false,
  showTimestamps = false,
  showToolCallDetails = true,
  mouseTracking = true,
  awaitingCallId,
  initialAnchor = 'bottom',
}: TranscriptViewProps) {
  const maxRows = maxHistoryItemRows(availableTerminalHeight);
  const awaitingId = items.find(
    (item) =>
      item.kind === 'tool' &&
      item.confirm === 'pending' &&
      !item.done &&
      item.id === awaitingCallId,
  )?.id;
  const { rootRef, nodesRef, win } = useTranscriptWindow(
    items,
    availableTerminalHeight,
    initialAnchor,
  );
  return (
    <box
      flexDirection="column"
      marginLeft={2}
      marginRight={2}
      ref={(el) => {
        rootRef.current = el as Renderable | null;
      }}
    >
      <box height={win.topPad} flexShrink={0} />
      {items.slice(win.start, win.end).map((item) => {
        const key = itemKey(item);
        return (
          <box
            key={key}
            flexDirection="column"
            marginTop={itemMarginTop(item.kind)}
            ref={(el) => {
              if (el) {
                nodesRef.current.set(key, { item, node: el as Renderable });
              } else {
                nodesRef.current.delete(key);
              }
            }}
          >
            <OpenTuiErrorBoundary
              fallback={renderNothing}
              onError={(error, info) => logItemFailure(error, item, info)}
            >
              <TranscriptItem
                item={item}
                maxRows={maxRows}
                terminalHeight={availableTerminalHeight}
                width={availableWidth}
                thoughtsExpanded={thoughtsExpanded}
                showToolCallArgs={showToolCallArgs}
                showTimestamps={showTimestamps}
                showToolCallDetails={showToolCallDetails}
                mouseTracking={mouseTracking}
                awaitingApproval={item.id === awaitingId}
              />
            </OpenTuiErrorBoundary>
          </box>
        );
      })}
      <box height={win.bottomPad} flexShrink={0} />
    </box>
  );
}

function TranscriptItem({
  item,
  maxRows,
  terminalHeight,
  width,
  thoughtsExpanded,
  showToolCallArgs,
  showTimestamps,
  showToolCallDetails,
  mouseTracking,
  awaitingApproval,
}: {
  item: LiveHistoryItem;
  maxRows: number;
  terminalHeight: number;
  width: number;
  thoughtsExpanded: boolean;
  showToolCallArgs: boolean;
  showTimestamps: boolean;
  showToolCallDetails: boolean;
  mouseTracking: boolean;
  awaitingApproval: boolean;
}) {
  switch (item.kind) {
    case 'user':
      return <UserRow text={item.text} />;
    case 'assistant':
      return (
        <AssistantRow
          text={item.text}
          streaming={item.streaming}
          timestamp={showTimestamps ? item.timestamp : undefined}
        />
      );
    case 'thinking':
      return (
        <ThinkingRow
          item={item}
          allExpanded={thoughtsExpanded}
          mouseTracking={mouseTracking}
        />
      );
    case 'tool':
      return (
        <ToolCard
          item={item}
          maxRows={maxRows}
          terminalHeight={terminalHeight}
          width={width}
          fullDetail={thoughtsExpanded}
          showToolCallArgs={showToolCallArgs}
          showToolCallDetails={showToolCallDetails}
          mouseTracking={mouseTracking}
          awaitingApproval={awaitingApproval}
        />
      );
    case 'task':
      return <TaskCard item={item} />;
    case 'image':
      return (
        <text fg={C.dim} {...selectionProps()}>
          {`[inline image: ${item.mimeType}]`}
        </text>
      );
    case 'compaction':
      return <CompactionRow compression={item.compression} />;
    case 'info':
      return (
        <box flexDirection="row">
          {/* A wrapped message would otherwise shrink the prefix and drop its
              trailing space. */}
          <text fg={C.dim} flexShrink={0}>{`${ICON.CIRCLE_FILLED} `}</text>
          <text fg={C.dim} {...selectionProps()}>
            {sanitizeTerminalText(item.text)}
          </text>
        </box>
      );
    case 'error':
      return <ErrorRow text={item.text} hint={item.hint} />;
    case 'warning':
      return (
        <box flexDirection="row">
          <text fg={C.yellow} flexShrink={0}>{`${ICON.TRIANGLE} `}</text>
          <text fg={C.yellow} {...selectionProps()}>
            {sanitizeTerminalText(item.text)}
          </text>
        </box>
      );
    case 'retry':
      return (
        <RetryRows
          message={item.message}
          attempt={item.attempt}
          maxRetries={item.maxRetries}
          delayMs={item.delayMs}
          startedAt={item.startedAt}
        />
      );
    case 'stop-hook':
      return <StopHookRow message={item.message} />;
    case 'goal':
      return <GoalCard item={item} />;
    case 'away-recap':
      return <AwayRecapRow text={item.text} />;
    case 'user-shell':
      return <UserShellRow text={item.text} />;
    case 'advisor':
      return <AdvisorRow text={item.text} model={item.model} />;
    case 'arena-agent':
      return <ArenaAgentRow agent={item.agent} />;
    case 'arena-session':
      return <ArenaSessionRow item={item} />;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

function UserRow({ text }: { text: string }) {
  const meta = userMessageMeta();
  return (
    <box flexDirection="row">
      {/* A trailing space in the glyph's own text node is squeezed out as soon
          as the sibling needs the full width, so the gap is structural. */}
      <box width={STATUS_INDICATOR_WIDTH}>
        <text fg={meta.color}>{meta.glyph}</text>
      </box>
      <text fg={meta.color} {...selectionProps()}>
        {sanitizeTerminalText(text)}
      </text>
    </box>
  );
}

function AssistantRow({
  text,
  streaming,
  timestamp,
}: {
  text: string;
  streaming: boolean;
  timestamp?: number;
}) {
  const meta = assistantMessageMeta();
  const content = sanitizeTerminalText(
    assistantMarkdownForRender(text, streaming),
  );
  // The two shapes differ, and `output.showTimestamps` is a setting the dialog
  // can flip mid-session: without keys the stamped branch's second child would
  // reuse the unstamped one's and keep the flexGrow it was given (Decision 11).
  const row = (
    <box key="bare" flexDirection="row">
      <box width={STATUS_INDICATOR_WIDTH}>
        <text fg={meta.color}>{meta.glyph}</text>
      </box>
      <box flexGrow={1}>
        <markdown
          content={content}
          syntaxStyle={SYNTAX}
          streaming={streaming}
        />
      </box>
    </box>
  );
  if (timestamp === undefined) return row;
  return (
    <box key="stamped" flexDirection="column">
      <text fg={C.dim}>{formatClockTime(timestamp)}</text>
      {row}
    </box>
  );
}

function ThinkingRow({
  item,
  allExpanded,
  mouseTracking,
}: {
  item: LiveThinkingItem;
  allExpanded: boolean;
  mouseTracking: boolean;
}) {
  const [clickedOpen, setClickedOpen] = useState(false);
  // ink resolves a thought as the global ctrl+O toggle or its own clicked-open
  // head id, so switching the global back off leaves a hand-opened thought open.
  const expanded = allExpanded || clickedOpen;
  // A live thought has no stamped duration yet; ink re-derives the elapsed
  // time on every render so the pending label carries it.
  const durationMs =
    item.durationMs ??
    (item.startedAt === undefined ? undefined : Date.now() - item.startedAt);
  const meta = thinkingMeta(item.done, expanded, durationMs, mouseTracking);
  const body = item.text.trimEnd();
  return (
    <box
      flexDirection="column"
      onMouseUp={() => {
        if (item.done) setClickedOpen((v) => !v);
      }}
    >
      <box flexDirection="row">
        <text fg={meta.color}>
          {meta.icon} {meta.label}
          {meta.hint ? ` ${meta.hint}` : ''}
        </text>
      </box>
      {!meta.collapsed && body ? (
        <box flexDirection="row">
          <box width={STATUS_INDICATOR_WIDTH} />
          <box flexGrow={1}>
            <markdown
              content={sanitizeTerminalText(body)}
              syntaxStyle={SYNTAX_DIM}
              streaming={!item.done}
              fg={C.dim}
            />
          </box>
        </box>
      ) : null}
    </box>
  );
}

function ToolCard({
  item,
  maxRows,
  terminalHeight,
  width,
  fullDetail,
  showToolCallArgs,
  showToolCallDetails,
  mouseTracking,
  awaitingApproval,
}: {
  item: LiveToolItem;
  maxRows: number;
  terminalHeight: number;
  width: number;
  fullDetail: boolean;
  showToolCallArgs: boolean;
  showToolCallDetails: boolean;
  mouseTracking: boolean;
  awaitingApproval: boolean;
}) {
  const [clickedOpen, setClickedOpen] = useState(false);
  const status = toolStatusMeta(item);
  const name = toolCardName(item.tool);
  // ink's CollapsibleToolGroupMessage keeps a call open while it needs an
  // answer: the card is the only surface carrying the payload being approved.
  const collapsed =
    !showToolCallDetails &&
    !clickedOpen &&
    !fullDetail &&
    item.confirm !== 'pending';
  const description =
    item.description ?? toolCardDescription(item.tool, item.args);
  // Measure on the same basis the render uses: a live description (e.g. a
  // shell command) can carry newlines that each become a physical row while
  // costing zero columns in the cap math, so fold them first like the
  // fallback path does (R6-2).
  const text = toolCardText(description);
  // The description stays visible while a call awaits approval: an MCP
  // confirmation body shows only the server and tool names, so the card is
  // the only surface carrying the arguments (R5-9) — the settled 5-row cap
  // would hide the tail of exactly the payload being approved. The pending
  // budget stays viewport- and payload-aware (pendingCardMaxRows): the
  // confirmation renders in flow below the transcript, and a hook-forced
  // confirmation renders this same payload in its body, so the card must
  // yield rows for it or ctrl-s expansion pushes the options off screen.
  const cap = capToolCardDescription(
    text,
    name,
    width,
    item.confirm === 'pending' && !item.done
      ? pendingCardMaxRows(terminalHeight, getCachedStringWidth(text), width)
      : TOOL_CARD_DESCRIPTION_ROWS,
  );
  const suffix = toolCardSummarySuffix(item.done, item.summary);
  // ink measures the args row against the header's own inner width (the status
  // glyph's columns are not available to it), so the wrapped-row cap bounds
  // what actually reaches the screen.
  const innerWidth = width - STATUS_INDICATOR_WIDTH;
  const argsRow =
    showToolCallArgs && item.args
      ? formatInlineToolArgsJson(
          item.args,
          description,
          fullDetail,
          innerWidth > 0 ? innerWidth : undefined,
        )
      : undefined;
  // Both states share one tree shape. @opentui/react never clears a prop that a
  // re-render drops, so a collapsed branch of its own shape would leave its
  // glyph box's width stuck on the reconciled header row and clip the title.
  return (
    <box flexDirection="column">
      <box
        flexDirection="row"
        onMouseUp={() => {
          if (collapsed) setClickedOpen(true);
        }}
      >
        <box width={STATUS_INDICATOR_WIDTH}>
          <text fg={status.color} attributes={status.strikethrough ? 128 : 0}>
            {status.glyph}
          </text>
        </box>
        {collapsed ? (
          <>
            <text
              key="name"
              fg={C.text}
              attributes={status.strikethrough ? 129 : 1}
            >
              {name}
            </text>
            <text
              key="hint"
              fg={C.dim}
            >{` · ${expandHint(mouseTracking)}`}</text>
          </>
        ) : (
          // ink wraps the name and the description as one block, so the
          // continuation rows align under the name and the trailing arrow ends
          // up after the last character. Separate flex siblings cannot do
          // that: they also drop the description's leading space.
          <text key="header" flexGrow={1} {...selectionProps()}>
            <span fg={C.text} attributes={status.strikethrough ? 129 : 1}>
              {name}
            </span>
            {cap.description ? (
              <span fg={C.dim}>
                {` ${sanitizeTerminalText(cap.description)}`}
              </span>
            ) : null}
            {suffix ? (
              <span fg={C.dim}>{sanitizeTerminalText(suffix)}</span>
            ) : null}
            {awaitingApproval ? (
              // ink's TrailingIndicator: a primary-coloured arrow at the end of
              // the awaiting call's own row, not a row of its own.
              <span fg={C.text}>{' ←'}</span>
            ) : null}
          </text>
        )}
      </box>
      {collapsed ? null : (
        <>
          {cap.hiddenRows > 0 && (
            <text fg={C.dim}>{hiddenTailLinesLabel(cap.hiddenRows)}</text>
          )}
          {argsRow ? (
            <box paddingLeft={STATUS_INDICATOR_WIDTH}>
              <text fg={C.dim} {...selectionProps()}>
                {argsRow}
              </text>
            </box>
          ) : null}
          <ToolCardBody item={item} maxRows={maxRows} width={width} />
        </>
      )}
    </box>
  );
}

function ToolCardBody({
  item,
  maxRows,
  width,
}: {
  item: LiveToolItem;
  maxRows: number;
  width: number;
}) {
  if (item.todos) {
    return (
      <box paddingLeft={STATUS_INDICATOR_WIDTH}>
        <TodoRows todos={item.todos} />
      </box>
    );
  }
  if (item.ansi) {
    return (
      <box paddingLeft={STATUS_INDICATOR_WIDTH}>
        <AnsiRows
          grid={item.ansi.grid}
          maxWidth={width - STATUS_INDICATOR_WIDTH}
          totalLines={item.ansi.totalLines}
          totalBytes={item.ansi.totalBytes}
        />
      </box>
    );
  }
  if (item.subagentSummary) {
    const summary = item.subagentSummary;
    const toneColor =
      summary.tone === 'success'
        ? C.green
        : summary.tone === 'error'
          ? C.red
          : C.yellow;
    return (
      <box paddingLeft={STATUS_INDICATOR_WIDTH + 1} flexDirection="row">
        <text fg={toneColor}>{`${summary.glyph} `}</text>
        <text fg={C.text} attributes={1}>
          {sanitizeTerminalText(summary.prefix)}
        </text>
        <text fg={C.dim} {...selectionProps()}>
          {sanitizeTerminalText(truncateResultDisplayChars(summary.rest))}
        </text>
      </box>
    );
  }
  if (item.diff) {
    const lines = renderDiffBody(item.diff.fileDiff);
    const window = tailWindow(lines, maxRows);
    return (
      <box paddingLeft={STATUS_INDICATOR_WIDTH} flexDirection="column">
        {window.hiddenCount > 0 && (
          <text fg={C.dim}>{hiddenLinesLabel(window.hiddenCount)}</text>
        )}
        {window.visible.map((line, i) => (
          <box key={`${i}`} flexDirection="row">
            {line.map((span, j) => (
              <text key={`${j}`} fg={span.color} {...selectionProps()}>
                {span.text}
              </text>
            ))}
          </box>
        ))}
      </box>
    );
  }
  const output = truncateResultDisplayChars(item.output);
  if (!output) return null;
  const lines = sanitizeTerminalText(output).split('\n');
  const window = tailWindow(lines, maxRows);
  return (
    <box paddingLeft={STATUS_INDICATOR_WIDTH} flexDirection="column">
      {window.hiddenCount > 0 && (
        <text fg={C.dim}>{hiddenLinesLabel(window.hiddenCount)}</text>
      )}
      {window.visible.map((line, i) => (
        <text key={`${i}`} fg={C.text} {...selectionProps()}>
          {line}
        </text>
      ))}
      {item.visionBridgeNotice ? (
        <text fg={C.dim}>{sanitizeTerminalText(item.visionBridgeNotice)}</text>
      ) : null}
    </box>
  );
}

function TaskCard({
  item,
}: {
  item: Extract<LiveHistoryItem, { kind: 'task' }>;
}) {
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={C.text} attributes={1}>
          {TOOL_GLYPH_RUNNING}
        </text>
        <text fg={C.text} attributes={1}>
          {` ${sanitizeTerminalText(item.name)}`}
        </text>
        {item.description ? (
          <text fg={C.dim}> {sanitizeTerminalText(item.description)}</text>
        ) : null}
      </box>
      {item.progress.map((line, i) => (
        <text key={`${i}`} fg={C.dim} {...selectionProps()}>
          {sanitizeTerminalText(line)}
        </text>
      ))}
    </box>
  );
}

const TOOL_GLYPH_RUNNING = ICON.CIRCLE_LEFT_HALF;

function CompactionRow({
  compression,
}: {
  compression: Extract<LiveHistoryItem, { kind: 'compaction' }>['compression'];
}) {
  const text = getCompressionStatusText({
    isPending: compression.isPending,
    originalTokenCount: compression.originalTokenCount,
    newTokenCount: compression.newTokenCount,
    compressionStatus: compression.compressionStatus,
    originalTokenCountIsEstimated: compression.originalTokenCountIsEstimated,
    newTokenCountIsEstimated: compression.newTokenCountIsEstimated,
  });
  const color = compression.isPending ? C.accent : C.green;
  return (
    <box flexDirection="row">
      <box width={2}>
        <text fg={color}>{compression.isPending ? '…' : ICON.DIAMOND}</text>
      </box>
      <text fg={color} {...selectionProps()}>
        {text}
      </text>
    </box>
  );
}

function ErrorRow({ text, hint }: { text: string; hint?: string }) {
  return (
    <box flexDirection="row">
      {/* ink's error prefix is a literal ✕, not the shared ICON.CROSS. */}
      <text fg={C.red} flexShrink={0}>
        {'✕ '}
      </text>
      <text fg={C.red} {...selectionProps()}>
        {sanitizeTerminalText(text)}
        {hint ? (
          <span fg={C.dim}>{` (${sanitizeTerminalText(hint)})`}</span>
        ) : null}
      </text>
    </box>
  );
}

function RetryRows({
  message,
  attempt,
  maxRetries,
  delayMs,
  startedAt,
}: {
  message?: string;
  attempt: number;
  maxRetries: number;
  delayMs: number;
  startedAt: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const remainingSec = Math.max(
    0,
    Math.ceil((delayMs - (now - startedAt)) / 1000),
  );
  return (
    <box flexDirection="column">
      <text fg={C.red} {...selectionProps()}>
        {sanitizeTerminalText(
          message ?? `Attempt ${attempt} of ${maxRetries} failed`,
        )}
      </text>
      <text fg={C.yellow}>
        {`↻ Retrying in ${remainingSec}s… (attempt ${attempt} of ${maxRetries})`}
      </text>
    </box>
  );
}

function StopHookRow({ message }: { message: string }) {
  return (
    <box flexDirection="column">
      <text fg={C.accent}>{'⎿ Stop says:'}</text>
      <text fg={C.text} {...selectionProps()}>
        {`  ${sanitizeTerminalText(message)}`}
      </text>
    </box>
  );
}

function GoalCard({
  item,
}: {
  item: Extract<LiveHistoryItem, { kind: 'goal' }>;
}) {
  if (item.legacy) {
    return <LegacyGoalCard legacy={item.legacy} />;
  }
  const view = describeGoalCard(item.snapshot, item.cause);
  if (view.state === 'hidden') return null;
  if (view.state === 'cleared') {
    return <text fg={C.dim}>Goal cleared</text>;
  }
  const color = goalColor(view.color);
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={color}>
          {view.icon} {view.title}
        </text>
        {view.subtitle ? <text fg={C.dim}>{` · ${view.subtitle}`}</text> : null}
      </box>
      <text fg={C.text} {...selectionProps()}>
        {`  ${sanitizeTerminalText(view.objective)}`}
      </text>
      {view.reason ? (
        <text fg={C.dim} {...selectionProps()}>
          {`  ${sanitizeTerminalText(view.reason)}`}
        </text>
      ) : null}
    </box>
  );
}

function LegacyGoalCard({ legacy }: { legacy: LiveGoalLegacyData }) {
  const view = describeLegacyGoalCard(legacy);
  if (view.state === 'hidden') return null;
  if (view.state === 'checking') {
    return (
      <box flexDirection="column">
        <text fg={C.yellow}>{view.title}</text>
        <text fg={C.dim}>{`  ${sanitizeTerminalText(view.condition)}`}</text>
        {view.judgeReason ? (
          <text
            fg={C.dim}
          >{`  ${sanitizeTerminalText(view.judgeReason)}`}</text>
        ) : null}
      </box>
    );
  }
  const color = goalColor(view.color);
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={color}>
          {view.icon} {view.title}
        </text>
        {view.subtitle ? <text fg={C.dim}>{` · ${view.subtitle}`}</text> : null}
      </box>
      <text fg={C.dim}>{`  ${sanitizeTerminalText(view.condition)}`}</text>
      {view.lastCheck ? (
        <text fg={C.dim}>{`  ${sanitizeTerminalText(view.lastCheck)}`}</text>
      ) : null}
    </box>
  );
}

// ink AwayRecapMessage parity: `※` gutter + "recap:" label, all dim; the
// recap scrolls with the conversation instead of pinning above the input.
function AwayRecapRow({ text }: { text: string }) {
  return (
    <box flexDirection="row">
      <text fg={C.dim} flexShrink={0}>{`${ICON.REFERENCE} `}</text>
      <text fg={C.dim} attributes={1} flexShrink={0}>
        {'recap: '}
      </text>
      <text fg={C.dim} attributes={4} {...selectionProps()}>
        {sanitizeTerminalText(text)}
      </text>
    </box>
  );
}

// ink UserShellMessage parity: `$ ` prefix (ink's link color → accent) +
// the command text in the primary color.
function UserShellRow({ text }: { text: string }) {
  return (
    <box flexDirection="row">
      <text fg={C.accent}>{'$ '}</text>
      <text fg={C.text} {...selectionProps()}>
        {sanitizeTerminalText(text)}
      </text>
    </box>
  );
}

// ink AdvisorMessage parity: `/advisor · model` header + the review body as
// markdown. The ink card's border is dropped — the transcript's other cards
// separate with indentation, not boxes.
function AdvisorRow({ text, model }: { text: string; model: string }) {
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={C.accent} attributes={1}>
          {'/advisor'}
        </text>
        <text fg={C.accent}>{` · ${sanitizeTerminalText(model)}`}</text>
      </box>
      <box paddingLeft={2}>
        <markdown
          content={sanitizeTerminalText(text)}
          syntaxStyle={SYNTAX}
          streaming={false}
        />
      </box>
    </box>
  );
}

// ink getArenaStatusLabel colors mapped onto the live palette (the helper
// returns ink theme hexes, which would not track the OpenTUI theme swap).
function arenaStatusColor(status: AgentStatus): string {
  switch (status) {
    case AgentStatus.IDLE:
    case AgentStatus.COMPLETED:
      return C.green;
    case AgentStatus.CANCELLED:
      return C.yellow;
    case AgentStatus.FAILED:
      return C.red;
    default:
      return C.dim;
  }
}

// ink ArenaAgentCard parity: status line + tokens + tool calls (+ error).
function ArenaAgentRow({ agent }: { agent: ArenaAgentCardData }) {
  const { icon, text } = getArenaStatusLabel(agent.status);
  const failed = agent.failedToolCalls > 0;
  return (
    <box flexDirection="column">
      <text fg={arenaStatusColor(agent.status)}>
        {`${icon} ${sanitizeTerminalText(agent.label)} · ${text} · ${formatDuration(agent.durationMs)}`}
      </text>
      <text fg={C.dim}>
        {`  Tokens: ${agent.totalTokens.toLocaleString()} (in ${agent.inputTokens.toLocaleString()}, out ${agent.outputTokens.toLocaleString()})`}
      </text>
      <text fg={C.dim}>
        {`  Tool Calls: ${agent.toolCalls}`}
        {failed ? ' (' : null}
        {failed ? (
          <span fg={C.green}>{`✓ ${agent.successfulToolCalls}`}</span>
        ) : null}
        {failed ? (
          <span fg={C.red}>{` ✕ ${agent.failedToolCalls}`}</span>
        ) : null}
        {failed ? ')' : null}
      </text>
      {agent.error ? (
        <text fg={C.red}>{`  ${sanitizeTerminalText(agent.error)}`}</text>
      ) : null}
    </box>
  );
}

// ink ArenaSessionCard parity, mirrored helpers (the ink component keeps
// them module-private): diff counts, file lists, and the common/label-only
// file groups compared across agents.
function arenaDiffStats(agent: ArenaAgentCardData): {
  additions: number;
  deletions: number;
} {
  if (agent.diffSummary) {
    return {
      additions: agent.diffSummary.additions,
      deletions: agent.diffSummary.deletions,
    };
  }
  if (!agent.diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of agent.diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

function arenaAgentFiles(agent: ArenaAgentCardData): string[] {
  return (
    agent.modifiedFiles ?? agent.diffSummary?.files.map((f) => f.path) ?? []
  );
}

const ARENA_MAX_FILE_ITEMS = 4;

function arenaFileList(files: string[]): string {
  if (files.length === 0) return 'none';
  const visible = files.slice(0, ARENA_MAX_FILE_ITEMS);
  const suffix =
    files.length > ARENA_MAX_FILE_ITEMS
      ? `, +${files.length - ARENA_MAX_FILE_ITEMS} more`
      : '';
  return `${visible.join(', ')}${suffix}`;
}

function arenaFileGroups(
  agents: ArenaAgentCardData[],
): Array<{ label: string; files: string[] }> {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    for (const file of new Set(arenaAgentFiles(agent))) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  const common = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([file]) => file)
    .sort();
  const groups = [{ label: 'common', files: common }];
  for (const agent of agents) {
    const unique = arenaAgentFiles(agent)
      .filter((file) => counts.get(file) === 1)
      .sort();
    if (unique.length > 0) {
      groups.push({ label: `${agent.label}-only`, files: unique });
    }
  }
  return groups;
}

function ArenaSessionRow({ item }: { item: LiveArenaSessionItem }) {
  const { sessionStatus, agents } = item;
  const comparing = sessionStatus === 'idle' || sessionStatus === 'completed';
  const title = comparing
    ? 'Arena Comparison Summary'
    : sessionStatus === 'cancelled'
      ? 'Arena Cancelled'
      : 'Arena Failed';
  const branch = (index: number, total: number) =>
    index === total - 1 ? '└─' : '├─';
  return (
    <box flexDirection="column">
      <text fg={C.text} attributes={1}>
        {title}
      </text>
      {comparing ? (
        <>
          <text fg={C.text} attributes={1}>
            {'Status Summary:'}
          </text>
          {agents.map((agent, index) => {
            const { text } = getArenaStatusLabel(agent.status);
            return (
              <text key={agent.label} fg={C.dim}>
                {`  ${branch(index, agents.length)} ${sanitizeTerminalText(agent.label)}: `}
                <span fg={arenaStatusColor(agent.status)}>{text}</span>
              </text>
            );
          })}
          <text fg={C.text} attributes={1}>
            {'Files Modified:'}
          </text>
          {arenaFileGroups(agents).map((group, index, groups) => (
            <text key={group.label} fg={C.dim}>
              {`  ${branch(index, groups.length)} ${sanitizeTerminalText(group.label)}: `}
              <span fg={C.text}>
                {sanitizeTerminalText(arenaFileList(group.files))}
              </span>
            </text>
          ))}
          <text fg={C.text} attributes={1}>
            {'Approach Summary:'}
          </text>
          {agents.map((agent, index) => {
            const stats = arenaDiffStats(agent);
            const files = arenaAgentFiles(agent).length;
            const summary =
              agent.approachSummary ?? 'No approach summary available.';
            return (
              <text key={agent.label} fg={C.text}>
                {`  ${branch(index, agents.length)} ${sanitizeTerminalText(agent.label)}: ${sanitizeTerminalText(summary)} `}
                <span fg={C.dim}>
                  {`(${files} ${files === 1 ? 'file' : 'files'}, `}
                </span>
                <span fg={C.green}>{`+${stats.additions}`}</span>
                <span fg={C.dim}> </span>
                <span fg={C.red}>{`-${stats.deletions}`}</span>
                <span fg={C.dim}>{' lines, '}</span>
                <span fg={C.accent}>{agent.toolCalls}</span>
                <span fg={C.dim}>
                  {agent.toolCalls === 1 ? ' tool call)' : ' tool calls)'}
                </span>
              </text>
            );
          })}
          <text fg={C.text} attributes={1}>
            {'Token Efficiency:'}
          </text>
          {agents.map((agent, index) => (
            <text key={agent.label} fg={C.dim}>
              {`  ${branch(index, agents.length)} ${sanitizeTerminalText(agent.label)}: `}
              <span fg={C.text}>
                {`${agent.outputTokens.toLocaleString()} tokens · runtime ${formatDuration(agent.durationMs)}`}
              </span>
            </text>
          ))}
        </>
      ) : null}
      {comparing ? (
        <text fg={C.dim}>
          {'Run '}
          <span fg={C.accent}>{'/arena select'}</span>
          {sessionStatus === 'idle'
            ? ' to view detailed diff or pick a winner.'
            : ' to pick a winner.'}
        </text>
      ) : null}
    </box>
  );
}
