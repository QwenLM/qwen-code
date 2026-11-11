/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { Writable } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import type { Diff, Frame } from './frame.js';
import { LogUpdate } from './log-update.js';
import {
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from './screen.js';
import { writeDiffToTerminal, type Terminal } from './terminal.js';
import { PhysicalTerminalModel } from './testing/physical-terminal-model.js';
import { eraseToEndOfLine } from './termio/csi.js';
import { LINK_END } from './termio/osc.js';

type FrameOptions = {
  height: number;
  viewportHeight: number;
  width?: number;
  viewportWidth?: number;
  lines?: string[];
  backgroundRows?: number[];
  hyperlinkRows?: number[];
  cursorX?: number;
  cursorY?: number;
};

function createHarness() {
  const stylePool = new StylePool();
  const charPool = new CharPool();
  const hyperlinkPool = new HyperlinkPool();
  const backgroundStyleId = stylePool.intern([
    {
      type: 'ansi',
      code: '\x1b[48;2;52;56;58m',
      endCode: '\x1b[49m',
    },
  ]);

  const frame = ({
    height,
    viewportHeight,
    width = 10,
    viewportWidth = width,
    lines = [],
    backgroundRows = [],
    hyperlinkRows = [],
    cursorX = 0,
    cursorY = height,
  }: FrameOptions): Frame => {
    const screen = createScreen(
      width,
      height,
      stylePool,
      charPool,
      hyperlinkPool,
    );

    const backgroundRowSet = new Set(backgroundRows);
    const hyperlinkRowSet = new Set(hyperlinkRows);
    for (let y = 0; y < Math.min(lines.length, height); y++) {
      const line = lines[y] ?? '';
      const hasBackground = backgroundRowSet.has(y);
      const columnsToWrite = hasBackground
        ? width
        : Math.min(line.length, width);
      for (let x = 0; x < columnsToWrite; x++) {
        setCellAt(screen, x, y, {
          char: line[x] ?? ' ',
          styleId: hasBackground ? backgroundStyleId : stylePool.none,
          width: CellWidth.Narrow,
          hyperlink: hyperlinkRowSet.has(y)
            ? 'https://example.com/row'
            : undefined,
        });
      }
    }

    return {
      screen,
      viewport: { width: viewportWidth, height: viewportHeight },
      cursor: { x: cursorX, y: cursorY, visible: true },
    };
  };

  return {
    frame,
    log: new LogUpdate({ isTTY: true, stylePool }),
    stylePool,
  };
}

function hasPatch<T extends Diff[number]['type']>(
  diff: Diff,
  type: T,
): boolean {
  return diff.some((patch) => patch.type === type);
}

function stdoutContent(diff: Diff): string {
  return diff
    .filter((patch) => patch.type === 'stdout')
    .map((patch) => patch.content)
    .join('');
}

function serialize(diff: Diff): string {
  let output = '';
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const terminal: Terminal = { stdout: sink, stderr: new Writable() };
  writeDiffToTerminal(terminal, diff, true);
  return output;
}

function writeToHeadlessTerminal(
  terminal: HeadlessTerminal,
  output: string,
): Promise<void> {
  return new Promise((resolve) => terminal.write(output, resolve));
}

function readHeadlessTerminalLines(terminal: HeadlessTerminal): string[] {
  const buffer = terminal.buffer.active;
  return Array.from({ length: buffer.length }, (_, index) =>
    buffer.getLine(index)?.translateToString(true) ?? '',
  );
}

const RESIZE_REPLAY_TEXT =
  'I need to inspect a long render frame while the terminal repeatedly changes width without retaining stale wrapped snapshots.';

function buildResizeReplayLines(width: number): string[] {
  const contentWidth = Math.max(1, width - 2);
  const wrapped: string[] = [];
  for (let index = 0; index < RESIZE_REPLAY_TEXT.length; index += contentWidth) {
    wrapped.push(RESIZE_REPLAY_TEXT.slice(index, index + contentWidth));
  }

  return [
    ...Array.from({ length: 8 }, (_, index) => `history-${index}`),
    'Thinking',
    ...wrapped,
    'Bash(git diff --stat)',
    'input',
    'status',
  ];
}

describe('LogUpdate main-screen scrollback protocol', () => {
  it.each([
    { explicitReset: false, longHistory: false },
    { explicitReset: true, longHistory: false },
    { explicitReset: false, longHistory: true },
    { explicitReset: true, longHistory: true },
  ])(
    'does not replay committed history when a tall approval closes (reset: $explicitReset, long history: $longHistory)',
    async ({ explicitReset, longHistory }) => {
      const { frame, log } = createHarness();
      const width = 80;
      const rows = 30;
      const terminal = new HeadlessTerminal({
        cols: width,
        rows,
        allowProposedApi: true,
        scrollback: 2000,
      });
      const history = [
        'WELCOME_HEADER', '/goal snake', 'Thinking',
        ...(longHistory ? Array.from({ length: 56 }, (_, i) => `COMMITTED_REPLY_${i}`) : []),
        'Bash(ls)',
      ];
      const options = { viewportHeight: rows, width };
      const before = frame({ ...options, height: history.length + 1, lines: [...history, 'input'] });
      const approvalLines = [
        ...history,
        ...Array.from({ length: 440 }, (_, i) => `DIFF_LINE_${i + 1}`),
        'Apply this change?',
      ];
      const approval = frame({
        ...options,
        height: approvalLines.length,
        lines: approvalLines,
      });
      const afterLines = [...history, 'Write(index.html) running', 'input'];
      const after = frame({ ...options, height: afterLines.length, lines: afterLines });
      try {
        await writeToHeadlessTerminal(terminal, 'SHELL_HISTORY\r\n');
        await writeToHeadlessTerminal(terminal, serialize(log.render(
          frame({ ...options, height: 0 }), before,
        )));
        await writeToHeadlessTerminal(terminal, serialize(log.render(before, approval)));
        if (explicitReset) log.forceReset('recovery');
        const diff = log.render(approval, after);
        expect(hasPatch(diff, 'eraseViewport')).toBe(true);
        expect(hasPatch(diff, 'clearTerminal')).toBe(false);
        expect(stdoutContent(diff)).not.toContain('WELCOME_HEADER');
        expect(stdoutContent(diff)).not.toContain('Bash(ls)');
        await writeToHeadlessTerminal(terminal, serialize(diff));

        let lines = readHeadlessTerminalLines(terminal).filter(Boolean);
        expect(lines.filter((line) => line === 'WELCOME_HEADER')).toHaveLength(1);
        expect(lines.filter((line) => line === 'Bash(ls)')).toHaveLength(1);
        expect(lines).toContain('SHELL_HISTORY');
        expect(lines).toContain('DIFF_LINE_400');
        expect(lines.slice(-2)).toEqual(['Write(index.html) running', 'input']);

        // Keep rendering after the shortened logical frame. Its committed
        // prefix still lives in scrollback, not at the top of the viewport.
        const continuedLines = [
          ...history,
          'Write(index.html) done',
          'The snake game is ready.',
          'input',
        ];
        const continued = frame({
          ...options, height: continuedLines.length, lines: continuedLines,
        });
        await writeToHeadlessTerminal(terminal, serialize(log.render(after, continued)));
        log.forceReset('recovery');
        await writeToHeadlessTerminal(terminal, serialize(log.render(continued, continued)));
        lines = readHeadlessTerminalLines(terminal).filter(Boolean);
        expect(lines.filter((line) => line === 'WELCOME_HEADER')).toHaveLength(1);
        expect(lines.slice(-3)).toEqual(continuedLines.slice(-3));
        expect(log.render(continued, continued)).toEqual([]);

        const offscreenChanged = frame({
          ...options,
          height: continuedLines.length,
          lines: ['UPDATED_HEADER', ...continuedLines.slice(1)],
        });
        expect(log.render(continued, offscreenChanged)).toEqual([]);

        // Grow past a full viewport again. The logical and physical cursors
        // must stay aligned when the shortened frame resumes normal scrolling.
        const grownLines = [
          'UPDATED_HEADER', ...history.slice(1),
          ...Array.from({ length: 40 }, (_, i) => `REPLY_LINE_${i}`),
          'input',
        ];
        const grown = frame({
          ...options, height: grownLines.length, lines: grownLines,
        });
        await writeToHeadlessTerminal(terminal, serialize(log.render(offscreenChanged, grown)));
        lines = readHeadlessTerminalLines(terminal).filter(Boolean);
        expect(lines.filter((line) => line === 'WELCOME_HEADER')).toHaveLength(1);
        expect(lines).not.toContain('UPDATED_HEADER');
        expect(lines.slice(-41)).toEqual(grownLines.slice(-41));

        // An explicit transcript replacement still clears the old transcript.
        const replacementLines = ['NEW_SESSION', 'input'];
        const replacement = frame({
          ...options, height: replacementLines.length, lines: replacementLines,
        });
        log.forceTranscriptReplacement();
        await writeToHeadlessTerminal(terminal, serialize(log.render(grown, replacement)));
        expect(readHeadlessTerminalLines(terminal).filter(Boolean)).toEqual(replacementLines);
      } finally {
        terminal.dispose();
      }
    },
  );

  it.each([0, 2, 6])(
    'releases the retained origin when the logical frame shrinks to %i rows',
    async (remainingRows) => {
      const { frame, log } = createHarness();
      const width = 24;
      const viewportHeight = 5;
      const makeFrame = (lines: string[]) => frame({
        width, viewportHeight, height: lines.length, lines,
      });
      const history = Array.from({ length: 6 }, (_, i) => `history-${i}`);
      const empty = makeFrame([]);
      const approval = makeFrame([
        ...history,
        ...Array.from({ length: 20 }, (_, i) => `diff-${i}`),
      ]);
      const closed = makeFrame([...history, 'ready', 'input']);
      const shortenedLines = history.slice(0, remainingRows);
      const shortened = makeFrame(shortenedLines);
      const resumedLines = [...shortenedLines, 'input', 'status:0'];
      const resumed = makeFrame(resumedLines);
      const updatedLines = [...shortenedLines, 'input', 'status:1'];
      const updated = makeFrame(updatedLines);
      const terminal = new HeadlessTerminal({
        cols: width, rows: viewportHeight, allowProposedApi: true,
      });
      try {
        for (const [prev, next] of [
          [empty, approval], [approval, closed], [closed, shortened],
          [shortened, resumed], [resumed, updated],
        ]) {
          await writeToHeadlessTerminal(terminal, serialize(log.render(prev, next)));
        }
        const buffer = terminal.buffer.active;
        const activeLines = Array.from({ length: viewportHeight }, (_, i) =>
          buffer.getLine(buffer.baseY + i)?.translateToString(true) ?? '',
        );
        expect(activeLines).toContain('input');
        expect(activeLines).toContain('status:1');
        expect(activeLines).not.toContain('status:0');
      } finally {
        terminal.dispose();
      }
    },
  );

  it.each(['resize', 'transcript'] as const)(
    'drops the retained origin on a destructive %s reset',
    async (kind) => {
      const { frame, log } = createHarness();
      const width = 24;
      let viewportHeight = 5;
      const makeFrame = (lines: string[]) => frame({
        width, viewportHeight, height: lines.length, lines,
      });
      const history = Array.from({ length: 6 }, (_, i) => `history-${i}`);
      const empty = makeFrame([]);
      const approval = makeFrame([
        ...history,
        ...Array.from({ length: 20 }, (_, i) => `diff-${i}`),
      ]);
      const closedLines = [...history, 'ready', 'input'];
      const closed = makeFrame(closedLines);
      const terminal = new HeadlessTerminal({
        cols: width, rows: viewportHeight, allowProposedApi: true,
      });
      try {
        await writeToHeadlessTerminal(terminal, serialize(log.render(empty, approval)));
        await writeToHeadlessTerminal(terminal, serialize(log.render(approval, closed)));
        if (kind === 'resize') {
          viewportHeight = 10;
          terminal.resize(width, viewportHeight);
        } else {
          log.forceTranscriptReplacement();
        }
        const resetLines = kind === 'resize' ? closedLines : ['new-session', 'input'];
        const resetFrame = makeFrame(resetLines);
        const diff = log.render(closed, resetFrame);
        expect(hasPatch(diff, 'clearTerminal')).toBe(true);
        await writeToHeadlessTerminal(terminal, serialize(diff));
        const changed = makeFrame(['updated-header', ...resetLines.slice(1)]);
        await writeToHeadlessTerminal(terminal, serialize(log.render(resetFrame, changed)));
        expect(readHeadlessTerminalLines(terminal).filter(Boolean)).toEqual([
          'updated-header', ...resetLines.slice(1),
        ]);
      } finally {
        terminal.dispose();
      }
    },
  );

  it('keeps controls reachable when a history-window shift follows an approval rebase', async () => {
    const { frame, log } = createHarness();
    const width = 24;
    const viewportHeight = 5;
    const makeFrame = (lines: string[]) => frame({
      width, viewportHeight, height: lines.length, lines,
    });
    const history = Array.from({ length: 6 }, (_, i) => `history-${i}`);
    const empty = makeFrame([]);
    const approval = makeFrame([
      ...history,
      ...Array.from({ length: 20 }, (_, i) => `diff-${i}`),
    ]);
    const closed = makeFrame([...history, 'mode', 'input', 'status']);
    const shifted = makeFrame([
      ...history.slice(2), 'mode', 'input', 'status', 'rail-0', 'rail-1',
    ]);
    const terminal = new HeadlessTerminal({
      cols: width, rows: viewportHeight, allowProposedApi: true,
    });
    try {
      for (const [prev, next] of [
        [empty, approval], [approval, closed], [closed, shifted],
      ]) {
        await writeToHeadlessTerminal(terminal, serialize(log.render(prev, next)));
      }
      const buffer = terminal.buffer.active;
      const activeLines = Array.from({ length: viewportHeight }, (_, i) =>
        buffer.getLine(buffer.baseY + i)?.translateToString(true) ?? '',
      );
      expect(activeLines).toEqual(['input', 'status', 'rail-0', 'rail-1', '']);
    } finally {
      terminal.dispose();
    }
  });

  it('skips a stable offscreen change while advancing the logical frame', () => {
    const { frame, log } = createHarness();
    const prev = frame({
      height: 8,
      viewportHeight: 5,
      lines: ['old'],
    });
    const next = frame({
      height: 8,
      viewportHeight: 5,
      lines: ['new'],
    });

    const diff = log.render(prev, next);

    expect(diff).toEqual([]);
  });

  it('still writes a visible change in an overflowing frame', () => {
    const { frame, log } = createHarness();
    const lines = Array.from({ length: 8 }, () => '');
    lines[6] = 'old';
    const nextLines = [...lines];
    nextLines[6] = 'new';

    const diff = log.render(
      frame({ height: 8, viewportHeight: 5, lines }),
      frame({ height: 8, viewportHeight: 5, lines: nextLines }),
    );

    expect(hasPatch(diff, 'eraseViewport')).toBe(false);
    expect(stdoutContent(diff)).toContain('new');
  });

  it('skips offscreen rewrites while appending newly grown rows', () => {
    const { frame, log } = createHarness();
    const prevLines = ['old', '', '', '', '', '', '', 'tail'];
    const nextLines = ['new', '', '', '', '', '', '', 'tail', 'append'];

    const diff = log.render(
      frame({ height: 8, viewportHeight: 5, lines: prevLines }),
      frame({ height: 9, viewportHeight: 5, lines: nextLines }),
    );

    expect(hasPatch(diff, 'eraseViewport')).toBe(false);
    expect(stdoutContent(diff)).not.toContain('new');
    expect(stdoutContent(diff)).toContain('append');
  });

  it('keeps an overflowing conversation reachable when quit output replaces controls', () => {
    const { frame, log } = createHarness();
    const history = Array.from(
      { length: 8 },
      (_, index) => `history-${index}`,
    );
    const previousLines = [...history, 'mode', 'input', 'status'];
    const quittingLines = [
      ...history,
      '/quit',
      'goodbye',
      'session',
      'resume',
    ];

    const diff = log.render(
      frame({
        height: previousLines.length,
        viewportHeight: 5,
        lines: previousLines,
      }),
      frame({
        height: quittingLines.length,
        viewportHeight: 5,
        lines: quittingLines,
      }),
    );

    expect(hasPatch(diff, 'eraseViewport')).toBe(false);
    expect(hasPatch(diff, 'clearTerminal')).toBe(false);
    expect(stdoutContent(diff)).toContain('/quit');
    expect(stdoutContent(diff)).toContain('resume');
  });

  it('resets the viewport when an offscreen change accompanies shrink', () => {
    const { frame, log } = createHarness();
    const prev = frame({ height: 8, viewportHeight: 5, lines: ['old'] });
    const next = frame({ height: 7, viewportHeight: 5, lines: ['new'] });

    const diff = log.render(prev, next);

    expect(hasPatch(diff, 'eraseViewport')).toBe(true);
    expect(hasPatch(diff, 'clearTerminal')).toBe(false);
  });

  it('resets when an overflowing frame shrinks back into the viewport', () => {
    const { frame, log } = createHarness();
    const restoredLines = [
      'history-0',
      'history-1',
      'prompt',
      'status',
    ];

    const diff = log.render(
      frame({ height: 8, viewportHeight: 5 }),
      frame({
        height: restoredLines.length,
        viewportHeight: 5,
        lines: restoredLines,
      }),
    );

    expect(hasPatch(diff, 'eraseViewport')).toBe(true);
    expect(stdoutContent(diff)).toContain('history-0');
    expect(stdoutContent(diff)).toContain('status');
  });

  it('uses incremental clearing for a reachable tail shrink', () => {
    const { frame, log } = createHarness();
    const prevLines = Array.from({ length: 8 }, () => '');
    prevLines[7] = 'remove';

    const diff = log.render(
      frame({ height: 8, viewportHeight: 5, lines: prevLines }),
      frame({ height: 7, viewportHeight: 5 }),
    );

    expect(hasPatch(diff, 'eraseViewport')).toBe(false);
    expect(hasPatch(diff, 'clear')).toBe(true);
  });

  it('keeps incremental tail clearing when the closed frame still overflows', () => {
    const { frame, log } = createHarness();
    const history = Array.from({ length: 8 }, (_, index) => `history-${index}`);
    const previousLines = [
      ...history,
      'prompt',
      'suggest-0',
      'suggest-1',
      'suggest-2',
      'suggest-3',
      'suggest-4',
      'suggest-5',
    ];
    const nextLines = [...history, 'prompt', 'status'];

    const diff = log.render(
      frame({
        height: previousLines.length,
        viewportHeight: 8,
        lines: previousLines,
      }),
      frame({
        height: nextLines.length,
        viewportHeight: 8,
        lines: nextLines,
      }),
    );

    expect(diff).toContainEqual({ type: 'clear', count: 5 });
    expect(hasPatch(diff, 'eraseViewport')).toBe(false);
    expect(hasPatch(diff, 'clearTerminal')).toBe(false);
    expect(stdoutContent(diff)).not.toBe('');
    expect(stdoutContent(diff)).not.toContain('history-');
  });

  it('resets when a tail shrink exceeds the viewport', () => {
    const { frame, log } = createHarness();

    const diff = log.render(
      frame({ height: 20, viewportHeight: 5 }),
      frame({ height: 10, viewportHeight: 5 }),
    );

    expect(hasPatch(diff, 'eraseViewport')).toBe(true);
  });

  it('uses destructive resets when resized frames stay fully visible', () => {
    const widthHarness = createHarness();
    const widthDiff = widthHarness.log.render(
      widthHarness.frame({
        height: 3,
        viewportHeight: 5,
        width: 10,
      }),
      widthHarness.frame({
        height: 3,
        viewportHeight: 5,
        width: 12,
      }),
    );
    expect(hasPatch(widthDiff, 'clearTerminal')).toBe(true);
    expect(hasPatch(widthDiff, 'eraseViewport')).toBe(false);

    const heightHarness = createHarness();
    const heightDiff = heightHarness.log.render(
      heightHarness.frame({ height: 3, viewportHeight: 5 }),
      heightHarness.frame({ height: 3, viewportHeight: 4 }),
    );
    expect(hasPatch(heightDiff, 'clearTerminal')).toBe(true);
    expect(hasPatch(heightDiff, 'eraseViewport')).toBe(false);

    const heightGrowHarness = createHarness();
    const heightGrowDiff = heightGrowHarness.log.render(
      heightGrowHarness.frame({ height: 3, viewportHeight: 4 }),
      heightGrowHarness.frame({ height: 3, viewportHeight: 5 }),
    );
    expect(hasPatch(heightGrowDiff, 'clearTerminal')).toBe(true);
    expect(hasPatch(heightGrowDiff, 'eraseViewport')).toBe(false);
  });

  it('replays the full frame for overflowing resize changes', () => {
    const widthHarness = createHarness();
    const widthDiff = widthHarness.log.render(
      widthHarness.frame({
        height: 6,
        viewportHeight: 5,
        width: 10,
        lines: ['history-0'],
      }),
      widthHarness.frame({
        height: 6,
        viewportHeight: 5,
        width: 12,
        lines: ['history-0'],
      }),
    );
    expect(hasPatch(widthDiff, 'clearTerminal')).toBe(true);
    expect(hasPatch(widthDiff, 'eraseViewport')).toBe(false);
    expect(stdoutContent(widthDiff)).toContain('history-0');

    const heightHarness = createHarness();
    const heightDiff = heightHarness.log.render(
      heightHarness.frame({ height: 6, viewportHeight: 5 }),
      heightHarness.frame({ height: 6, viewportHeight: 4 }),
    );
    expect(hasPatch(heightDiff, 'clearTerminal')).toBe(true);
    expect(hasPatch(heightDiff, 'eraseViewport')).toBe(false);

    const newlyOverflowingHarness = createHarness();
    const newlyOverflowingDiff = newlyOverflowingHarness.log.render(
      newlyOverflowingHarness.frame({
        height: 4,
        viewportHeight: 5,
        width: 12,
      }),
      newlyOverflowingHarness.frame({
        height: 6,
        viewportHeight: 5,
        width: 8,
      }),
    );
    expect(hasPatch(newlyOverflowingDiff, 'clearTerminal')).toBe(true);

    const simultaneousShrinkHarness = createHarness();
    const simultaneousShrinkDiff = simultaneousShrinkHarness.log.render(
      simultaneousShrinkHarness.frame({
        height: 8,
        viewportHeight: 10,
      }),
      simultaneousShrinkHarness.frame({
        height: 4,
        viewportHeight: 5,
      }),
    );
    expect(hasPatch(simultaneousShrinkDiff, 'clearTerminal')).toBe(true);
  });

  it('does not accumulate stale wrapped frames across repeated width changes', async () => {
    const { frame, log } = createHarness();
    const rows = 10;
    const initialWidth = 40;
    const terminal = new HeadlessTerminal({
      cols: initialWidth,
      rows,
      allowProposedApi: true,
      scrollback: 200,
    });
    const initialLines = buildResizeReplayLines(initialWidth);
    let previousFrame = frame({
      height: 0,
      viewportHeight: rows,
      width: initialWidth,
    });
    let nextFrame = frame({
      height: initialLines.length,
      viewportHeight: rows,
      width: initialWidth,
      lines: initialLines,
    });
    await writeToHeadlessTerminal(
      terminal,
      serialize(log.render(previousFrame, nextFrame)),
    );
    previousFrame = nextFrame;

    let finalLines = initialLines;
    for (const width of [32, 48, 26, 44]) {
      terminal.resize(width, rows);
      finalLines = buildResizeReplayLines(width);
      nextFrame = frame({
        height: finalLines.length,
        viewportHeight: rows,
        width,
        lines: finalLines,
      });
      const diff = log.render(previousFrame, nextFrame);
      expect(hasPatch(diff, 'clearTerminal')).toBe(true);
      expect(hasPatch(diff, 'eraseViewport')).toBe(false);
      await writeToHeadlessTerminal(terminal, serialize(diff));
      previousFrame = nextFrame;
    }

    const nonEmptyLines = readHeadlessTerminalLines(terminal).filter(
      (line) => line.length > 0,
    );
    expect(nonEmptyLines).toEqual(finalLines);
    expect(nonEmptyLines.filter((line) => line === 'Thinking')).toHaveLength(1);
    expect(log.render(previousFrame, previousFrame)).toEqual([]);
  });

  it('replaces the complete terminal history when switching transcripts', async () => {
    const { frame, log } = createHarness();
    const width = 24;
    const rows = 5;
    const terminal = new HeadlessTerminal({
      cols: width,
      rows,
      allowProposedApi: true,
      scrollback: 200,
    });
    const emptyFrame = frame({
      height: 0,
      viewportHeight: rows,
      width,
    });
    const mainLines = Array.from(
      { length: 8 },
      (_, index) => `main-only-${index}`,
    );
    const mainFrame = frame({
      height: mainLines.length,
      viewportHeight: rows,
      width,
      lines: mainLines,
    });
    await writeToHeadlessTerminal(
      terminal,
      serialize(log.render(emptyFrame, mainFrame)),
    );

    const agentLines = Array.from(
      { length: 7 },
      (_, index) => `agent-only-${index}`,
    );
    const agentFrame = frame({
      height: agentLines.length,
      viewportHeight: rows,
      width,
      lines: agentLines,
    });
    log.forceTranscriptReplacement();
    const agentDiff = log.render(mainFrame, agentFrame);
    expect(agentDiff[0]).toEqual({
      type: 'clearTerminal',
      reason: 'transcript-switch',
    });
    expect(hasPatch(agentDiff, 'eraseViewport')).toBe(false);
    expect(stdoutContent(agentDiff)).toContain('agent-only-0');
    await writeToHeadlessTerminal(terminal, serialize(agentDiff));

    const agentBuffer = readHeadlessTerminalLines(terminal).filter(
      (line) => line.length > 0,
    );
    expect(agentBuffer).toEqual(agentLines);
    expect(agentBuffer.some((line) => line.includes('main-only'))).toBe(false);
    expect(log.render(agentFrame, agentFrame)).toEqual([]);

    log.forceTranscriptReplacement();
    const mainDiff = log.render(agentFrame, mainFrame);
    expect(mainDiff[0]).toEqual({
      type: 'clearTerminal',
      reason: 'transcript-switch',
    });
    await writeToHeadlessTerminal(terminal, serialize(mainDiff));

    const mainBuffer = readHeadlessTerminalLines(terminal).filter(
      (line) => line.length > 0,
    );
    expect(mainBuffer).toEqual(mainLines);
    expect(mainBuffer.some((line) => line.includes('agent-only'))).toBe(false);
    expect(log.render(mainFrame, mainFrame)).toEqual([]);
  });

  it('keeps an asynchronously loaded transcript isolated after replacement', async () => {
    const { frame, log } = createHarness();
    const width = 24;
    const rows = 5;
    const terminal = new HeadlessTerminal({
      cols: width,
      rows,
      allowProposedApi: true,
      scrollback: 200,
    });
    const mainLines = Array.from(
      { length: 8 },
      (_, index) => `main-before-load-${index}`,
    );
    const mainFrame = frame({
      height: mainLines.length,
      viewportHeight: rows,
      width,
      lines: mainLines,
    });
    const emptyFrame = frame({
      height: 0,
      viewportHeight: rows,
      width,
    });
    await writeToHeadlessTerminal(
      terminal,
      serialize(log.render(emptyFrame, mainFrame)),
    );

    const loadingLines = ['Loading transcript...', 'input', 'rail'];
    const loadingFrame = frame({
      height: loadingLines.length,
      viewportHeight: rows,
      width,
      lines: loadingLines,
    });
    log.forceTranscriptReplacement();
    await writeToHeadlessTerminal(
      terminal,
      serialize(log.render(mainFrame, loadingFrame)),
    );

    const agentLines = Array.from(
      { length: 7 },
      (_, index) => `loaded-agent-${index}`,
    );
    const agentFrame = frame({
      height: agentLines.length,
      viewportHeight: rows,
      width,
      lines: agentLines,
    });
    const loadedDiff = log.render(loadingFrame, agentFrame);
    expect(hasPatch(loadedDiff, 'clearTerminal')).toBe(false);
    await writeToHeadlessTerminal(terminal, serialize(loadedDiff));

    const agentBuffer = readHeadlessTerminalLines(terminal).filter(
      (line) => line.length > 0,
    );
    expect(agentBuffer).toEqual(agentLines);
    expect(agentBuffer.some((line) => line.includes('main-before-load'))).toBe(
      false,
    );
    expect(agentBuffer).not.toContain('Loading transcript...');
    expect(log.render(agentFrame, agentFrame)).toEqual([]);
  });

  it('replaces an overflowing loading transcript when lazy loading settles', async () => {
    const { frame, log } = createHarness();
    const width = 28;
    const rows = 5;
    const terminal = new HeadlessTerminal({
      cols: width,
      rows,
      allowProposedApi: true,
      scrollback: 200,
    });
    const emptyFrame = frame({
      height: 0,
      viewportHeight: rows,
      width,
    });
    const loadingLines = Array.from({ length: 9 }, (_, index) =>
      index === 1 ? 'Loading transcript...' : `fallback-row-${index}`,
    );
    const loadingFrame = frame({
      height: loadingLines.length,
      viewportHeight: rows,
      width,
      lines: loadingLines,
    });
    log.forceTranscriptReplacement();
    await writeToHeadlessTerminal(
      terminal,
      serialize(log.render(emptyFrame, loadingFrame)),
    );

    const loadedLines = Array.from(
      { length: 13 },
      (_, index) => `complete-agent-row-${index}`,
    );
    const loadedFrame = frame({
      height: loadedLines.length,
      viewportHeight: rows,
      width,
      lines: loadedLines,
    });
    log.forceTranscriptReplacement();
    const loadedDiff = log.render(loadingFrame, loadedFrame);
    expect(hasPatch(loadedDiff, 'clearTerminal')).toBe(true);
    await writeToHeadlessTerminal(terminal, serialize(loadedDiff));

    const terminalLines = readHeadlessTerminalLines(terminal).filter(
      (line) => line.length > 0,
    );
    expect(terminalLines).toEqual(loadedLines);
    expect(terminalLines).not.toContain('Loading transcript...');
    expect(terminalLines.some((line) => line.includes('fallback-row'))).toBe(
      false,
    );
  });

  it('keeps viewport growth scrollback-preserving after an overflowing frame', async () => {
    const { frame, log } = createHarness();
    const width = 20;
    const initialRows = 5;
    const expandedRows = 8;
    const lines = Array.from({ length: 8 }, (_, index) => `row-${index}`);
    const terminal = new HeadlessTerminal({
      cols: width,
      rows: initialRows,
      allowProposedApi: true,
      scrollback: 200,
    });
    const emptyFrame = frame({
      height: 0,
      viewportHeight: initialRows,
      width,
    });
    const overflowingFrame = frame({
      height: lines.length,
      viewportHeight: initialRows,
      width,
      lines,
    });
    await writeToHeadlessTerminal(
      terminal,
      serialize(log.render(emptyFrame, overflowingFrame)),
    );

    terminal.resize(width, expandedRows);
    const expandedFrame = frame({
      height: lines.length,
      viewportHeight: expandedRows,
      width,
      lines,
    });
    const diff = log.render(overflowingFrame, expandedFrame);
    expect(hasPatch(diff, 'clearTerminal')).toBe(true);
    expect(hasPatch(diff, 'eraseViewport')).toBe(false);
    await writeToHeadlessTerminal(terminal, serialize(diff));

    const nonEmptyLines = readHeadlessTerminalLines(terminal).filter(
      (line) => line.length > 0,
    );
    expect(nonEmptyLines).toEqual(lines);
    expect(log.render(expandedFrame, expandedFrame)).toEqual([]);
  });

  it('uses destructive resets for viewport growth', () => {
    const overflowHarness = createHarness();
    const overflowDiff = overflowHarness.log.render(
      overflowHarness.frame({ height: 8, viewportHeight: 5 }),
      overflowHarness.frame({ height: 8, viewportHeight: 6 }),
    );
    expect(hasPatch(overflowDiff, 'clearTerminal')).toBe(true);
    expect(hasPatch(overflowDiff, 'eraseViewport')).toBe(false);

    const visibleHarness = createHarness();
    const visibleDiff = visibleHarness.log.render(
      visibleHarness.frame({ height: 3, viewportHeight: 5 }),
      visibleHarness.frame({ height: 3, viewportHeight: 6 }),
    );
    expect(hasPatch(visibleDiff, 'clearTerminal')).toBe(true);
    expect(hasPatch(visibleDiff, 'eraseViewport')).toBe(false);
  });

  it('uses the same viewport reset builder for explicit recovery', () => {
    const { frame, log } = createHarness();
    const current = frame({ height: 8, viewportHeight: 5 });
    log.forceReset();

    const diff = log.render(current, current);

    expect(diff[0]).toEqual({
      type: 'eraseViewport',
      rows: 5,
      reason: 'recovery',
    });
  });

  it('keeps full clear for alternate-screen recovery', () => {
    const { frame, log } = createHarness();
    const current = frame({ height: 8, viewportHeight: 5 });
    log.forceReset();

    const diff = log.render(current, current, true);

    expect(diff[0]).toEqual({
      type: 'clearTerminal',
      reason: 'recovery',
    });
  });

  it('repaints only the visible tail and preserves scrollback identity', () => {
    const { frame, log } = createHarness();
    const prev = frame({
      height: 8,
      viewportHeight: 5,
      lines: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    });
    const next = frame({
      height: 7,
      viewportHeight: 5,
      lines: ['x', 'b', 'c', 'd', 'e', 'f', 'g'],
    });

    const diff = log.render(prev, next);
    const painted = stdoutContent(diff);
    const output = serialize(diff);
    expect(output).not.toContain('\x1b[2J');
    expect(output).not.toContain('\x1b[3J');
    expect(painted).not.toContain('x');
    expect(painted).not.toContain('b');
    expect(painted).not.toContain('c');
    expect(painted).toContain('d');
    expect(painted).toContain('g');

    const terminal = new PhysicalTerminalModel(10, 5);
    terminal.write('history-1\r\nhistory-2\r\nold-1\r\nold-2\r\nold-3\r\nold-4');
    terminal.scrollViewportToScrollbackRow(0);
    const scrollbackIds = terminal.scrollbackRowIds;
    const viewedTopIdentity = terminal.viewedTopIdentity;

    terminal.write(serialize(diff));

    expect(terminal.scrollbackRowIds).toEqual(scrollbackIds);
    expect(terminal.viewedTopIdentity).toBe(viewedTopIdentity);
    expect(terminal.activeLines).toEqual(['d', 'e', 'f', 'g', '']);
    expect(terminal.cursor).toEqual({ x: 0, y: 4 });
  });

  it('preserves scrollback identity when a cap advance and stream update share a frame', () => {
    const { frame, log } = createHarness();
    const previousLines = [
      ...Array.from({ length: 11 }, (_, index) => `old-${index}`),
      'context',
      'stream-v1',
      'tool',
      'input',
      'status',
      'footer',
    ];
    const nextLines = [
      'window-start',
      'context-a',
      'context-b',
      'stream-v2',
      'input',
      'status',
      'footer',
    ];

    const previousFrame = frame({
      height: previousLines.length,
      viewportHeight: 5,
      lines: previousLines,
    });
    const nextFrame = frame({
      height: nextLines.length,
      viewportHeight: 5,
      lines: nextLines,
    });
    const diff = log.render(previousFrame, nextFrame);

    expect(hasPatch(diff, 'eraseViewport')).toBe(true);
    expect(hasPatch(diff, 'clearTerminal')).toBe(false);
    expect(stdoutContent(diff)).not.toContain('window-start');
    expect(stdoutContent(diff)).toContain('stream-v2');

    const terminal = new PhysicalTerminalModel(10, 5);
    terminal.write('history-1\r\nhistory-2\r\nold-a\r\nold-b\r\nold-c\r\nold-d');
    terminal.scrollViewportToScrollbackRow(0);
    const scrollbackIds = terminal.scrollbackRowIds;
    const viewedTopIdentity = terminal.viewedTopIdentity;

    terminal.write(serialize(diff));

    expect(terminal.scrollbackRowIds).toEqual(scrollbackIds);
    expect(terminal.viewedTopIdentity).toBe(viewedTopIdentity);
    expect(terminal.activeLines).toEqual([
      'stream-v2',
      'input',
      'status',
      'footer',
      '',
    ]);
    expect(log.render(nextFrame, nextFrame)).toEqual([]);
  });

  it('removes a live rail during a cap advance without clearing scrollback', () => {
    const { frame, log } = createHarness();
    const previousLines = [
      ...Array.from({ length: 11 }, (_, index) => `old-${index}`),
      'stream',
      'agent-rail',
      'input',
      'status',
      'footer',
    ];
    const nextLines = [
      'window-start',
      'context-a',
      'context-b',
      'stream',
      'input',
      'status',
      'footer',
    ];

    const previousFrame = frame({
      height: previousLines.length,
      viewportHeight: 5,
      lines: previousLines,
    });
    const nextFrame = frame({
      height: nextLines.length,
      viewportHeight: 5,
      lines: nextLines,
    });
    const diff = log.render(previousFrame, nextFrame);
    const output = serialize(diff);

    expect(hasPatch(diff, 'eraseViewport')).toBe(true);
    expect(hasPatch(diff, 'clearTerminal')).toBe(false);
    expect(output).not.toContain('\x1b[2J');
    expect(output).not.toContain('\x1b[3J');
    expect(stdoutContent(diff)).not.toContain('agent-rail');

    const terminal = new PhysicalTerminalModel(10, 5);
    terminal.write('history-1\r\nhistory-2\r\nstream\r\nagent-rail\r\ninput\r\nstatus');
    terminal.scrollViewportToScrollbackRow(0);
    const scrollbackIds = terminal.scrollbackRowIds;
    const viewedTopIdentity = terminal.viewedTopIdentity;

    terminal.write(output);

    expect(terminal.scrollbackRowIds).toEqual(scrollbackIds);
    expect(terminal.viewedTopIdentity).toBe(viewedTopIdentity);
    expect(terminal.activeLines).toEqual([
      'stream',
      'input',
      'status',
      'footer',
      '',
    ]);
    expect(log.render(nextFrame, nextFrame)).toEqual([]);
  });

  it('erases a removed styled tail once with the default rendition', () => {
    const { frame, log } = createHarness();
    const width = 8;
    const viewportHeight = 5;
    const emptyFrame = frame({ height: 0, viewportHeight, width });
    const previousFrame = frame({
      height: 1,
      viewportHeight,
      width,
      lines: ['input'],
      backgroundRows: [0],
    });
    const nextFrame = frame({
      height: 1,
      viewportHeight,
      width,
      lines: ['ok'],
      hyperlinkRows: [0],
    });
    const terminal = new PhysicalTerminalModel(width, viewportHeight);

    terminal.write(serialize(log.render(emptyFrame, previousFrame)));
    const diff = log.render(previousFrame, nextFrame);
    const output = serialize(diff);
    terminal.write(output);

    expect(output.split(eraseToEndOfLine())).toHaveLength(2);
    expect(output.indexOf(LINK_END)).toBeLessThan(
      output.indexOf(eraseToEndOfLine()),
    );
    expect(output.indexOf('\x1b[49m')).toBeLessThan(
      output.indexOf(eraseToEndOfLine()),
    );
    expect(terminal.activeLines[0]).toBe('ok');
    expect(terminal.activeBackgroundMask[0]).toBe('');
  });

  it('erases a removed wide-character tail without rendering its spacer', () => {
    const { frame, log, stylePool } = createHarness();
    const previousFrame = frame({
      height: 1,
      viewportHeight: 5,
      lines: ['ab'],
    });
    setCellAt(previousFrame.screen, 2, 0, {
      char: '你',
      styleId: stylePool.none,
      width: CellWidth.Wide,
      hyperlink: undefined,
    });
    const nextFrame = frame({
      height: 1,
      viewportHeight: 5,
      lines: ['ab'],
    });

    const diff = log.render(previousFrame, nextFrame);
    const output = serialize(diff);

    expect(output.split(eraseToEndOfLine())).toHaveLength(2);
    expect(stdoutContent(diff)).not.toContain('你');
    expect(hasPatch(diff, 'eraseViewport')).toBe(false);
  });

  it('uses an absolute column for separated changes on the same row', () => {
    const { frame, log } = createHarness();
    const previousFrame = frame({
      height: 1,
      viewportHeight: 5,
      lines: ['aXaaaY'],
    });
    const nextFrame = frame({
      height: 1,
      viewportHeight: 5,
      lines: ['aPaaaQ'],
    });

    const diff = log.render(previousFrame, nextFrame);

    expect(diff).toContainEqual({ type: 'cursorTo', col: 6 });
    expect(
      diff.some(
        (patch) =>
          patch.type === 'cursorMove' && patch.y === 0 && patch.x !== 0,
      ),
    ).toBe(false);
  });

  it('repairs the active tail when an anchor advance is masked by transient growth', () => {
    const { frame, log } = createHarness();
    const width = 12;
    const viewportHeight = 8;
    const topEdge = '▄'.repeat(width);
    const bottomEdge = '▀'.repeat(width);
    const history = Array.from(
      { length: 13 },
      (_, index) => `history-${index + 2}`,
    );
    const emptyFrame = frame({ height: 0, viewportHeight, width });
    const previousFrame = frame({
      height: 22,
      viewportHeight,
      width,
      lines: [
        ...history,
        'mode',
        topEdge,
        'input',
        bottomEdge,
        'status',
        'rail-0',
        'rail-1',
        'rail-2',
        'rail-3',
      ],
      backgroundRows: [15],
    });
    const railHiddenFrame = frame({
      height: 18,
      viewportHeight,
      width,
      lines: [
        ...history,
        'mode',
        topEdge,
        'input',
        bottomEdge,
        'status',
      ],
      backgroundRows: [15],
    });
    const anchorAdvancedFrame = frame({
      height: 18,
      viewportHeight,
      width,
      lines: [
        ...Array.from(
          { length: 11 },
          (_, index) => `history-${index + 6}`,
        ),
        'mode',
        topEdge,
        'input',
        bottomEdge,
        'status',
        'rail-0',
        'rail-1',
      ],
      backgroundRows: [13],
    });
    const terminal = new PhysicalTerminalModel(width, viewportHeight);

    terminal.write(serialize(log.render(emptyFrame, previousFrame)));
    terminal.scrollViewportToScrollbackRow(0);
    const scrollbackIds = terminal.scrollbackRowIds;
    const viewedTopIdentity = terminal.viewedTopIdentity;
    terminal.write(serialize(log.render(previousFrame, railHiddenFrame)));
    const diff = log.render(railHiddenFrame, anchorAdvancedFrame);
    const output = serialize(diff);
    terminal.write(output);

    expect(anchorAdvancedFrame.screen.height).toBe(
      railHiddenFrame.screen.height,
    );
    expect(hasPatch(diff, 'eraseViewport')).toBe(false);
    expect(hasPatch(diff, 'clearTerminal')).toBe(false);
    expect(output).not.toContain('\x1b[2J');
    expect(output).not.toContain('\x1b[3J');
    expect(terminal.scrollbackRowIds).toEqual(scrollbackIds);
    expect(terminal.viewedTopIdentity).toBe(viewedTopIdentity);
    expect(terminal.activeLines).toEqual([
      'mode',
      topEdge,
      'input',
      bottomEdge,
      'status',
      'rail-0',
      'rail-1',
      '',
    ]);
    expect(terminal.activeBackgroundMask).toEqual([
      '',
      '',
      '############',
      '',
      '',
      '',
      '',
      '',
    ]);
    expect(log.render(anchorAdvancedFrame, anchorAdvancedFrame)).toEqual([]);
  });

  it('keeps the physical and virtual cursor aligned after reset', () => {
    const { frame, log } = createHarness();
    const current = frame({
      height: 3,
      viewportHeight: 5,
      lines: ['one', 'two', 'three'],
      cursorX: 2,
      cursorY: 1,
    });
    log.forceReset();

    const terminal = new PhysicalTerminalModel(10, 5);
    terminal.write(serialize(log.render(current, current)));

    expect(terminal.activeLines.slice(0, 3)).toEqual(['one', 'two', 'three']);
    expect(terminal.cursor).toEqual({ x: 2, y: 1 });
  });

  it('produces no repeated output for an unchanged post-reset frame', () => {
    const { frame, log } = createHarness();
    const current = frame({
      height: 8,
      viewportHeight: 5,
      lines: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    });

    expect(log.render(current, current)).toEqual([]);
  });
});
