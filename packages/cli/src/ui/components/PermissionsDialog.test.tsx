/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { PermissionsDialog } from './PermissionsDialog.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import type { LoadedSettings } from '../../config/settings.js';

function renderWithRules(
  rules: Array<{ raw: string; invalid?: boolean }>,
): ReturnType<typeof render> {
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
  const settings = {
    merged: {},
    forScope: () => ({ settings: {} }),
    setValue: vi.fn(),
  } as unknown as LoadedSettings;

  return render(
    <SettingsContext.Provider value={settings}>
      <ConfigContext.Provider value={config}>
        <KeypressProvider kittyProtocolEnabled={false}>
          <PermissionsDialog onExit={() => {}} />
        </KeypressProvider>
      </ConfigContext.Provider>
    </SettingsContext.Provider>,
  );
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
});
