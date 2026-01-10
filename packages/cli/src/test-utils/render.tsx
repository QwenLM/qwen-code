/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import type React from 'react';
import type { Config } from '@qwen-code/qwen-code-core';
import { LoadedSettings } from '../config/settings.js';
import { KeypressProvider } from '../ui/contexts/KeypressContext.js';
import { SettingsContext } from '../ui/contexts/SettingsContext.js';
import { ShellFocusContext } from '../ui/contexts/ShellFocusContext.js';
import { ConfigContext } from '../ui/contexts/ConfigContext.js';

const mockSettings = new LoadedSettings(
  { path: '', settings: {}, originalSettings: {} },
  { path: '', settings: {}, originalSettings: {} },
  { path: '', settings: {}, originalSettings: {} },
  { path: '', settings: {}, originalSettings: {} },
  true,
  new Set(),
);

export const renderWithProviders = (
  component: React.ReactElement,
  {
    shellFocus = true,
    settings = mockSettings,
    config = undefined,
  }: {
    shellFocus?: boolean;
    settings?: LoadedSettings;
    config?: Config;
  } = {},
): ReturnType<typeof render> =>
  render(
    <SettingsContext.Provider value={settings}>
      <ConfigContext.Provider value={config}>
        <ShellFocusContext.Provider value={shellFocus}>
          <KeypressProvider kittyProtocolEnabled={true}>
            {component}
          </KeypressProvider>
        </ShellFocusContext.Provider>
      </ConfigContext.Provider>
    </SettingsContext.Provider>,
  );
