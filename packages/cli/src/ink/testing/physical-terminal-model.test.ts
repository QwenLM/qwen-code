/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { describe, expect, it } from 'vitest';
import {
  getClearTerminalSequence,
  getEraseViewportSequence,
} from '../clearTerminal.js';
import {
  CURSOR_HOME,
  cursorPosition,
  cursorDown,
  ERASE_LINE,
  ERASE_SCREEN,
  eraseToEndOfScreen,
} from '../termio/csi.js';
import { RESTORE_CURSOR, SAVE_CURSOR } from '../termio/esc.js';
import { PhysicalTerminalModel } from './physical-terminal-model.js';

function createTerminalWithScrollback(): PhysicalTerminalModel {
  const terminal = new PhysicalTerminalModel(12, 3);
  terminal.write('history-1\r\nhistory-2\r\nvisible-1\r\nvisible-2');
  return terminal;
}

describe('PhysicalTerminalModel', () => {
  it('models LF at the bottom as a new native scrollback row', () => {
    const terminal = createTerminalWithScrollback();

    expect(terminal.scrollbackRowIds).toHaveLength(1);
    expect(terminal.activeLines).toEqual([
      'history-2',
      'visible-1',
      'visible-2',
    ]);
  });

  it('keeps scrollback and the user viewport identity during viewport erase', () => {
    const terminal = createTerminalWithScrollback();
    terminal.scrollViewportToScrollbackRow(0);
    const scrollbackIds = terminal.scrollbackRowIds;
    const viewedTopIdentity = terminal.viewedTopIdentity;

    terminal.write(getEraseViewportSequence(terminal.rows));

    expect(terminal.scrollbackRowIds).toEqual(scrollbackIds);
    expect(terminal.viewedTopIdentity).toBe(viewedTopIdentity);
    expect(terminal.activeLines).toEqual(['', '', '']);
    expect(terminal.cursor).toEqual({ x: 0, y: 0 });
  });

  it('models CSI 2J as screen-only and CSI 3J as destructive', () => {
    const terminal = createTerminalWithScrollback();
    terminal.scrollViewportToScrollbackRow(0);
    const viewedTopIdentity = terminal.viewedTopIdentity;

    terminal.write(ERASE_SCREEN + CURSOR_HOME);
    expect(terminal.scrollbackRowIds).toHaveLength(1);
    expect(terminal.viewedTopIdentity).toBe(viewedTopIdentity);

    terminal.write(getClearTerminalSequence());
    expect(terminal.scrollbackRowIds).toEqual([]);
    expect(terminal.viewedTopIdentity).not.toBe(viewedTopIdentity);
  });

  it('restores the cursor and erases only from it to the screen end', () => {
    const terminal = new PhysicalTerminalModel(12, 3);
    terminal.write(
      '$ qwen' +
        SAVE_CURSOR +
        cursorPosition(3, 1) +
        'stale' +
        RESTORE_CURSOR +
        eraseToEndOfScreen(),
    );

    expect(terminal.activeLines).toEqual(['$ qwen', '', '']);
    expect(terminal.cursor).toEqual({ x: 6, y: 0 });
  });

  it('clamps cursor-down at the bottom without creating scrollback', () => {
    const terminal = new PhysicalTerminalModel(8, 2);
    terminal.write(cursorDown(20));
    const scrollbackIds = terminal.scrollbackRowIds;

    terminal.write(cursorDown(1));

    expect(terminal.cursor).toEqual({ x: 0, y: 1 });
    expect(terminal.scrollbackRowIds).toEqual(scrollbackIds);
  });

  it('tracks background cells and clears them with the active rendition', () => {
    const terminal = new PhysicalTerminalModel(6, 2);
    terminal.write('\x1b[48;2;52;56;58m  \x1b[0m');

    expect(terminal.activeBackgroundMask).toEqual(['##', '']);

    terminal.write(CURSOR_HOME + ERASE_LINE);

    expect(terminal.activeBackgroundMask).toEqual(['', '']);
  });

  it('advances by terminal columns for wide characters', () => {
    const terminal = new PhysicalTerminalModel(4, 2);

    terminal.write('ab你X');

    expect(terminal.activeLines).toEqual(['ab你', 'X']);
    expect(terminal.cursor).toEqual({ x: 1, y: 1 });
  });
});
