/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render as inkRender } from 'ink';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { DiffDialog } from './DiffDialog.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { ShellFocusContext } from '../contexts/ShellFocusContext.js';

// Keep the dialog hermetic: a clean working tree and no turn diffs, matching
// the "Working tree is clean." state, so no git/filesystem access is needed.
vi.mock('../hooks/useDiffData.js', () => ({
  useDiffData: () => ({ result: null, hunks: new Map(), loading: false }),
}));
vi.mock('../hooks/useTurnDiffs.js', () => ({
  useTurnDiffs: () => ({ turns: [], loading: false }),
}));

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\u001b\[[0-9;]*m/g, '');

// ink-testing-library hard-codes a 100-column buffer, too narrow to reproduce
// wide-terminal layout bugs. Render through ink directly with a custom wide
// stdout so the dialog lays out at the requested width.
const renderWide = (columns: number) => {
  let lastFrame = '';
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows: 50,
    write: (frame: string) => {
      lastFrame = frame;
    },
  });
  const stderr = Object.assign(new EventEmitter(), {
    columns,
    rows: 50,
    write: () => {},
  });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    resume: () => {},
    pause: () => {},
    ref: () => {},
    unref: () => {},
    read: () => null,
  });
  const instance = inkRender(
    <ShellFocusContext.Provider value={true}>
      <KeypressProvider kittyProtocolEnabled={false}>
        <DiffDialog
          history={[]}
          cwd="/tmp"
          fileHistoryService={undefined}
          fileCheckpointingEnabled={false}
          onClose={vi.fn()}
        />
      </KeypressProvider>
    </ShellFocusContext.Provider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      // debug:true writes the full frame synchronously (true widths) instead of
      // throttled cursor-diff output, so line widths can be measured.
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  return { lastFrame: () => lastFrame, unmount: instance.unmount };
};

describe('DiffDialog', () => {
  it('caps its width on a wide terminal so the right border is not clipped', async () => {
    // Regression: dialogWidth was Math.min(columns - 4, 110), but the app's
    // main content area is capped at 100 cols (AppContainer). On a wide
    // terminal the dialog overflowed its container and its right border was
    // clipped off-screen.
    const original = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', {
      value: 200,
      configurable: true,
    });
    let unmount: (() => void) | undefined;
    try {
      const r = renderWide(200);
      unmount = r.unmount;
      await waitFor(() => {
        expect(stripAnsi(r.lastFrame())).toContain('Working tree vs HEAD');
      });
      const frame = stripAnsi(r.lastFrame());
      const widest = Math.max(...frame.split('\n').map((line) => line.length));
      expect(widest).toBeLessThanOrEqual(102);
    } finally {
      unmount?.();
      if (original) {
        Object.defineProperty(process.stdout, 'columns', original);
      } else {
        // Non-TTY (CI/piped stdout): `columns` is inherited from the prototype,
        // so there was no own-property to restore. Delete the override we added
        // so it doesn't leak into later test files via useTerminalSize.
        delete (process.stdout as unknown as Record<string, unknown>)[
          'columns'
        ];
      }
    }
  });
});
