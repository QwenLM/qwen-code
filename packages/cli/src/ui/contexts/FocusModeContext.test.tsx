/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import {
  FocusModeProvider,
  useFocusModeActions,
  useFocusModeEnabled,
} from './FocusModeContext.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(workspaceFocus = false, isTrusted = true) {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-focus-provider-'));
  temporaryDirectories.push(directory);
  const settings = new LoadedSettings(
    {
      path: join(directory, 'system.json'),
      settings: {},
      originalSettings: {},
    },
    {
      path: join(directory, 'defaults.json'),
      settings: {},
      originalSettings: {},
    },
    { path: join(directory, 'user.json'), settings: {}, originalSettings: {} },
    {
      path: join(directory, 'workspace.json'),
      settings: workspaceFocus ? { ui: { focusMode: true } } : {},
      originalSettings: {},
    },
    isTrusted,
    new Set(),
  );
  vi.spyOn(settings, 'setValue');
  let actions: ReturnType<typeof useFocusModeActions>;
  function View() {
    actions = useFocusModeActions();
    return <Text>{useFocusModeEnabled() ? 'focused' : 'normal'}</Text>;
  }
  const result = render(
    <FocusModeProvider settings={settings}>
      <View />
    </FocusModeProvider>,
  );
  return { ...result, settings, getActions: () => actions };
}

describe('FocusModeProvider', () => {
  it('synchronizes the effective setting without another persistence write', async () => {
    const { getActions, settings, lastFrame, unmount } = setup();
    await act(async () => {
      settings.setValue(SettingScope.Workspace, 'ui.focusMode', true);
      vi.mocked(settings.setValue).mockClear();
      getActions().syncFocusMode();
    });
    expect(lastFrame()).toContain('focused');
    expect(settings.setValue).not.toHaveBeenCalled();
    unmount();
  });

  it('toggles twice before a render without losing the second toggle', async () => {
    const { getActions, settings, lastFrame, unmount } = setup();
    await act(async () => {
      expect(await getActions().toggleFocusMode()).toBe(true);
      expect(await getActions().toggleFocusMode()).toBe(false);
    });
    expect(settings.setValue).toHaveBeenNthCalledWith(
      2,
      SettingScope.User,
      'ui.focusMode',
      false,
      undefined,
      { throwOnWriteFailure: true },
    );
    expect(lastFrame()).toContain('normal');
    unmount();
  });

  it('keeps the visible state when persistence throws', async () => {
    const { getActions, settings, lastFrame, unmount } = setup();
    mkdirSync(settings.user.path);
    await act(async () => {
      await expect(getActions().toggleFocusMode()).rejects.toThrow();
    });
    expect(lastFrame()).toContain('normal');
    expect(settings.merged.ui?.focusMode ?? false).toBe(false);
    unmount();
  });

  it.each([SettingScope.Workspace, SettingScope.System])(
    'does not change the user preference when %s overrides focus',
    async (scope) => {
      const { getActions, settings, lastFrame, unmount } = setup();
      for (const enabled of [true, false]) {
        await act(async () => {
          settings.setValue(scope, 'ui.focusMode', enabled);
          getActions().syncFocusMode();
        });
        vi.mocked(settings.setValue).mockClear();
        await act(async () => {
          expect(await getActions().toggleFocusMode()).toBe(null);
        });
        expect(lastFrame()).toContain(enabled ? 'focused' : 'normal');
        expect(settings.setValue).not.toHaveBeenCalled();
        expect(existsSync(settings.user.path)).toBe(false);
      }
      unmount();
    },
  );

  it('ignores an untrusted workspace when toggling the user preference', async () => {
    const { getActions, settings, lastFrame, unmount } = setup(true, false);
    await act(async () => {
      expect(await getActions().toggleFocusMode()).toBe(true);
    });
    expect(settings.user.settings.ui?.focusMode).toBe(true);
    expect(lastFrame()).toContain('focused');
    unmount();
  });

  it('allows the user preference to override system defaults', async () => {
    const { getActions, settings, lastFrame, unmount } = setup();
    await act(async () => {
      settings.setValue(SettingScope.SystemDefaults, 'ui.focusMode', true);
      getActions().syncFocusMode();
    });
    await act(async () => {
      expect(await getActions().toggleFocusMode()).toBe(false);
    });
    expect(settings.user.settings.ui?.focusMode).toBe(false);
    expect(lastFrame()).toContain('normal');
    unmount();
  });
});
