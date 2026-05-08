/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { MainContent } from './MainContent.js';
import { AppContext } from '../contexts/AppContext.js';
import { CompactModeProvider } from '../contexts/CompactModeContext.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from '../contexts/UIActionsContext.js';
import { StreamingState, type HistoryItem } from '../types.js';

vi.mock('./HistoryItemDisplay.js', () => ({
  HistoryItemDisplay: ({
    item,
    isPending,
  }: {
    item: HistoryItem;
    isPending: boolean;
  }) => (
    <Text>
      {isPending ? 'pending' : 'static'}:{item.type}
      {'text' in item && typeof item.text === 'string' && item.text.length > 0
        ? `:${item.text}`
        : ''}
    </Text>
  ),
}));

vi.mock('./AppHeader.js', () => ({
  AppHeader: () => <Text>AppHeader</Text>,
}));

vi.mock('./Notifications.js', () => ({
  Notifications: () => <Text>Notifications</Text>,
}));

vi.mock('./DebugModeNotification.js', () => ({
  DebugModeNotification: () => null,
}));

vi.mock('./ShowMoreLines.js', () => ({
  ShowMoreLines: () => <Text>ShowMoreLines</Text>,
}));

const mockUIActions = {
  refreshStatic: vi.fn(),
} as unknown as UIActions;

const baseUIState: Partial<UIState> = {
  history: [],
  historyRemountKey: 0,
  currentModel: 'test-model',
  pendingHistoryItems: [],
  terminalWidth: 25,
  mainAreaWidth: 21,
  staticAreaMaxItemHeight: 124,
  availableTerminalHeight: 16,
  embeddedShellFocused: false,
  activePtyId: undefined,
  streamingState: StreamingState.Responding,
  isReceivingContent: false,
  constrainHeight: true,
  isEditorDialogOpen: false,
  slashCommands: [],
};

const renderMainContent = (uiState: Partial<UIState>) =>
  render(
    <AppContext.Provider value={{ version: 'test', startupWarnings: [] }}>
      <CompactModeProvider value={{ compactMode: false }}>
        <UIActionsContext.Provider value={mockUIActions}>
          <UIStateContext.Provider value={uiState as UIState}>
            <MainContent />
          </UIStateContext.Provider>
        </UIActionsContext.Provider>
      </CompactModeProvider>
    </AppContext.Provider>,
  );

describe('<MainContent />', () => {
  it('shows the waiting placeholder without hiding pending tool output', () => {
    const { lastFrame } = renderMainContent({
      ...baseUIState,
      pendingHistoryItems: [
        { type: 'gemini', text: '\n\n' },
        { type: 'tool_group', tools: [] },
      ],
    });

    const output = lastFrame() ?? '';
    expect(output).toContain('Generating response...');
    expect(output).toContain('pending:tool_group');
  });

  it('stops showing the waiting placeholder once visible assistant content arrives', () => {
    const { lastFrame } = renderMainContent({
      ...baseUIState,
      pendingHistoryItems: [{ type: 'gemini', text: '\n\nvisible token' }],
    });

    const output = lastFrame() ?? '';
    expect(output).not.toContain('Generating response...');
    expect(output).toContain('pending:gemini');
    expect(output).toContain('visible token');
  });

  it('keeps fence-only assistant pending content in waiting state', () => {
    const { lastFrame } = renderMainContent({
      ...baseUIState,
      pendingHistoryItems: [{ type: 'gemini', text: '```mermaid' }],
    });

    const output = lastFrame() ?? '';
    expect(output).toContain('Generating response...');
    expect(output).not.toContain('pending:gemini');
  });
});
