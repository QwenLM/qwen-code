/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Box } from 'ink';
import type { Config } from '@qwen-code/qwen-code-core';
import { LoadedSettings } from '../../config/settings.js';
import { setLanguageAsync } from '../../i18n/index.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { UIStateContext } from '../contexts/UIStateContext.js';
import type { UIState } from '../contexts/UIStateContext.js';
import { UIActionsContext } from '../contexts/UIActionsContext.js';
import type { UIActions } from '../contexts/UIActionsContext.js';
import type { DescriptiveRadioButtonSelectProps } from '../components/shared/DescriptiveRadioButtonSelect.js';
import { AuthDialog } from './AuthDialog.js';

const menu = vi.hoisted(() => ({
  select: undefined as ((value: string) => void) | undefined,
}));

vi.mock(
  '../components/shared/DescriptiveRadioButtonSelect.js',
  async (load) => {
    const actual =
      await load<
        typeof import('../components/shared/DescriptiveRadioButtonSelect.js')
      >();
    return {
      ...actual,
      DescriptiveRadioButtonSelect: (
        props: DescriptiveRadioButtonSelectProps<string>,
      ) => {
        menu.select = props.onSelect;
        return <actual.DescriptiveRadioButtonSelect {...props} />;
      },
    };
  },
);

function renderMenu(width: number, height: number) {
  const empty = { path: '', settings: {}, originalSettings: {} };
  const settings = new LoadedSettings(
    empty,
    empty,
    empty,
    empty,
    true,
    new Set(),
  );
  const config = {
    getAuthType: () => undefined,
    getContentGeneratorConfig: () => undefined,
  } as unknown as Config;
  const state = {
    mainAreaWidth: width,
    auth: { authError: null },
  } as UIState;
  const actions = {
    auth: {
      closeAuthDialog: vi.fn(),
      handleProviderSubmit: vi.fn(),
      onAuthError: vi.fn(),
    },
  } as unknown as UIActions;
  return renderWithProviders(
    <UIStateContext.Provider value={state}>
      <UIActionsContext.Provider value={actions}>
        <Box width={width} flexDirection="column">
          <AuthDialog availableTerminalHeight={height} />
        </Box>
      </UIActionsContext.Provider>
    </UIStateContext.Provider>,
    { settings, config },
  );
}

describe('AuthDialog navigation hint', () => {
  beforeEach(async () => {
    menu.select = undefined;
    await setLanguageAsync('en');
  });

  it.each([
    { width: 36, height: 14 },
    { width: 36, height: 6 },
    { width: 100, height: 14 },
  ])(
    'keeps the complete submenu hint within $width columns and $height rows',
    async ({ width, height }) => {
      const { lastFrame, unmount } = renderMenu(width, height);
      try {
        await vi.waitFor(() => expect(lastFrame()).toContain('QwenCloud'));
        expect(menu.select).toBeTypeOf('function');
        menu.select?.('THIRD_PARTY_PROVIDERS');
        await vi.waitFor(() => expect(lastFrame()).toContain('DeepSeek'));

        const frame = lastFrame() ?? '';
        expect(frame.replace(/[│\s]/g, '')).toContain(
          'Entertoselect,↑↓tonavigate,Esctogoback',
        );
        expect(frame.split('\n').length).toBeLessThanOrEqual(height);
      } finally {
        unmount();
      }
    },
  );

  it.each([36, 100])(
    'keeps the main-menu terms visible at width %i',
    async (width) => {
      const { lastFrame, unmount } = renderMenu(width, 14);
      try {
        await vi.waitFor(() => expect(lastFrame()).toContain('QwenCloud'));
        const frame = lastFrame() ?? '';
        expect(frame.replace(/[│\s]/g, '')).toContain(
          'https://qwenlm.github.io/qwen-code-docs/en/users/support/tos-privacy/',
        );
        expect(frame.split('\n').length).toBeLessThanOrEqual(14);
      } finally {
        unmount();
      }
    },
  );
});
