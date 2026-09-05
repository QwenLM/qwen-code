/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

function setup(workspaceFocus = false) {
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
    true,
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

  it('reports the effective workspace override after writing the user preference', async () => {
    const { getActions, settings, lastFrame, unmount } = setup(true);
    await act(async () => {
      expect(await getActions().toggleFocusMode()).toBe(true);
    });
    expect(lastFrame()).toContain('focused');
    expect(settings.merged.ui?.focusMode).toBe(true);
    expect(
      JSON.parse(readFileSync(settings.user.path, 'utf8')).ui.focusMode,
    ).toBe(false);
    unmount();
  });
});
