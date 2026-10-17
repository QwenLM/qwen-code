/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config, OutputStyleDefinition } from '@qwen-code/qwen-code-core';
import { BUILT_IN_OUTPUT_STYLES } from '@qwen-code/qwen-code-core';
import { renderWithProviders } from '../../test-utils/render.js';
import { getDialogMaxHeight } from '../utils/layoutUtils.js';
import { DialogManager } from './DialogManager.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from '../contexts/UIActionsContext.js';

const statsDialogProps = vi.hoisted(() => ({
  last: undefined as { sessionAvailableHeight?: number } | undefined,
}));
vi.mock('./StatsDialog.js', () => ({
  StatsDialog: (props: { sessionAvailableHeight?: number }) => {
    statsDialogProps.last = props;
    return null;
  },
}));

const CUSTOM_STYLE: OutputStyleDefinition = {
  name: 'Reviewer',
  source: 'project',
  description: 'Reviews without editing',
  keepCodingInstructions: false,
  prompt: 'Review only.',
};

const createUIState = (overrides: Partial<UIState>): UIState =>
  ({
    constrainHeight: false,
    terminalHeight: 40,
    staticExtraHeight: 0,
    mainAreaWidth: 100,
    auth: {},
    confirmUpdateExtensionRequests: [],
    settingInputRequests: [],
    pluginChoiceRequests: [],
    ...overrides,
  }) as UIState;

const renderDialogManager = (
  uiState: UIState,
  config: Partial<Config>,
): ReturnType<typeof renderWithProviders> =>
  renderWithProviders(
    <UIStateContext.Provider value={uiState}>
      <UIActionsContext.Provider value={{} as UIActions}>
        <DialogManager addItem={vi.fn()} terminalWidth={100} />
      </UIActionsContext.Provider>
    </UIStateContext.Provider>,
    { config: config as Config },
  );

describe('DialogManager', () => {
  // The picker's list comes from the hook, which re-reads the style
  // directories on every open; wiring it to the built-ins instead would hide
  // every custom style and mount the rows during the disk read.
  describe('output style dialog', () => {
    it('offers the styles the session loaded, not just the built-ins', () => {
      const { lastFrame } = renderDialogManager(
        createUIState({
          isOutputStyleDialogOpen: true,
          outputStyleChoices: [...BUILT_IN_OUTPUT_STYLES, CUSTOM_STYLE],
        }),
        { getOutputStyle: vi.fn().mockReturnValue(CUSTOM_STYLE) },
      );

      expect(lastFrame()).toContain('› 6. Reviewer');
    });

    it('shows the loading row while the catalog is still empty', () => {
      const { lastFrame } = renderDialogManager(
        createUIState({
          isOutputStyleDialogOpen: true,
          outputStyleChoices: [],
        }),
        { getOutputStyle: vi.fn().mockReturnValue(undefined) },
      );

      const frame = lastFrame() ?? '';
      expect(frame).toContain('Loading output styles…');
      expect(frame).not.toContain('1. default');
    });
  });

  // The height budget is the only link between the terminal size and the
  // Session tab's scrolling; dropping it silently brings back clipping.
  describe('stats dialog', () => {
    const open = (overrides: Partial<UIState>) => {
      statsDialogProps.last = undefined;
      renderDialogManager(
        createUIState({ isStatsDialogOpen: true, ...overrides }),
        {},
      );
    };

    it('hands the constrained dialog height to StatsDialog as the session budget', () => {
      open({ constrainHeight: true, terminalHeight: 24 });
      expect(statsDialogProps.last?.sessionAvailableHeight).toBe(
        getDialogMaxHeight(24, 0),
      );
    });

    it('passes no budget when the height is unconstrained', () => {
      open({ constrainHeight: false, terminalHeight: 24 });
      expect(statsDialogProps.last).toBeDefined();
      expect(statsDialogProps.last?.sessionAvailableHeight).toBeUndefined();
    });
  });
});
