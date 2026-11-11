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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Diff } from './frame.js';
import { optimize } from './optimizer.js';
import type { Terminal } from './terminal.js';
import {
  CURSOR_HOME,
  cursorDown,
  cursorUp,
  ERASE_LINE,
} from './termio/csi.js';
import { LINK_END } from './termio/osc.js';
import { PhysicalTerminalModel } from './testing/physical-terminal-model.js';

const SGR_RESET = '\x1b[0m';
const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';

type WriteDiffToTerminal =
  typeof import('./terminal.js').writeDiffToTerminal;

function createTerminal() {
  const write = vi.fn();
  return {
    write,
    terminal: {
      stdout: { write } as unknown as Writable,
      stderr: { write: vi.fn() } as unknown as Writable,
    },
  };
}

function serialize(
  writeDiffToTerminal: WriteDiffToTerminal,
  diff: Diff,
): string {
  let output = '';
  const createSink = (capture: boolean) =>
    new Writable({
      write(chunk, _encoding, callback) {
        if (capture) output += chunk.toString();
        callback();
      },
    });
  const terminal: Terminal = {
    stdout: createSink(true),
    stderr: createSink(false),
  };

  writeDiffToTerminal(terminal, diff, true);
  return output;
}

describe('writeDiffToTerminal', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('seals every frame with hard SGR resets', async () => {
    vi.stubEnv('TERM_PROGRAM', 'Apple_Terminal');
    const { writeDiffToTerminal } = await import('./terminal.js');
    const { terminal, write } = createTerminal();
    const diff: Diff = [{ type: 'stdout', content: 'plain text' }];

    writeDiffToTerminal(terminal, diff);

    expect(write).toHaveBeenCalledExactlyOnceWith(
      `${SGR_RESET}plain text${SGR_RESET}`,
    );
  });

  it('does not write reset-only frames when there are no patches', async () => {
    const { writeDiffToTerminal } = await import('./terminal.js');
    const { terminal, write } = createTerminal();

    writeDiffToTerminal(terminal, []);

    expect(write).not.toHaveBeenCalled();
  });

  it('keeps the SGR reset boundary inside synchronized output', async () => {
    vi.stubEnv('TERM_PROGRAM', 'iTerm.app');
    const { writeDiffToTerminal } = await import('./terminal.js');
    const { terminal, write } = createTerminal();
    const diff: Diff = [
      { type: 'styleStr', str: '\x1b[2m' },
      { type: 'stdout', content: 'dim text' },
    ];

    writeDiffToTerminal(terminal, diff);

    expect(write).toHaveBeenCalledExactlyOnceWith(
      `${BSU}${SGR_RESET}\x1b[2mdim text${SGR_RESET}${ESU}`,
    );
  });

  it('keeps frame resets when synchronized markers are disabled', async () => {
    vi.stubEnv('TERM_PROGRAM', 'iTerm.app');
    const { writeDiffToTerminal } = await import('./terminal.js');
    const { terminal, write } = createTerminal();
    const diff: Diff = [{ type: 'stdout', content: 'plain text' }];

    writeDiffToTerminal(terminal, diff, true);

    expect(write).toHaveBeenCalledExactlyOnceWith(
      `${SGR_RESET}plain text${SGR_RESET}`,
    );
  });

  it('clamps vertical cursor movement to the active viewport', async () => {
    const { writeDiffToTerminal } = await import('./terminal.js');
    const { terminal, write } = createTerminal();
    const diff: Diff = [
      { type: 'cursorMove', x: 0, y: 20 },
      { type: 'cursorMove', x: 0, y: -20 },
    ];

    writeDiffToTerminal(terminal, diff, true, 8);

    expect(write).toHaveBeenCalledExactlyOnceWith(
      `${SGR_RESET}${cursorDown(7)}${cursorUp(7)}${SGR_RESET}`,
    );
  });

  it('serializes eraseViewport without clearing screen or scrollback', async () => {
    const { writeDiffToTerminal } = await import('./terminal.js');
    const output = serialize(writeDiffToTerminal, [
      { type: 'eraseViewport', rows: 4, reason: 'offscreen' },
    ]);

    expect(output).toContain(LINK_END);
    expect(output).toContain(SGR_RESET);
    expect(output).not.toContain('\x1b[2J');
    expect(output).not.toContain('\x1b[3J');
    expect(output.split(ERASE_LINE)).toHaveLength(5);
    expect(output.endsWith(CURSOR_HOME + SGR_RESET)).toBe(true);

    const terminal = new PhysicalTerminalModel(20, 4);
    terminal.write(output);
    expect(terminal.cursor).toEqual({ x: 0, y: 0 });
  });

  it('retains destructive clear behavior for clearTerminal', async () => {
    const { writeDiffToTerminal } = await import('./terminal.js');
    const output = serialize(writeDiffToTerminal, [
      { type: 'clearTerminal', reason: 'clear' },
    ]);

    expect(output).toContain('\x1b[2J');
    expect(output).toContain('\x1b[3J');
    expect(output.endsWith(CURSOR_HOME + SGR_RESET)).toBe(true);
  });

  it('does not reorder or merge patches across a viewport reset', async () => {
    const { writeDiffToTerminal } = await import('./terminal.js');
    const diff = optimize([
      { type: 'stdout', content: 'before' },
      { type: 'eraseViewport', rows: 3, reason: 'recovery' },
      { type: 'stdout', content: 'after' },
    ]);

    expect(diff.map((patch) => patch.type)).toEqual([
      'stdout',
      'eraseViewport',
      'stdout',
    ]);
    const output = serialize(writeDiffToTerminal, diff);
    expect(output.indexOf('before')).toBeLessThan(output.indexOf(ERASE_LINE));
    expect(output.indexOf(ERASE_LINE)).toBeLessThan(output.indexOf('after'));
  });
});
