/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import {
  type AnsiCode,
  ansiCodesToString,
  diffAnsiCodes,
} from '@alcalzone/ansi-tokenize';
import { logForDebugging } from './stubs/debug.js';
import type {
  Diff,
  Frame,
  RendererResetReason,
  ViewportResetReason,
} from './frame.js';
import type { Point } from './layout/geometry.js';
import {
  type Cell,
  CellWidth,
  cellAt,
  diffEach,
  type Hyperlink,
  isEmptyCellAt,
  type StylePool,
  shiftRows,
  visibleCellAtIndex,
} from './screen.js';
import {
  CURSOR_HOME,
  eraseToEndOfLine,
  scrollDown as csiScrollDown,
  scrollUp as csiScrollUp,
  RESET_SCROLL_REGION,
  setScrollRegion,
} from './termio/csi.js';
import { LINK_END, link as oscLink } from './termio/osc.js';

type State = {
  previousOutput: string;
};

type Options = {
  isTTY: boolean;
  stylePool: StylePool;
};

type PendingReset =
  | {
      strategy: 'preserve-scrollback';
      reason: ViewportResetReason;
    }
  | {
      strategy: 'replace-transcript';
      reason: 'transcript-switch';
    };

const CARRIAGE_RETURN = { type: 'carriageReturn' } as const;
const NEWLINE = { type: 'stdout', content: '\n' } as const;
const ERASE_TO_END_OF_LINE = {
  type: 'stdout',
  content: eraseToEndOfLine(),
} as const;

export class LogUpdate {
  private state: State;
  private pendingReset: PendingReset | null = null;
  // A tall transient surface can scroll a stable transcript prefix out of
  // reach. Keep that prefix in native scrollback after the surface closes.
  private viewportStart = 0;

  constructor(private readonly options: Options) {
    this.state = {
      previousOutput: '',
    };
  }

  renderPreviousOutput_DEPRECATED(prevFrame: Frame): Diff {
    if (!this.options.isTTY) {
      // Non-TTY output is no longer supported (string output was removed)
      return [NEWLINE];
    }
    return this.getRenderOpsForDone(prevFrame);
  }

  // Called when process resumes from suspension (SIGCONT) to prevent clobbering terminal content
  reset(): void {
    this.state.previousOutput = '';
    this.viewportStart = 0;
  }

  forceReset(reason: ViewportResetReason = 'recovery'): void {
    this.pendingReset = { strategy: 'preserve-scrollback', reason };
  }

  forceTranscriptReplacement(): void {
    this.pendingReset = {
      strategy: 'replace-transcript',
      reason: 'transcript-switch',
    };
  }

  private renderFullFrame(frame: Frame): Diff {
    const { screen } = frame;
    const lines: string[] = [];
    let currentStyles: AnsiCode[] = [];
    let currentHyperlink: Hyperlink = undefined;
    for (let y = 0; y < screen.height; y++) {
      let line = '';
      for (let x = 0; x < screen.width; x++) {
        const cell = cellAt(screen, x, y);
        if (cell && cell.width !== CellWidth.SpacerTail) {
          // Handle hyperlink transitions
          if (cell.hyperlink !== currentHyperlink) {
            if (currentHyperlink !== undefined) {
              line += LINK_END;
            }
            if (cell.hyperlink !== undefined) {
              line += oscLink(cell.hyperlink);
            }
            currentHyperlink = cell.hyperlink;
          }
          const cellStyles = this.options.stylePool.get(cell.styleId);
          const styleDiff = diffAnsiCodes(currentStyles, cellStyles);
          if (styleDiff.length > 0) {
            line += ansiCodesToString(styleDiff);
            currentStyles = cellStyles;
          }
          line += cell.char;
        }
      }
      // Close any open hyperlink before resetting styles
      if (currentHyperlink !== undefined) {
        line += LINK_END;
        currentHyperlink = undefined;
      }
      // Reset styles at end of line so trimEnd doesn't leave dangling codes
      const resetCodes = diffAnsiCodes(currentStyles, []);
      if (resetCodes.length > 0) {
        line += ansiCodesToString(resetCodes);
        currentStyles = [];
      }
      lines.push(line.trimEnd());
    }

    if (lines.length === 0) {
      return [];
    }
    return [{ type: 'stdout', content: lines.join('\n') }];
  }

  private getRenderOpsForDone(prev: Frame): Diff {
    this.state.previousOutput = '';

    if (!prev.cursor.visible) {
      return [{ type: 'cursorShow' }];
    }
    return [];
  }

  render(
    prev: Frame,
    next: Frame,
    altScreen = false,
    decstbmSafe = true,
  ): Diff {
    const diff = this.renderFrame(prev, next, altScreen, decstbmSafe);
    const naturalStart = Math.max(
      0,
      next.screen.height - next.viewport.height +
        (next.cursor.y >= next.screen.height ? 1 : 0),
    );
    if (
      diff.some((patch) => patch.type === 'clearTerminal') ||
      naturalStart >= this.viewportStart
    ) {
      this.viewportStart = 0;
    }
    return diff;
  }

  private renderFrame(
    prev: Frame,
    next: Frame,
    altScreen: boolean,
    decstbmSafe: boolean,
  ): Diff {
    if (!this.options.isTTY) {
      return this.renderFullFrame(next);
    }

    const startTime = performance.now();
    const stylePool = this.options.stylePool;
    const prevHeight = prev.screen.height;
    const nextHeight = next.screen.height;
    const prevViewportHeight = prev.viewport.height;
    const nextViewportHeight = next.viewport.height;
    const heightDelta =
      Math.max(nextHeight, 1) - Math.max(prevHeight, 1);
    const shrinking = heightDelta < 0;
    const growing = heightDelta > 0;
    const previousOverflowed =
      prev.cursor.y >= prevHeight && prevHeight >= prevViewportHeight;
    const cursorRestoreScroll = previousOverflowed ? 1 : 0;
    const visibleStart = Math.max(
      this.viewportStart,
      growing
        ? prevHeight - prevViewportHeight + cursorRestoreScroll
        : Math.max(prevHeight, nextHeight) -
            nextViewportHeight +
            cursorRestoreScroll,
    );
    const overflowHint =
      Math.max(
        this.viewportStart,
        Math.max(
          0,
          prevHeight - Math.min(prevViewportHeight, nextViewportHeight),
        ) + (prevHeight >= prevViewportHeight ? 1 : 0),
      );

    const forcedReset = this.pendingReset;
    this.pendingReset = null;
    const widthChanged =
      prev.viewport.width !== 0 &&
      next.viewport.width !== prev.viewport.width;
    const heightChanged =
      prevViewportHeight !== 0 && nextViewportHeight !== prevViewportHeight;
    const resizeRequested = widthChanged || heightChanged;

    if (resizeRequested) {
      return buildDestructiveResetPatches(
        next,
        'resize',
        altScreen,
        stylePool,
      );
    }

    if (forcedReset?.strategy === 'replace-transcript') {
      return buildDestructiveResetPatches(
        next,
        forcedReset.reason,
        altScreen,
        stylePool,
      );
    }

    if (forcedReset !== null) {
      return this.renderViewportReset(
        prev,
        next,
        forcedReset.reason,
        altScreen,
        overflowHint,
      );
    }

    // DECSTBM scroll optimization: when a ScrollBox's scrollTop changed,
    // shift content with a hardware scroll (CSI top;bot r + CSI n S/T)
    // instead of rewriting the whole scroll region. The shiftRows on
    // prev.screen simulates the shift so the diff loop below naturally
    // finds only the rows that scrolled IN as diffs. prev.screen is
    // about to become backFrame (reused next render) so mutation is safe.
    // CURSOR_HOME after RESET_SCROLL_REGION is defensive — DECSTBM reset
    // homes cursor per spec but terminal implementations vary.
    //
    // decstbmSafe: caller passes false when the DECSTBM→diff sequence
    // can't be made atomic (no DEC 2026 / BSU/ESU). Without atomicity the
    // outer terminal renders the intermediate state — region scrolled,
    // edge rows not yet painted — a visible vertical jump on every frame
    // where scrollTop moves. Falling through to the diff loop writes all
    // shifted rows: more bytes, no intermediate state. next.screen from
    // render-node-to-output's blit+shift is correct either way.
    let scrollPatch: Diff = [];
    if (altScreen && next.scrollHint && decstbmSafe) {
      const { top, bottom, delta } = next.scrollHint;
      if (
        top >= 0 &&
        bottom < prev.screen.height &&
        bottom < next.screen.height
      ) {
        shiftRows(prev.screen, top, bottom, delta);
        scrollPatch = [
          {
            type: 'stdout',
            content:
              setScrollRegion(top + 1, bottom + 1) +
              (delta > 0 ? csiScrollUp(delta) : csiScrollDown(-delta)) +
              RESET_SCROLL_REGION +
              CURSOR_HOME,
          },
        ];
      }
    }

    const linesToClear = shrinking ? prevHeight - nextHeight : 0;
    if (
      shrinking &&
      (linesToClear > nextViewportHeight ||
        (previousOverflowed && nextHeight <= nextViewportHeight))
    ) {
      return this.renderViewportReset(
        prev,
        next,
        'offscreen',
        altScreen,
        overflowHint,
      );
    }

    const screen = new VirtualScreen(prev.cursor, next.viewport.width);

    // Handle a reachable tail shrink before applying cell diffs.
    if (shrinking) {
      // clear(N) moves cursor UP by N-1 lines and to column 0
      // This puts us at line prev.screen.height - N = next.screen.height
      // But we want to be at next.screen.height - 1 (bottom of new screen)
      screen.txn((prev) => [
        [
          { type: 'clear', count: linesToClear },
          { type: 'cursorMove', x: 0, y: -1 },
        ],
        { dx: -prev.x, dy: -linesToClear },
      ]);
    }

    let currentStyleId = stylePool.none;
    let currentHyperlink: Hyperlink = undefined;
    let currentRow = -1;
    let lastNonEmptyColumn = -1;
    let tailScanned = false;
    let tailErased = false;

    let needsViewportReset = false;
    let retainedPrefixChanged = false;
    let visibleRowsChanged = false;
    // First pass: render changes to existing rows (rows < prev.screen.height)
    diffEach(prev.screen, next.screen, (x, y, removed, added) => {
      // Skip new rows - we'll render them directly after
      if (growing && y >= prev.screen.height) {
        visibleRowsChanged = true;
        return false;
      }

      // Skip spacers during rendering because the terminal will automatically
      // advance 2 columns when we write the wide character itself.
      // SpacerTail: Second cell of a wide character
      // SpacerHead: Marks line-end position where wide char wraps to next line
      if (
        added &&
        (added.width === CellWidth.SpacerTail ||
          added.width === CellWidth.SpacerHead)
      ) {
        return false;
      }

      if (
        removed &&
        (removed.width === CellWidth.SpacerTail ||
          removed.width === CellWidth.SpacerHead) &&
        !added
      ) {
        return false;
      }

      // Skip empty cells that don't need to overwrite existing content.
      // This prevents writing trailing spaces that would cause unnecessary
      // line wrapping at the edge of the screen.
      // Uses isEmptyCellAt to check if both packed words are zero (empty cell).
      if (added && isEmptyCellAt(next.screen, x, y) && !removed) {
        return false;
      }

      // Native scrollback rows cannot be addressed with cursor movement. In
      // steady-state main-screen rendering they are immutable snapshots, so
      // skip the physical write while still advancing the logical frame. A
      // shrink can bring those rows back into view and therefore rebuilds the
      // active viewport instead. Alternate screen has no snapshot semantics.
      if (y < this.viewportStart) {
        retainedPrefixChanged = true;
      }
      if (y < visibleStart) {
        if (altScreen || shrinking) {
          needsViewportReset = true;
          return true;
        }
        return false;
      }
      visibleRowsChanged = true;

      if (y !== currentRow) {
        currentHyperlink = transitionHyperlink(
          screen.diff,
          currentHyperlink,
          undefined,
        );
        currentRow = y;
        lastNonEmptyColumn = -1;
        tailScanned = false;
        tailErased = false;
      }

      // A run of removed cells at the end of a row must clear the whole
      // physical tail, not only cells that existed in the previous logical
      // frame. The physical row may contain older, longer styled content after
      // a scrollback-preserving layout shift. CSI K repairs that tail once.
      if (removed && isEmptyCellAt(next.screen, x, y)) {
        if (!tailScanned) {
          tailScanned = true;
          if (y < next.screen.height) {
            for (let column = next.screen.width - 1; column > x; column--) {
              if (!isEmptyCellAt(next.screen, column, y)) {
                lastNonEmptyColumn = column;
                break;
              }
            }
          }
        }

        if (x > lastNonEmptyColumn) {
          if (tailErased) {
            return false;
          }
          tailErased = true;
          currentStyleId = transitionStyle(
            screen.diff,
            stylePool,
            currentStyleId,
            stylePool.none,
          );
          currentHyperlink = transitionHyperlink(
            screen.diff,
            currentHyperlink,
            undefined,
          );
          moveCursorTo(screen, x, y);
          screen.diff.push(ERASE_TO_END_OF_LINE);
          return false;
        }
      }

      // Reset active SGR before cursor movement. When moving to a
      // non-adjacent cell, the terminal emits CSI C (cursor forward).
      // Some terminals (Terminal.app) paint skipped positions with
      // whatever SGR state is active, causing color bleed artifacts.
      if (currentStyleId !== stylePool.none) {
        currentStyleId = transitionStyle(
          screen.diff,
          stylePool,
          currentStyleId,
          stylePool.none,
        );
      }

      moveCursorTo(screen, x, y);

      if (added) {
        const targetHyperlink = added.hyperlink;
        currentHyperlink = transitionHyperlink(
          screen.diff,
          currentHyperlink,
          targetHyperlink,
        );
        const styleStr = stylePool.transition(currentStyleId, added.styleId);
        if (writeCellWithStyleStr(screen, added, styleStr)) {
          currentStyleId = added.styleId;
        }
      } else if (removed) {
        // Cell was removed - clear it with a space
        // (This handles shrinking content)
        // Reset any active styles/hyperlinks first to avoid leaking into cleared cells
        const styleIdToReset = currentStyleId;
        const hyperlinkToReset = currentHyperlink;
        currentStyleId = stylePool.none;
        currentHyperlink = undefined;

        screen.txn(() => {
          const patches: Diff = [];
          transitionStyle(patches, stylePool, styleIdToReset, stylePool.none);
          transitionHyperlink(patches, hyperlinkToReset, undefined);
          patches.push({ type: 'stdout', content: ' ' });
          return [patches, { dx: 1, dy: 0 }];
        });
      }
      return false;
    });
    // An unchanged height can hide a history-window shift behind a growing
    // live surface. If both the retained prefix and visible rows changed,
    // recover their mapping before writing relative cursor movements. A
    // prefix-only update still keeps the native scrollback snapshot intact.
    if (
      needsViewportReset ||
      (retainedPrefixChanged && visibleRowsChanged)
    ) {
      return this.renderViewportReset(
        prev,
        next,
        'offscreen',
        altScreen,
        overflowHint,
      );
    }

    // Reset styles before rendering new rows (they'll set their own styles)
    currentStyleId = transitionStyle(
      screen.diff,
      stylePool,
      currentStyleId,
      stylePool.none,
    );
    currentHyperlink = transitionHyperlink(
      screen.diff,
      currentHyperlink,
      undefined,
    );

    // Handle growth: render new rows directly (they naturally scroll the terminal)
    if (growing) {
      renderFrameSlice(
        screen,
        next,
        prev.screen.height,
        next.screen.height,
        stylePool,
      );
    }

    restoreCursor(screen, next, altScreen);

    const elapsed = performance.now() - startTime;
    if (elapsed > 50) {
      const damage = next.screen.damage;
      const damageInfo = damage
        ? `${damage.width}x${damage.height} at (${damage.x},${damage.y})`
        : 'none';
      logForDebugging(
        `Slow render: ${elapsed.toFixed(1)}ms, screen: ${next.screen.height}x${next.screen.width}, damage: ${damageInfo}, changes: ${screen.diff.length}`,
      );
    }

    return scrollPatch.length > 0
      ? [...scrollPatch, ...screen.diff]
      : screen.diff;
  }

  private renderViewportReset(
    prev: Frame,
    next: Frame,
    reason: ViewportResetReason,
    altScreen: boolean,
    overflowHint: number,
  ): Diff {
    let unchangedPrefixRows = 0;
    if (
      !altScreen &&
      prev.screen.width === next.screen.width
    ) {
      unchangedPrefixRows = Math.min(prev.screen.height, next.screen.height);
      diffEach(prev.screen, next.screen, (_x, y) => {
        unchangedPrefixRows = y;
        return true;
      });
    }
    const visibleTailStart = Math.min(
      overflowHint,
      Math.max(0, next.screen.height - next.viewport.height + 1),
    );
    const startY = altScreen
      ? 0
      : Math.max(
          visibleTailStart,
          // Preserve unchanged scrollback before the first changed row.
          // A pure tail removal has no changed row to anchor the live area;
          // retain its existing viewport recovery instead of hiding controls.
          unchangedPrefixRows < next.screen.height
            ? Math.min(overflowHint, unchangedPrefixRows)
            : this.viewportStart < next.screen.height
              ? this.viewportStart
              : 0,
        );
    this.viewportStart = startY;
    return buildViewportResetPatches(
      next,
      reason,
      altScreen,
      startY,
      this.options.stylePool,
    );
  }
}

function transitionHyperlink(
  diff: Diff,
  current: Hyperlink,
  target: Hyperlink,
): Hyperlink {
  if (current !== target) {
    diff.push({ type: 'hyperlink', uri: target ?? '' });
    return target;
  }
  return current;
}

function transitionStyle(
  diff: Diff,
  stylePool: StylePool,
  currentId: number,
  targetId: number,
): number {
  const str = stylePool.transition(currentId, targetId);
  if (str.length > 0) {
    diff.push({ type: 'styleStr', str });
  }
  return targetId;
}

function buildViewportResetPatches(
  frame: Frame,
  reason: ViewportResetReason,
  altScreen: boolean,
  startY: number,
  stylePool: StylePool,
): Diff {
  const rendered = renderResetSlice(
    frame,
    startY,
    altScreen,
    stylePool,
  );

  const resetPatch: Diff[number] = altScreen
    ? { type: 'clearTerminal', reason }
    : {
        type: 'eraseViewport',
        rows: frame.viewport.height,
        reason,
      };

  return [
    resetPatch,
    ...rendered,
  ];
}

function buildDestructiveResetPatches(
  frame: Frame,
  reason: RendererResetReason,
  altScreen: boolean,
  stylePool: StylePool,
): Diff {
  return [
    { type: 'clearTerminal', reason },
    ...renderResetSlice(frame, 0, altScreen, stylePool),
  ];
}

function renderResetSlice(
  frame: Frame,
  startY: number,
  altScreen: boolean,
  stylePool: StylePool,
): Diff {
  // A reset establishes physical viewport (0, 0). Track that cursor in
  // logical frame coordinates so all following relative movement is exact.
  const screen = new VirtualScreen(
    { x: 0, y: startY },
    frame.viewport.width,
  );
  renderFrameSlice(screen, frame, startY, frame.screen.height, stylePool);
  restoreCursor(screen, frame, altScreen);
  return screen.diff;
}

function restoreCursor(
  screen: VirtualScreen,
  frame: Frame,
  altScreen: boolean,
): void {
  // Alt-screen starts each frame from CSI H and parks the cursor separately.
  if (altScreen) return;

  if (frame.cursor.y >= frame.screen.height) {
    screen.txn((prev) => {
      const rowsToCreate = frame.cursor.y - prev.y;
      if (rowsToCreate > 0) {
        const patches: Diff = new Array<Diff[number]>(1 + rowsToCreate);
        patches[0] = CARRIAGE_RETURN;
        for (let i = 0; i < rowsToCreate; i++) {
          patches[1 + i] = NEWLINE;
        }
        return [patches, { dx: -prev.x, dy: rowsToCreate }];
      }

      const dy = frame.cursor.y - prev.y;
      if (dy !== 0 || prev.x !== frame.cursor.x) {
        return [
          [
            CARRIAGE_RETURN,
            { type: 'cursorMove', x: frame.cursor.x, y: dy },
          ],
          { dx: frame.cursor.x - prev.x, dy },
        ];
      }
      return [[], { dx: 0, dy: 0 }];
    });
    return;
  }

  moveCursorTo(screen, frame.cursor.x, frame.cursor.y);
}

/**
 * Render a slice of rows from the frame's screen.
 * Each row is rendered followed by a newline. Cursor ends at (0, endY).
 */
function renderFrameSlice(
  screen: VirtualScreen,
  frame: Frame,
  startY: number,
  endY: number,
  stylePool: StylePool,
): VirtualScreen {
  let currentStyleId = stylePool.none;
  let currentHyperlink: Hyperlink = undefined;
  // Track the styleId of the last rendered cell on this line (-1 if none).
  // Passed to visibleCellAtIndex to enable fg-only space optimization.
  let lastRenderedStyleId = -1;

  const { width: screenWidth, cells, charPool, hyperlinkPool } = frame.screen;

  let index = startY * screenWidth;
  for (let y = startY; y < endY; y += 1) {
    // Advance cursor to this row using LF (not CSI CUD / cursor-down).
    // CSI CUD stops at the viewport bottom margin and cannot scroll,
    // but LF scrolls the viewport to create new lines. Without this,
    // when the cursor is at the viewport bottom, moveCursorTo's
    // cursor-down silently fails, creating a permanent off-by-one
    // between the virtual cursor and the real terminal cursor.
    if (screen.cursor.y < y) {
      const rowsToAdvance = y - screen.cursor.y;
      screen.txn((prev) => {
        const patches: Diff = new Array<Diff[number]>(1 + rowsToAdvance);
        patches[0] = CARRIAGE_RETURN;
        for (let i = 0; i < rowsToAdvance; i++) {
          patches[1 + i] = NEWLINE;
        }
        return [patches, { dx: -prev.x, dy: rowsToAdvance }];
      });
    }
    // Reset at start of each line — no cell rendered yet
    lastRenderedStyleId = -1;

    for (let x = 0; x < screenWidth; x += 1, index += 1) {
      // Skip spacers, unstyled empty cells, and fg-only styled spaces that
      // match the last rendered style (since cursor-forward produces identical
      // visual result). visibleCellAtIndex handles the optimization internally
      // to avoid allocating Cell objects for skipped cells.
      const cell = visibleCellAtIndex(
        cells,
        charPool,
        hyperlinkPool,
        index,
        lastRenderedStyleId,
      );
      if (!cell) {
        // Reset active SGR before skipping. When the next visible cell
        // triggers moveCursorTo → CSI C (cursor forward), some terminals
        // (notably Terminal.app) paint the skipped positions with whatever
        // SGR state is active. Resetting here ensures cursor-forward
        // traverses only default-styled cells, preventing color bleed.
        if (currentStyleId !== stylePool.none) {
          currentStyleId = transitionStyle(
            screen.diff,
            stylePool,
            currentStyleId,
            stylePool.none,
          );
        }
        continue;
      }

      moveCursorTo(screen, x, y);

      // Handle hyperlink
      const targetHyperlink = cell.hyperlink;
      currentHyperlink = transitionHyperlink(
        screen.diff,
        currentHyperlink,
        targetHyperlink,
      );

      // Style transition — cached string, zero allocations after warmup
      const styleStr = stylePool.transition(currentStyleId, cell.styleId);
      if (writeCellWithStyleStr(screen, cell, styleStr)) {
        currentStyleId = cell.styleId;
        lastRenderedStyleId = cell.styleId;
      }
    }
    // Reset styles/hyperlinks before newline so background color doesn't
    // bleed into the next line when the terminal scrolls. The old code
    // reset implicitly by writing trailing unstyled spaces; now that we
    // skip empty cells, we must reset explicitly.
    currentStyleId = transitionStyle(
      screen.diff,
      stylePool,
      currentStyleId,
      stylePool.none,
    );
    currentHyperlink = transitionHyperlink(
      screen.diff,
      currentHyperlink,
      undefined,
    );
    // CR+LF at end of row — \r resets to column 0, \n moves to next line.
    // Without \r, the terminal cursor stays at whatever column content ended
    // (since we skip trailing spaces, this can be mid-row).
    screen.txn((prev) => [[CARRIAGE_RETURN, NEWLINE], { dx: -prev.x, dy: 1 }]);
  }

  // Reset any open style/hyperlink at end of slice
  transitionStyle(screen.diff, stylePool, currentStyleId, stylePool.none);
  transitionHyperlink(screen.diff, currentHyperlink, undefined);

  return screen;
}

type Delta = { dx: number; dy: number };

/**
 * Write a cell with a pre-serialized style transition string (from
 * StylePool.transition). Inlines the txn logic to avoid closure/tuple/delta
 * allocations on every cell.
 *
 * Returns true if the cell was written, false if skipped (wide char at
 * viewport edge). Callers MUST gate currentStyleId updates on this — when
 * skipped, styleStr is never pushed and the terminal's style state is
 * unchanged. Updating the virtual tracker anyway desyncs it from the
 * terminal, and the next transition is computed from phantom state.
 */
function writeCellWithStyleStr(
  screen: VirtualScreen,
  cell: Cell,
  styleStr: string,
): boolean {
  const cellWidth = cell.width === CellWidth.Wide ? 2 : 1;
  const px = screen.cursor.x;
  const vw = screen.viewportWidth;

  // Don't write wide chars that would cross the viewport edge.
  // Single-codepoint chars (CJK) at vw-2 are safe; multi-codepoint
  // graphemes (flags, ZWJ emoji) need stricter threshold.
  if (cellWidth === 2 && px < vw) {
    const threshold = cell.char.length > 2 ? vw : vw + 1;
    if (px + 2 >= threshold) {
      return false;
    }
  }

  const diff = screen.diff;
  if (styleStr.length > 0) {
    diff.push({ type: 'styleStr', str: styleStr });
  }

  const needsCompensation =
    cellWidth === 2 && needsWidthCompensation(cell.char);

  // On terminals with old wcwidth tables, a compensated emoji only advances
  // the cursor 1 column, so the CHA below skips column x+1 without painting
  // it. Write a styled space there first — on correct terminals the emoji
  // glyph (width 2) overwrites it harmlessly; on old terminals it fills the
  // gap with the emoji's background. Also clears any stale content at x+1.
  // CHA is 1-based, so column px+1 (0-based) is CHA target px+2.
  if (needsCompensation && px + 1 < vw) {
    diff.push({ type: 'cursorTo', col: px + 2 });
    diff.push({ type: 'stdout', content: ' ' });
    diff.push({ type: 'cursorTo', col: px + 1 });
  }

  diff.push({ type: 'stdout', content: cell.char });

  // Force terminal cursor to correct column after the emoji.
  if (needsCompensation) {
    diff.push({ type: 'cursorTo', col: px + cellWidth + 1 });
  }

  // Update cursor — mutate in place to avoid Point allocation
  if (px >= vw) {
    screen.cursor.x = cellWidth;
    screen.cursor.y++;
  } else {
    screen.cursor.x = px + cellWidth;
  }
  return true;
}

function moveCursorTo(screen: VirtualScreen, targetX: number, targetY: number) {
  screen.txn((prev) => {
    const dx = targetX - prev.x;
    const dy = targetY - prev.y;
    const inPendingWrap = prev.x >= screen.viewportWidth;

    // If we're in pending wrap state (cursor.x >= width), use CR
    // to reset to column 0 on the current line without advancing
    // to the next line, then issue the cursor movement.
    if (inPendingWrap) {
      return [
        [CARRIAGE_RETURN, { type: 'cursorMove', x: targetX, y: dy }],
        { dx, dy },
      ];
    }

    // When moving to a different line, use carriage return (\r) to reset to
    // column 0 first, then cursor move.
    if (dy !== 0) {
      return [
        [CARRIAGE_RETURN, { type: 'cursorMove', x: targetX, y: dy }],
        { dx, dy },
      ];
    }

    if (dx !== 0) {
      return [[{ type: 'cursorTo', col: targetX + 1 }], { dx, dy }];
    }

    return [[], { dx: 0, dy: 0 }];
  });
}

/**
 * Identify emoji where the terminal's wcwidth may disagree with Unicode.
 * On terminals with correct tables, the CHA we emit is a harmless no-op.
 *
 * Two categories:
 * 1. Newer emoji (Unicode 12.0+) missing from terminal wcwidth tables.
 * 2. Text-by-default emoji + VS16 (U+FE0F): the base codepoint is width 1
 *    in wcwidth, but VS16 triggers emoji presentation making it width 2.
 *    Examples: ⚔️ (U+2694), ☠️ (U+2620), ❤️ (U+2764).
 */
function needsWidthCompensation(char: string): boolean {
  const cp = char.codePointAt(0);
  if (cp === undefined) return false;
  // U+1FA70-U+1FAFF: Symbols and Pictographs Extended-A (Unicode 12.0-15.0)
  // U+1FB00-U+1FBFF: Symbols for Legacy Computing (Unicode 13.0)
  if ((cp >= 0x1fa70 && cp <= 0x1faff) || (cp >= 0x1fb00 && cp <= 0x1fbff)) {
    return true;
  }
  // Text-by-default emoji with VS16: scan for U+FE0F in multi-codepoint
  // graphemes. Single BMP chars (length 1) and surrogate pairs without VS16
  // skip this check. VS16 (0xFE0F) can't collide with surrogates (0xD800-0xDFFF).
  if (char.length >= 2) {
    for (let i = 0; i < char.length; i++) {
      if (char.charCodeAt(i) === 0xfe0f) return true;
    }
  }
  return false;
}

class VirtualScreen {
  // Public for direct mutation by writeCellWithStyleStr (avoids txn overhead).
  // File-private class — not exposed outside log-update.ts.
  cursor: Point;
  diff: Diff = [];

  constructor(
    origin: Point,
    readonly viewportWidth: number,
  ) {
    this.cursor = { ...origin };
  }

  txn(fn: (prev: Point) => [patches: Diff, next: Delta]): void {
    const [patches, next] = fn(this.cursor);
    for (const patch of patches) {
      this.diff.push(patch);
    }
    this.cursor.x += next.dx;
    this.cursor.y += next.dy;
  }
}
