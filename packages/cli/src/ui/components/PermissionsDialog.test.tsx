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
  options?: { storedAllowRules?: string[] },
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
    forScope: () => ({
      settings: { permissions: { allow: storedAllowRules } },
    }),
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
    stdin.write('\u001B[B'); // Down to the first rule
    await vi.waitFor(() =>
      expect(lastFrame() ?? '').toContain('› 2. Bash(docker *)'),
    );
    stdin.write('\r');
    await vi.waitFor(() =>
      expect(lastFrame() ?? '').toContain('Delete allow rule?'),
    );
    stdin.write('\r');
    await vi.waitFor(() =>
      expect(setValue).toHaveBeenCalledWith('User', 'permissions.allow', []),
    );
  });
});
