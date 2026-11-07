/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { PermissionsDialog } from './PermissionsDialog.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import type { LoadedSettings } from '../../config/settings.js';

function renderWithRules(
  rules: Array<{ raw: string; invalid?: boolean }>,
  options?: { storedAllowRules?: string[]; workspaceOnly?: boolean },
): ReturnType<typeof render> & { setValue: Mock } {
  const config = {
    getPermissionManager: () => ({
      listRules: () =>
        rules.map((rule) => ({
          rule: {
            raw: rule.raw,
            toolName: 'run_shell_command',
            invalid: rule.invalid,
          },
          type: 'allow',
          scope: 'user',
        })),
      addPersistentRule: vi.fn(),
      removePersistentRule: vi.fn(),
      addSessionAllowRule: vi.fn(),
      addSessionAskRule: vi.fn(),
      addSessionDenyRule: vi.fn(),
    }),
    getWorkspaceContext: () => ({
      getDirectories: () => [],
      getInitialDirectories: () => [],
      addDirectory: vi.fn(),
      removeDirectory: vi.fn(),
    }),
  } as unknown as Config;
  const storedAllowRules = options?.storedAllowRules ?? [];
  const setValue = vi.fn();
  const settings = {
    merged: {},
    forScope: (scope: string) =>
      options?.workspaceOnly && scope !== 'Workspace'
        ? { settings: {} }
        : { settings: { permissions: { allow: storedAllowRules } } },
    setValue,
  } as unknown as LoadedSettings;

  const rendered = render(
    <SettingsContext.Provider value={settings}>
      <ConfigContext.Provider value={config}>
        <KeypressProvider kittyProtocolEnabled={false}>
          <PermissionsDialog onExit={() => {}} />
        </KeypressProvider>
      </ConfigContext.Provider>
    </SettingsContext.Provider>,
  );
  return { ...rendered, setValue };
}

/**
 * Send a keypress, retrying it until the frame shows the expected result.
 *
 * The dialog subscribes to keypresses in an effect, so a write that arrives
 * before that effect runs is dropped. Waiting on a rendered marker cannot
 * detect that: the synthetic Add row carries the cursor from the very first
 * frame, before any rule is listed, and a screen that merely exists is not
 * evidence the keypress arrived. Retrying the write is the only signal tied to
 * the subscription itself.
 *
 * One write per retry, spaced by a full poll interval: a second keypress while
 * the first is still being dispatched moves the cursor twice and skips the row
 * the caller asked for.
 */
async function pressUntil(
  stdin: { write: (data: string) => unknown },
  lastFrame: () => string | undefined,
  keys: string,
  expectText: string,
  budget = 40,
): Promise<void> {
  for (let attempt = 0; attempt < budget; attempt += 1) {
    stdin.write(keys);
    try {
      await vi.waitFor(() => expect(lastFrame() ?? '').toContain(expectText), {
        timeout: 100,
        interval: 10,
      });
      return;
    } catch {
      // The keypress was dropped before the subscription existed; retry.
    }
  }
  throw new Error(
    `keypress ${JSON.stringify(keys)} never produced ${expectText}`,
  );
}

const DOWN = '\u001B[B';
const ENTER = '\r';

describe('PermissionsDialog', () => {
  it('marks an unparsable rule and leaves a valid one unmarked', async () => {
    const { lastFrame } = renderWithRules([
      { raw: 'Bash(docker *', invalid: true },
      { raw: 'Bash(rm -rf /tmp)' },
    ]);

    // The marker leads the row: the list truncates from the tail, so a suffix
    // would disappear on a long rule and the row would read as active.
    await vi.waitFor(() =>
      expect(lastFrame() ?? '').toContain('(unparsable) Bash(docker *'),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Bash(rm -rf /tmp)');
    expect(frame).not.toContain('(unparsable) Bash(rm -rf /tmp)');
  });

  it('deletes a stored rule written with surrounding whitespace', async () => {
    // `parseRule` trims, so the listing holds the trimmed text while the
    // settings file may hold the padded one. Comparing untrimmed entries
    // removes the rule from memory only, and it comes back on the next open.
    const { lastFrame, stdin, setValue } = renderWithRules(
      [{ raw: 'Bash(docker *)' }],
      { storedAllowRules: ['  Bash(docker *)  '] },
    );

    await vi.waitFor(() =>
      expect(lastFrame() ?? '').toContain('Bash(docker *)'),
    );
    await pressUntil(stdin, lastFrame, DOWN, '› 2. Bash(docker *)');
    await pressUntil(stdin, lastFrame, ENTER, 'Delete allow rule?');
    stdin.write('\r');
    await vi.waitFor(() =>
      expect(setValue).toHaveBeenCalledWith('User', 'permissions.allow', []),
    );
  });

  it('deletes a padded rule when the stored list also holds a non-string entry', async () => {
    // Settings loading does not validate element types and `parseRules` drops
    // falsy entries, so a `null` can sit in the stored list while the session
    // runs normally. The trim comparison must not call a method on it.
    const { lastFrame, stdin, setValue } = renderWithRules(
      [{ raw: 'Bash(docker *)' }],
      { storedAllowRules: ['  Bash(docker *)  ', null as unknown as string] },
    );

    await vi.waitFor(() =>
      expect(lastFrame() ?? '').toContain('Bash(docker *)'),
    );
    await pressUntil(stdin, lastFrame, DOWN, '› 2. Bash(docker *)');
    await pressUntil(stdin, lastFrame, ENTER, 'Delete allow rule?');
    stdin.write('\r');
    await vi.waitFor(() =>
      expect(setValue).toHaveBeenCalledWith('User', 'permissions.allow', [
        null,
      ]),
    );
  });

  it('deletes only the selected one of two stored spellings', async () => {
    // The add path dedupes with an exact `includes`, so a padded entry plus an
    // exact one can both be stored and both list as the same trimmed row. One
    // delete removes the row it was asked for, not every entry that trims to
    // it.
    const { lastFrame, stdin, setValue } = renderWithRules(
      [{ raw: 'Bash(docker *)' }],
      { storedAllowRules: ['  Bash(docker *)  ', 'Bash(docker *)'] },
    );

    await vi.waitFor(() =>
      expect(lastFrame() ?? '').toContain('Bash(docker *)'),
    );
    await pressUntil(stdin, lastFrame, DOWN, '› 2. Bash(docker *)');
    await pressUntil(stdin, lastFrame, ENTER, 'Delete allow rule?');
    stdin.write('\r');
    await vi.waitFor(() =>
      expect(setValue).toHaveBeenCalledWith('User', 'permissions.allow', [
        'Bash(docker *)',
      ]),
    );
  });

  it('deletes a rule stored only in the workspace scope', async () => {
    // The user scope has no rule list at all, so the delete has to walk on to
    // the workspace scope where the entry lives.
    const { lastFrame, stdin, setValue } = renderWithRules(
      [{ raw: 'Bash(docker *)' }],
      { storedAllowRules: ['Bash(docker *)'], workspaceOnly: true },
    );

    await vi.waitFor(() =>
      expect(lastFrame() ?? '').toContain('Bash(docker *)'),
    );
    await pressUntil(stdin, lastFrame, DOWN, '› 2. Bash(docker *)');
    await pressUntil(stdin, lastFrame, ENTER, 'Delete allow rule?');
    stdin.write('\r');
    await vi.waitFor(() =>
      expect(setValue).toHaveBeenCalledWith(
        'Workspace',
        'permissions.allow',
        [],
      ),
    );
  });
});
