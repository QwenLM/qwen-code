/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { EventEmitter } from 'node:events';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Ink from './ink.js';
import InternalApp from './components/App.js';
import useStdout from './compat/use-stdout.js';
import {
  CURSOR_HOME,
  cursorDown,
  cursorPosition,
  ERASE_LINE,
  ERASE_SCREEN,
  ERASE_SCROLLBACK,
  eraseToEndOfScreen,
  RESET_SCROLL_REGION,
} from './termio/csi.js';
import { EXIT_ALT_SCREEN, SHOW_CURSOR } from './termio/dec.js';
import { RESTORE_CURSOR, SAVE_CURSOR } from './termio/esc.js';
import { LINK_END } from './termio/osc.js';
import { PhysicalTerminalModel } from './testing/physical-terminal-model.js';

type MockWriteStream = NodeJS.WriteStream & {
  isTTY: boolean;
  columns: number;
  rows: number;
  write: ReturnType<typeof vi.fn>;
};

function createWriteStream(isTTY: boolean): MockWriteStream {
  return Object.assign(new EventEmitter(), {
    isTTY,
    columns: 80,
    rows: 24,
    write: vi.fn(() => true),
  }) as unknown as MockWriteStream;
}

function createReadStream(): NodeJS.ReadStream {
  return Object.assign(new EventEmitter(), {
    isTTY: false,
    isRaw: false,
    pause: vi.fn(),
    resume: vi.fn(),
    ref: vi.fn(),
    read: vi.fn(() => null),
  }) as unknown as NodeJS.ReadStream;
}

function outputOf(stream: MockWriteStream): string {
  return stream.write.mock.calls.map(([chunk]) => String(chunk)).join('');
}

describe('Ink main-screen recovery', () => {
  const instances: Array<{ ink: Ink; stdout: MockWriteStream }> = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const { ink, stdout } of instances.splice(0)) {
      // Avoid writing terminal-mode cleanup to the real test process stdout.
      stdout.isTTY = false;
      ink.unmount();
    }
  });

  function createInk({
    captureStartupOutput = false,
  }: {
    captureStartupOutput?: boolean;
  } = {}): { ink: Ink; stdout: MockWriteStream } {
    const stdout = createWriteStream(true);
    const instance = {
      ink: new Ink({
        stdout,
        stdin: createReadStream(),
        stderr: createWriteStream(false),
        exitOnCtrlC: false,
        patchConsole: false,
      }),
      stdout,
    };
    instances.push(instance);
    if (!captureStartupOutput) {
      stdout.write.mockClear();
    }
    return instance;
  }

  it('provides the configured stdout stream to useStdout consumers', () => {
    const { ink, stdout } = createInk();
    let stdoutContext: ReturnType<typeof useStdout> | undefined;

    function StdoutProbe() {
      stdoutContext = useStdout();
      return null;
    }

    ink.render(createElement(StdoutProbe));

    expect(stdoutContext?.stdout).toBe(stdout);
    stdout.write.mockClear();

    const titleSequence = '\x1b]0;✦ Session title | Working\x07';
    stdoutContext?.write(titleSequence);

    expect(stdout.write).toHaveBeenCalledWith(titleSequence);
  });

  it('starts at the top of a fresh viewport without clearing history', () => {
    const { stdout } = createInk({ captureStartupOutput: true });

    const output = outputOf(stdout);
    expect(output).toContain(
        LINK_END +
        '\x1b[0m' +
        SAVE_CURSOR +
        RESET_SCROLL_REGION +
        RESTORE_CURSOR +
        eraseToEndOfScreen() +
        '\r\n'.repeat(stdout.rows) +
        CURSOR_HOME +
        SHOW_CURSOR,
    );
    expect(output).not.toContain(ERASE_SCREEN);
    expect(output).not.toContain(ERASE_SCROLLBACK);
  });

  it('moves only the shell prefix into native scrollback on startup', () => {
    const { stdout } = createInk({ captureStartupOutput: true });
    const terminal = new PhysicalTerminalModel(stdout.columns, stdout.rows);

    terminal.write(
      'shell output\r\n$ qwen' +
        SAVE_CURSOR +
        cursorPosition(10, 1) +
        'stale content below the prompt' +
        RESTORE_CURSOR,
    );
    terminal.write(outputOf(stdout));

    expect(terminal.scrollbackLines).toEqual([
      'shell output',
      '$ qwen',
    ]);
    expect(terminal.activeLines).toEqual(
      Array.from({ length: stdout.rows }, () => ''),
    );
    expect(terminal.cursor).toEqual({ x: 0, y: 0 });
  });

  it('clears a conversation without rendering the stale frame', async () => {
    const { ink, stdout } = createInk();
    const renderSpy = vi.spyOn(ink, 'onRender');

    ink.clearConversation();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(outputOf(stdout)).toContain(
      ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME,
    );
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('rebuilds the viewport without clearing screen or scrollback', async () => {
    const { ink, stdout } = createInk();

    ink.requestViewportReset();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const output = outputOf(stdout);
    expect(output).toContain(ERASE_LINE);
    expect(output).not.toContain(ERASE_SCREEN);
    expect(output).not.toContain(ERASE_SCROLLBACK);
  });

  it('clears native history when replacing the active transcript', async () => {
    const { ink, stdout } = createInk();

    ink.requestTranscriptReplacement();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const output = outputOf(stdout);
    expect(output).toContain(ERASE_SCREEN);
    expect(output).toContain(ERASE_SCROLLBACK);
  });

  it('returns from an external TUI without clearing main scrollback', () => {
    const { ink, stdout } = createInk();
    ink.enterAlternateScreen();
    stdout.write.mockClear();

    ink.exitAlternateScreen();

    const output = outputOf(stdout);
    expect(output).toContain(EXIT_ALT_SCREEN);
    expect(output).not.toContain(ERASE_SCROLLBACK);
  });

  it('clamps main-screen cursor restoration to the viewport height', () => {
    const { ink, stdout } = createInk();
    const internals = ink as unknown as {
      displayCursor: { x: number; y: number } | null;
      frontFrame: { cursor: { x: number; y: number } };
      log: { render: (...args: unknown[]) => Array<{ type: string; content?: string }> };
    };
    internals.displayCursor = { x: 0, y: 0 };
    internals.frontFrame.cursor = { x: 0, y: 100 };
    vi.spyOn(internals.log, 'render').mockReturnValue([
      { type: 'stdout', content: 'paint' },
    ]);

    ink.onRender();

    const output = outputOf(stdout);
    expect(output).toContain(cursorDown(stdout.rows - 1));
    expect(output).not.toContain(cursorDown(100));
  });
});

describe('Ink bracketed-paste recovery', () => {
  function createInternalApp(): InternalApp {
    return new InternalApp({
      children: null,
      stdin: createReadStream(),
      stdout: createWriteStream(true),
      stderr: createWriteStream(false),
      exitOnCtrlC: false,
      onExit: vi.fn(),
      terminalColumns: 80,
      terminalRows: 24,
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes an unterminated paste after two seconds', () => {
    vi.useFakeTimers();
    const app = createInternalApp();
    const inputListener = vi.fn();
    app.internal_eventEmitter.on('input', inputListener);

    app.processInput('\x1b[200~partial paste');

    expect(app.keyParseState.mode).toBe('IN_PASTE');
    expect(app.keyParseState.incomplete).toBe('');
    expect(app.incompleteEscapeTimer).not.toBeNull();

    vi.advanceTimersByTime(1999);
    expect(inputListener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(inputListener).toHaveBeenCalledTimes(1);
    expect(inputListener).toHaveBeenCalledWith(
      expect.objectContaining({
        keypress: expect.objectContaining({
          isPasted: true,
          sequence: 'partial paste',
        }),
      }),
    );
    expect(app.keyParseState.mode).toBe('NORMAL');
    expect(app.incompleteEscapeTimer).toBeNull();
  });

  it('dispatches a completed paste immediately and cancels recovery', () => {
    vi.useFakeTimers();
    const app = createInternalApp();
    const inputListener = vi.fn();
    app.internal_eventEmitter.on('input', inputListener);

    app.processInput('\x1b[200~hello');
    app.processInput(' world\x1b[201~');

    expect(inputListener).toHaveBeenCalledTimes(1);
    expect(inputListener).toHaveBeenCalledWith(
      expect.objectContaining({
        keypress: expect.objectContaining({
          isPasted: true,
          sequence: 'hello world',
        }),
      }),
    );
    expect(app.keyParseState.mode).toBe('NORMAL');
    expect(app.incompleteEscapeTimer).toBeNull();

    vi.advanceTimersByTime(2000);
    expect(inputListener).toHaveBeenCalledTimes(1);
  });

  it('recovers from an empty unterminated paste without re-arming', () => {
    vi.useFakeTimers();
    const app = createInternalApp();
    const inputListener = vi.fn();
    app.internal_eventEmitter.on('input', inputListener);

    app.processInput('\x1b[200~');
    vi.advanceTimersByTime(2000);

    expect(inputListener).not.toHaveBeenCalled();
    expect(app.keyParseState.mode).toBe('NORMAL');
    expect(app.incompleteEscapeTimer).toBeNull();
  });
});
