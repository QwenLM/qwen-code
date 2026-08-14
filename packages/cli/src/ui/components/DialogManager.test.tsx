/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { LoadedSettings } from '../../config/settings.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from '../contexts/UIActionsContext.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { DialogManager } from './DialogManager.js';

function createSettings(): LoadedSettings {
  return new LoadedSettings(
    { path: '', settings: {}, originalSettings: {} },
    { path: '', settings: {}, originalSettings: {} },
    { path: '', settings: {}, originalSettings: {} },
    { path: '', settings: {}, originalSettings: {} },
    true,
    new Set(),
  );
}

describe('DialogManager', () => {
  it('wires mainAreaWidth into the skills manager dialog', async () => {
    // The skills dialog caps MultiSelect labels to terminalWidth - 10 so
    // each item stays one terminal row. The only production source of that
    // prop is DialogManager's terminalWidth={mainAreaWidth}; if a refactor
    // drops it, the cap becomes Infinity and this ~113-cell label wraps to
    // 2 rows under ink-testing-library's 100-column buffer.
    const skillManager = {
      listSkills: vi.fn().mockResolvedValue([
        {
          name: 'wiring-probe',
          description:
            'A description deliberately longer than eighty characters so the composed label exceeds one hundred cells',
          level: 'user' as const,
          filePath: '/skills/wiring-probe/SKILL.md',
          body: '',
        },
      ]),
    };
    const config = { getSkillManager: () => skillManager } as unknown as Config;
    const uiState = {
      isSkillsManagerDialogOpen: true,
      constrainHeight: false,
      terminalHeight: 50,
      staticExtraHeight: 0,
      mainAreaWidth: 60,
      // Nested objects/arrays read by earlier branches in the if-chain.
      confirmUpdateExtensionRequests: [],
      settingInputRequests: [],
      pluginChoiceRequests: [],
      auth: {},
    } as unknown as UIState;
    const uiActions = {
      closeSkillsManagerDialog: vi.fn(),
      reloadCommands: vi.fn(),
      setInputBuffer: vi.fn(),
    } as unknown as UIActions;

    const { lastFrame } = render(
      <SettingsContext.Provider value={createSettings()}>
        <ConfigContext.Provider value={config}>
          <UIStateContext.Provider value={uiState}>
            <UIActionsContext.Provider value={uiActions}>
              <KeypressProvider kittyProtocolEnabled={false}>
                <DialogManager addItem={vi.fn()} terminalWidth={120} />
              </KeypressProvider>
            </UIActionsContext.Provider>
          </UIStateContext.Provider>
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('wiring-probe'));
    // Exactly 11 fixed rows + 1 single-row item; a wrapped (uncapped) label
    // adds a row.
    expect(lastFrame()?.split('\n').length).toBe(12);
    // Cap = 60 - 10 overhead = 50 cells, so the label ends in an ellipsis.
    expect(lastFrame()).toContain('…');
  });
});
