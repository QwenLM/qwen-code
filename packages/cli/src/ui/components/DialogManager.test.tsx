/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, OutputStyleDefinition } from '@qwen-code/qwen-code-core';
import { BUILT_IN_OUTPUT_STYLES } from '@qwen-code/qwen-code-core';
import { renderWithProviders, withProviders } from '../../test-utils/render.js';
import { DialogManager } from './DialogManager.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import { STATUS_LINE_COMPOSER_ROWS } from '../status-line-model.js';
import { getDialogMaxHeight } from '../utils/layoutUtils.js';
import {
  UIActionsContext,
  type UIActions,
} from '../contexts/UIActionsContext.js';

const statusLineDialogProps = vi.hoisted(() => vi.fn());
vi.mock('./StatusLineDialog.js', () => ({
  StatusLineDialog: (props: unknown) => {
    statusLineDialogProps(props);
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

const dialogTree = (uiState: UIState) => (
  <UIStateContext.Provider value={uiState}>
    <UIActionsContext.Provider value={{ auth: {} } as UIActions}>
      <DialogManager addItem={vi.fn()} terminalWidth={100} />
    </UIActionsContext.Provider>
  </UIStateContext.Provider>
);

const renderDialogManager = (
  uiState: UIState,
  config: Partial<Config>,
): ReturnType<typeof renderWithProviders> =>
  renderWithProviders(dialogTree(uiState), { config: config as Config });

describe('DialogManager', () => {
  beforeEach(() => statusLineDialogProps.mockClear());
  it.each([true, false])(
    'reserves composer and footer rows for the status line picker (constrained: %s)',
    (constrainHeight) => {
      const terminalHeight = 25;
      const staticExtraHeight = 3;
      renderDialogManager(
        createUIState({
          constrainHeight,
          terminalHeight,
          staticExtraHeight,
          isStatusLineDialogOpen: true,
        }),
        {},
      );
      expect(statusLineDialogProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          availableTerminalHeight:
            getDialogMaxHeight(terminalHeight, staticExtraHeight) -
            (constrainHeight ? STATUS_LINE_COMPOSER_ROWS : 0),
        }),
      );
    },
  );

  it('keeps at least one picker row when the composer fills the terminal', () => {
    renderDialogManager(
      createUIState({
        terminalHeight: 5,
        constrainHeight: true,
        isStatusLineDialogOpen: true,
      }),
      {},
    );
    expect(statusLineDialogProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ availableTerminalHeight: 1 }),
    );
  });

  it.each([14, 24, 40])(
    'keeps the full provider menu at %i rows',
    (terminalHeight) => {
      const uiState = createUIState({
        terminalHeight,
        staticExtraHeight: 3,
        auth: { isAuthDialogOpen: true } as UIState['auth'],
      });
      const { lastFrame, unmount } = renderDialogManager(uiState, {
        getAuthType: () => undefined,
        getContentGeneratorConfig: () => ({ model: 'test-model' }),
      });
      try {
        const fullFrame = lastFrame();
        expect(fullFrame).toContain('Connect a Provider');
        expect(fullFrame).toContain('Custom Provider');
        expect(fullFrame).toContain('Terms of Services and Privacy Notice:');
        expect(fullFrame).toMatch(
          /Token Plan or Standard API Key[^\n]*\n│\s*│\n/,
        );
      } finally {
        unmount();
      }
    },
  );
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

  describe('project hooks approval dialog', () => {
    it.each([true, false])(
      'keeps the dialog inside a 24-row terminal (constrainHeight: %s)',
      (constrainHeight) => {
        const { lastFrame } = renderDialogManager(
          createUIState({
            constrainHeight,
            terminalHeight: 24,
            isProjectHooksApprovalDialogOpen: true,
            pendingProjectHooks: {
              approval: {
                root: '/r',
                hooks: {},
                resolved: {},
                env: { files: {}, settings: null },
              },
              lines: Array.from({ length: 40 }, (_, i) => `Stop  hook-${i}.sh`),
            },
          }),
          {},
        );

        const frame = lastFrame() ?? '';
        expect(frame.split('\n').length).toBeLessThanOrEqual(24);
        expect(frame).toContain('Untrusted hooks in .qwen/settings.json');
        expect(frame).toContain('hook-0.sh');
        expect(frame).toContain('more (see .qwen/settings.json)');
        expect(frame).toContain('Approve these hooks');
      },
    );
  });

  describe('provider update prompt', () => {
    const request = (id: number, providerLabel: string) => ({
      id,
      entries: [
        {
          providerLabel,
          diff: {
            added: ['new-model'],
            removed: [],
            currentModelAffected: false,
          },
        },
      ],
      onConfirm: vi.fn(),
    });

    // A queued prompt replaces the previous one in the same render, so
    // without a remount it would inherit the row highlighted there.
    it('opens the next queued prompt on its default choice', async () => {
      const config = {} as Config;
      const { lastFrame, stdin, rerender } = renderDialogManager(
        createUIState({ providerUpdateRequest: request(1, 'Coding Plan') }),
        config,
      );
      stdin.write('\u001B[B');
      await new Promise((resolve) => setTimeout(resolve, 50));
      stdin.write('\u001B[B');
      await vi.waitFor(() => {
        expect(lastFrame()).toContain('› 3. Remind me later');
      });

      rerender(
        withProviders(
          dialogTree(
            createUIState({ providerUpdateRequest: request(2, 'Token Plan') }),
          ),
          { config },
        ),
      );

      await vi.waitFor(() => {
        expect(lastFrame()).toContain('Token Plan');
        expect(lastFrame()).toContain('› 1. Update all');
      });
    });
  });
});
