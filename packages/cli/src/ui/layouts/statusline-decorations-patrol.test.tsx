/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { StreamingState } from '../types.js';
import { Text, Box } from 'ink';
import { writeFileSync } from 'node:fs';
import type { Config } from '@qwen-code/qwen-code-core';
import { renderWithProviders, withProviders } from '../../test-utils/render.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from '../contexts/UIActionsContext.js';
import { DefaultAppLayout } from './DefaultAppLayout.js';
import type { ModBand } from '../../services/interactive-mod-session.js';

const fixture = vi.hoisted(() => ({
  band: undefined as ModBand | undefined,
  streamingState: 'idle' as StreamingState,
  toggleShortcuts: undefined as (() => void) | undefined,
}));
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
vi.mock('../components/background-view/LiveAgentPanel.js', () => ({
  LiveAgentPanel: () => null,
}));
vi.mock('../components/Notifications.js', () => ({
  Notifications: () => null,
}));
vi.mock('../components/ExitWarning.js', () => ({ ExitWarning: () => null }));
vi.mock('../contexts/StreamingContext.js', () => ({
  useStreamingContext: () => fixture.streamingState,
}));
vi.mock('../components/InputPrompt.js', () => ({
  InputPrompt: ({ onToggleShortcuts }: { onToggleShortcuts: () => void }) => {
    fixture.toggleShortcuts = onToggleShortcuts;
    return (
      <Box borderStyle="single">
        <Text>InputPrompt</Text>
      </Box>
    );
  },
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
function surfaceTree(surface: React.ReactNode, extra: Partial<UIState> = {}) {
  return (
    <UIStateContext.Provider value={state(extra)}>
      <UIActionsContext.Provider
        value={{ refreshStatic: vi.fn() } as unknown as UIActions}
      >
        {surface}
      </UIActionsContext.Provider>
    </UIStateContext.Provider>
  );
}
function renderSurface(surface: React.ReactNode, extra: Partial<UIState> = {}) {
  return renderWithProviders(surfaceTree(surface, extra), { config });
}
function capture(name: string, frame: string | undefined) {
  if (process.env['PATROL_EVIDENCE'])
    writeFileSync(`${process.env['PATROL_EVIDENCE']}/${name}.txt`, frame ?? '');
  return frame ?? '';
}

describe('Status-line live preview decoration budgets', () => {
  beforeEach(() => {
    fixture.band = undefined;
    fixture.streamingState = StreamingState.Idle;
    fixture.toggleShortcuts = undefined;
  });
  it.each([2, 3, 4])('fits %s queued prompts with the live picker', (count) => {
    const ui = renderSurface(<DefaultAppLayout />, {
      messageQueue: Array.from(
        { length: count },
        (_, i) => `Queued request ${i + 1}`,
      ),
    });
    const frame = capture(`queued-${count}`, ui.lastFrame());
    ui.unmount();
    expect(frame).toContain('STATUS-FOOTER');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
  });
  it('fits one normal loading row while picker is open', () => {
    fixture.streamingState = StreamingState.Responding;
    const ui = renderSurface(<DefaultAppLayout />, {
      streamingState: StreamingState.Responding,
      currentLoadingPhrase: 'Working',
      elapsedTime: 2,
    });
    const frame = capture('loading', ui.lastFrame());
    ui.unmount();
    expect(frame).toContain('STATUS-FOOTER');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
  });
  it('keeps footer visible when a mounted composer had shortcuts expanded', async () => {
    const ui = renderSurface(<DefaultAppLayout />, {
      dialogsVisible: false,
      isStatusLineDialogOpen: false,
    });
    expect(ui.lastFrame()).toContain('InputPrompt');
    expect(fixture.toggleShortcuts).toBeTypeOf('function');
    await act(async () => {
      fixture.toggleShortcuts?.();
    });
    capture('shortcuts-before-picker', ui.lastFrame());
    ui.rerender(withProviders(surfaceTree(<DefaultAppLayout />), { config }));
    const frame = capture('shortcuts-retained', ui.lastFrame());
    ui.unmount();
    expect.soft(frame).toContain('STATUS-FOOTER');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
  });
});
