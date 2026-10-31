/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { Box, render as inkRender } from 'ink';
import { waitFor } from '@testing-library/react';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  SCOPE_LABEL_GAP,
  permissionScopeItems,
} from '../utils/permission-scope-row.js';
import { setLanguageAsync } from '../../i18n/index.js';
import { getCachedStringWidth } from '../utils/textUtils.js';
import { PermissionsDialog } from './PermissionsDialog.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import type { LoadedSettings } from '../../config/settings.js';

describe('permissionScopeItems', () => {
  const originalQwenHome = process.env['QWEN_HOME'];
  // Anchored at the filesystem root so the fixture can never sit under the
  // home directory, where tildeifyPath would rewrite it to `~/...`.
  const qwenHome = nodePath.join(
    nodePath.parse(os.tmpdir()).root,
    'qwen-home-perm-dialog',
  );

  afterEach(() => {
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
  });

  it('shortens the default global settings path to a tilde', () => {
    delete process.env['QWEN_HOME'];
    expect(permissionScopeItems(67)[1]?.description).toBe(
      `Saved in ~${nodePath.sep}.qwen${nodePath.sep}settings.json`,
    );
  });

  it('names the resolved global directory when QWEN_HOME is set', () => {
    process.env['QWEN_HOME'] = qwenHome;
    expect(permissionScopeItems(67)[1]?.description).toBe(
      `Saved in ${qwenHome}${nodePath.sep}settings.json`,
    );
  });

  it('keeps the settings file name when the global directory is deep', () => {
    process.env['QWEN_HOME'] = nodePath.join(
      qwenHome,
      'srv',
      'qwen-runtime',
      'shared',
      'fixtures',
    );
    const description = permissionScopeItems(67)[1]?.description ?? '';
    expect(description.endsWith(`${nodePath.sep}settings.json`)).toBe(true);
    // 50 is the description column this row gets at an 80-column terminal.
    expect(description.length).toBeLessThanOrEqual(50);
  });

  it('strips control characters from a path taken from the environment', () => {
    process.env['QWEN_HOME'] = `${qwenHome}\n\x1b[2J`;
    const description = permissionScopeItems(67)[1]?.description ?? '';

    expect(description).not.toContain('\n');
    expect(description).not.toContain('\x1b');
  });
});

describe('permissionScopeItems row width', () => {
  const originalQwenHome = process.env['QWEN_HOME'];
  const deepQwenHome = nodePath.join(
    nodePath.parse(os.tmpdir()).root,
    'qwen-home-perm-dialog-intl',
    'srv',
    'qwen-runtime',
    'shared',
    'fixtures',
  );
  // label + 4-space gap + description, the row budget at an 80-column terminal.
  const ROW_COLUMNS = 67;

  // Five wide segments: 34 code units but 49 display columns. A budget that
  // counts code units lets this path through unshortened, and the row's clip
  // then eats the file name.
  const wideQwenHome = nodePath.join(
    nodePath.parse(os.tmpdir()).root,
    'tmp',
    '工作区'.repeat(5),
  );

  afterEach(async () => {
    await setLanguageAsync('en');
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
  });

  it.each(['ca', 'de', 'fr', 'ja', 'pt', 'ru', 'zh', 'zh-TW'])(
    'keeps the settings file name inside the row budget in %s',
    async (language) => {
      process.env['QWEN_HOME'] = deepQwenHome;
      await setLanguageAsync(language);
      const item = permissionScopeItems(ROW_COLUMNS)[1]!;

      expect(item.description).toContain('settings.json');
      expect(
        getCachedStringWidth(item.label) +
          SCOPE_LABEL_GAP +
          getCachedStringWidth(item.description),
      ).toBeLessThanOrEqual(ROW_COLUMNS);
    },
  );

  it.each(['ca', 'de', 'en', 'fr', 'ja', 'pt', 'ru', 'zh', 'zh-TW'])(
    'charges wide characters against the row budget in %s',
    async (language) => {
      process.env['QWEN_HOME'] = wideQwenHome;
      await setLanguageAsync(language);
      const item = permissionScopeItems(ROW_COLUMNS)[1]!;

      expect(item.description).toContain('settings.json');
      expect(
        getCachedStringWidth(item.label) +
          SCOPE_LABEL_GAP +
          getCachedStringWidth(item.description),
      ).toBeLessThanOrEqual(ROW_COLUMNS);
    },
  );

  it('budgets from the row it is given, not from an 80-column terminal', () => {
    process.env['QWEN_HOME'] = '/opt/qwen-runtimes/shared/tenant-42/config';
    const item = permissionScopeItems(60)[1]!;
    const row = `${item.label}${' '.repeat(SCOPE_LABEL_GAP)}${item.description}`;

    expect(row).toContain('settings.json');
    expect(getCachedStringWidth(row)).toBeLessThanOrEqual(60);
  });

  it.each([43, 34, 31])(
    'keeps the row inside a %i-column budget',
    (rowColumns) => {
      process.env['QWEN_HOME'] = '/opt/qwen-runtimes/shared/tenant-42/config';
      const item = permissionScopeItems(rowColumns)[1]!;
      const row = `${item.label}${' '.repeat(SCOPE_LABEL_GAP)}${item.description}`;

      // The fallback used to be emitted whatever the row could hold, so the
      // renderer's clip — not this budget — decided whether the name survived.
      expect(getCachedStringWidth(row)).toBeLessThanOrEqual(rowColumns);
    },
  );

  it('keeps the file name once the bare name fits the row', () => {
    process.env['QWEN_HOME'] = '/opt/qwen-runtimes/shared/tenant-42/config';
    const item = permissionScopeItems(43)[1]!;

    expect(item.description).toContain('settings.json');
  });
});

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

  it('keeps the settings file name when the terminal is wider than the layout cap', async () => {
    // The app caps its content area at 100 columns, so a 200-column terminal
    // must not budget the row from 200: the renderer clips at the cap and the
    // file name is what falls off the right edge.
    process.env['QWEN_HOME'] =
      '/opt/qwen-enterprise/runtimes/tenant-42/configuration/shared/config';
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
