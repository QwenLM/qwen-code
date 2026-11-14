/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Text, Box } from 'ink';
import type { Config } from '@qwen-code/qwen-code-core';
import { renderWithProviders } from '../../test-utils/render.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from '../contexts/UIActionsContext.js';
import { DefaultAppLayout } from './DefaultAppLayout.js';
import { ScreenReaderAppLayout } from './ScreenReaderAppLayout.js';
import type { ModBand } from '../../services/interactive-mod-session.js';

const fixture = vi.hoisted(() => ({ band: undefined as ModBand | undefined }));
vi.mock('../hooks/use-mod-band.js', () => ({ useModBand: () => fixture.band }));
vi.mock('../contexts/VimModeContext.js', () => ({
  useVimModeState: () => ({ vimEnabled: false }),
}));
vi.mock('../contexts/AgentViewContext.js', () => ({
  useAgentViewState: () => ({ activeView: 'main', agents: new Map() }),
}));
vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
}));
vi.mock('../components/MainContent.js', () => ({
  MainContent: () => <Text>{'History 1\nHistory 2\nHistory 3'}</Text>,
}));
vi.mock('../components/Notifications.js', () => ({
  Notifications: () => null,
}));
vi.mock('../components/ExitWarning.js', () => ({ ExitWarning: () => null }));
vi.mock('../components/LoadingIndicator.js', () => ({
  LoadingIndicator: () => null,
}));
vi.mock('../components/InputPrompt.js', () => ({
  InputPrompt: () => (
    <Box borderStyle="single">
      <Text>InputPrompt</Text>
    </Box>
  ),
  calculatePromptWidths: () => ({
    inputWidth: 70,
    suggestionsWidth: 40,
    containerWidth: 74,
  }),
}));
vi.mock('../components/Footer.js', () => ({
  Footer: () => <Text>STATUS-FOOTER</Text>,
}));

const config = {
  getModel: () => 'model',
  getAuthType: () => undefined,
  getTargetDir: () => '/project',
  getDebugMode: () => false,
  getAccessibility: () => ({}),
  getShowResponseTokensPerSecond: () => false,
  getMcpServers: () => ({}),
  getBlockedMcpServers: () => [],
  getModelDisplayName: () => 'Model',
  getCliVersion: () => 'test',
  getContentGeneratorConfig: () => ({ contextWindowSize: 1000 }),
} as unknown as Config;
function state(extra: Partial<UIState> = {}): UIState {
  return {
    constrainHeight: true,
    terminalHeight: 24,
    terminalWidth: 80,
    staticExtraHeight: 3,
    mainAreaWidth: 76,
    auth: {},
    confirmUpdateExtensionRequests: [],
    settingInputRequests: [],
    pluginChoiceRequests: [],
    dialogsVisible: true,
    isStatusLineDialogOpen: true,
    isInputActive: true,
    isConfigInitialized: true,
    messageQueue: [],
    streamingState: null,
    pendingLlmHistoryItems: [],
    mainControlsRef: { current: null },
    stickyTodos: null,
    btwItem: null,
    historyManager: { addItem: vi.fn(), history: [] },
    streamingResponseLengthRef: { current: 0 },
    voiceMicWarnedStatusRef: { current: null },
    ...extra,
  } as unknown as UIState;
}
function renderSurface(surface: React.ReactNode, extra: Partial<UIState> = {}) {
  return renderWithProviders(
    <UIStateContext.Provider value={state(extra)}>
      <UIActionsContext.Provider
        value={{ refreshStatic: vi.fn() } as unknown as UIActions}
      >
        {surface}
      </UIActionsContext.Provider>
    </UIStateContext.Provider>,
    { config },
  );
}
describe('Status line preview layout', () => {
  beforeEach(() => {
    fixture.band = undefined;
  });

  it.each([
    ['default', <DefaultAppLayout key="default" />],
    ['screen-reader', <ScreenReaderAppLayout key="screen-reader" />],
  ] as const)(
    '%s keeps priority approval choices and omits picker composer',
    (_name, layout) => {
      const ui = renderSurface(layout, {
        confirmationRequest: {
          prompt: Array.from(
            { length: 15 },
            (_, i) => `Permission row ${i + 1}`,
          ).join('\n'),
          onConfirm: vi.fn(),
        },
      });
      const frame = ui.lastFrame() ?? '';
      ui.unmount();
      expect(frame).toContain('Yes');
      expect(frame).toContain('No');
      expect(frame).not.toContain('InputPrompt');
    },
  );
  it.each([
    ['default', <DefaultAppLayout key="default" />],
    ['screen-reader', <ScreenReaderAppLayout key="screen-reader" />],
  ] as const)(
    '%s preserves searchable status line configuration when unconstrained',
    (_name, layout) => {
      const ui = renderSurface(layout, { constrainHeight: false });
      expect(ui.lastFrame()).toContain('Configure Status Line');
      expect(ui.lastFrame()).toContain('Type to search');
      expect(ui.lastFrame()).toContain('InputPrompt');
      expect(ui.lastFrame()).toContain('STATUS-FOOTER');
      ui.unmount();
    },
  );
  it('hides the Mod band while keeping the live preview visible', () => {
    fixture.band = {
      owner: 'test-band',
      revision: 1,
      tree: {
        type: 'Text',
        children: [
          Array.from({ length: 8 }, (_, i) => `Band row ${i}`).join('\n'),
        ],
      },
    };
    const ui = renderSurface(<DefaultAppLayout />);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('STATUS-FOOTER');
    expect(frame).toContain('InputPrompt');
    expect(frame).not.toContain('Band row');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    ui.unmount();
  });
  it.each([
    ['default', <DefaultAppLayout key="default" />],
    ['screen-reader', <ScreenReaderAppLayout key="screen-reader" />],
  ] as const)(
    '%s baseline picker and footer fit the 24-row frame',
    (_name, layout) => {
      const ui = renderSurface(layout);
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('STATUS-FOOTER');
      expect(frame).toContain('InputPrompt');
      expect(frame).not.toContain('Band row');
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
      ui.unmount();
    },
  );
});
