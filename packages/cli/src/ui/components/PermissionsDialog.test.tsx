/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import * as nodePath from 'node:path';
import { Box, render as inkRender } from 'ink';
import { waitFor } from '@testing-library/react';
import type { Config } from '@qwen-code/qwen-code-core';
import { PermissionsDialog } from './PermissionsDialog.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import type { LoadedSettings } from '../../config/settings.js';

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\u001b\[[0-9;]*m/g, '');

class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  write(data: string): void {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  }
  read(): string | null {
    const data = this.data;
    this.data = null;
    return data;
  }
}

// ink-testing-library hard-codes a 100-column buffer, too narrow to reproduce
// the wide-terminal over-budget this dialog had. Render through ink directly
// with a wide stdout so layout and paint widths agree.
function renderDialogAtWidth(columns: number) {
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
  const stdin = new FakeStdin();
  const config = {
    getPermissionManager: () => null,
    getWorkspaceContext: () => ({
      getDirectories: () => [],
      getInitialDirectories: () => [],
    }),
  } as unknown as Config;
  const settings = {
    merged: {},
    setValue: () => {},
    forScope: () => ({ settings: {} }),
  } as unknown as LoadedSettings;

  const instance = inkRender(
    // Mirror the app shell: the dialog lives in a content area capped at 100
    // columns, so a wider terminal does not widen the painted row.
    <Box marginX={2} width={Math.min(columns - 4, 100)}>
      <ConfigContext.Provider value={config}>
        <SettingsContext.Provider value={settings}>
          <KeypressProvider kittyProtocolEnabled={false}>
            <PermissionsDialog onExit={() => {}} />
          </KeypressProvider>
        </SettingsContext.Provider>
      </ConfigContext.Provider>
    </Box>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  return { lastFrame: () => lastFrame, stdin, unmount: instance.unmount };
}

describe('PermissionsDialog scope rows', () => {
  const originalQwenHome = process.env['QWEN_HOME'];

  afterEach(() => {
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
  });

  it('budgets the row from the layout cap, not from the terminal width', async () => {
    // The companion to the test above: a short QWEN_HOME fits at 200 columns
    // whichever width the row budget came from, so it cannot tell a 200-column
    // budget from the 100-column cap. A home long enough to fill the cap can.
    process.env['QWEN_HOME'] = nodePath.join(
      nodePath.sep,
      'srv',
      'qwen-home-with-a-deliberately-long-name-for-the-budget',
      'shared',
    );
    const originalColumns = Object.getOwnPropertyDescriptor(
      process.stdout,
      'columns',
    );
    Object.defineProperty(process.stdout, 'columns', {
      value: 200,
      configurable: true,
    });
    const { lastFrame, stdin, unmount } = renderDialogAtWidth(200);
    try {
      await waitFor(
        () => expect(stripAnsi(lastFrame())).toContain('Add a new rule'),
        { timeout: 3000 },
      );
      stdin.write('\r');
      await waitFor(
        () => expect(stripAnsi(lastFrame())).toContain('Enter to submit'),
        { timeout: 3000 },
      );
      stdin.write('Bash');
      // `Bash` is already on screen in the example line, so waiting for it
      // proves nothing. The typed text replaces the input's placeholder, which
      // is the barrier the fixed sleep below used to stand in for.
      await waitFor(
        () =>
          expect(stripAnsi(lastFrame())).not.toContain('Enter permission rule'),
        { timeout: 3000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      stdin.write('\r');
      await waitFor(
        () => expect(stripAnsi(lastFrame())).toContain('User settings'),
        { timeout: 3000 },
      );

      const frame = stripAnsi(lastFrame());
      const row = frame
        .split('\n')
        .find((line) => line.includes('User settings'));
      expect(row).toBeDefined();
      // A 200-column budget clips nothing here; the 100-column cap does, and
      // the file name is what falls off. Losing it means the budget grew with
      // the terminal.
      expect(row).toContain('settings.json');
    } finally {
      unmount();
      if (originalColumns) {
        Object.defineProperty(process.stdout, 'columns', originalColumns);
      } else {
        delete (process.stdout as unknown as Record<string, unknown>)[
          'columns'
        ];
      }
    }
  });

  it('keeps the settings file name when the terminal is wider than the layout cap', async () => {
    // The app caps its content area at 100 columns, so a 200-column terminal
    // must not budget the row from 200: the renderer clips at the cap and the
    // file name is what falls off the right edge.
    // A short relocated home keeps the directory in the row: at this width no
    // middle-compression hides it, so the assertion can tell a row built from
    // QWEN_HOME from one that hard-codes `~/.qwen`.
    process.env['QWEN_HOME'] = '/tmp/custom-qwen';
    const originalColumns = Object.getOwnPropertyDescriptor(
      process.stdout,
      'columns',
    );
    Object.defineProperty(process.stdout, 'columns', {
      value: 200,
      configurable: true,
    });
    const { lastFrame, stdin, unmount } = renderDialogAtWidth(200);
    try {
      await waitFor(
        () => expect(stripAnsi(lastFrame())).toContain('Add a new rule'),
        { timeout: 3000 },
      );
      stdin.write('\r');
      await waitFor(
        () => expect(stripAnsi(lastFrame())).toContain('Enter to submit'),
        { timeout: 3000 },
      );
      stdin.write('Bash');
      await waitFor(() => expect(stripAnsi(lastFrame())).toContain('Bash'), {
        timeout: 3000,
      });
      // Let the keypress parser flush the text chunk before the submit Return,
      // otherwise both arrive in one chunk and the Return is read as paste.
      await new Promise((resolve) => setTimeout(resolve, 300));
      stdin.write('\r');
      await waitFor(
        () => expect(stripAnsi(lastFrame())).toContain('User settings'),
        { timeout: 3000 },
      );

      const frame = stripAnsi(lastFrame());
      const row = frame
        .split('\n')
        .find((line) => line.includes('User settings'));
      expect(row).toBeDefined();
      expect(row).toContain('settings.json');
      expect(row).toContain(
        `${nodePath.sep}custom-qwen${nodePath.sep}settings.json`,
      );
    } finally {
      unmount();
      if (originalColumns) {
        Object.defineProperty(process.stdout, 'columns', originalColumns);
      } else {
        delete (process.stdout as unknown as Record<string, unknown>)[
          'columns'
        ];
      }
    }
  });
});
