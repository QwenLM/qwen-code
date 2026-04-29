/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, type Mock } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { DefaultAppLayout } from './DefaultAppLayout.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from '../contexts/UIActionsContext.js';
import { useAgentViewState } from '../contexts/AgentViewContext.js';
import { StreamingState } from '../types.js';

vi.mock('../components/MainContent.js', () => ({
  MainContent: () => <Text>MainContent</Text>,
}));

vi.mock('../components/DialogManager.js', () => ({
  DialogManager: () => <Text>DialogManager</Text>,
}));

vi.mock('../components/Composer.js', () => ({
  Composer: () => <Text>Composer</Text>,
}));

vi.mock('../components/ExitWarning.js', () => ({
  ExitWarning: () => <Text>ExitWarning</Text>,
}));

vi.mock('../components/messages/BtwMessage.js', () => ({
  BtwMessage: () => <Text>BtwMessage</Text>,
}));

vi.mock('../components/StickyTodoList.js', () => ({
  StickyTodoList: () => <Text>StickyTodoList</Text>,
}));

vi.mock('../components/agent-view/AgentTabBar.js', () => ({
  AgentTabBar: () => <Text>AgentTabBar</Text>,
}));

vi.mock('../components/agent-view/AgentChatView.js', () => ({
  AgentChatView: () => <Text>AgentChatView</Text>,
}));

vi.mock('../components/agent-view/AgentComposer.js', () => ({
  AgentComposer: () => <Text>AgentComposer</Text>,
}));

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 80 }),
}));

vi.mock('../contexts/AgentViewContext.js', () => ({
  useAgentViewState: vi.fn(),
}));

const mockedUseAgentViewState = useAgentViewState as Mock;

const mockUIActions = {
  refreshStatic: vi.fn(),
} as unknown as UIActions;

const baseUIState: Partial<UIState> = {
  dialogsVisible: false,
  isFeedbackDialogOpen: false,
  mainControlsRef: { current: null },
  mainAreaWidth: 80,
  terminalWidth: 80,
  streamingState: StreamingState.Idle,
  historyManager: {
    addItem: vi.fn(),
    history: [],
    updateItem: vi.fn(),
    clearItems: vi.fn(),
    loadHistory: vi.fn(),
    truncateToItem: vi.fn(),
  },
  stickyTodos: [
    {
      id: 'todo-1',
      content: 'Pinned task',
      status: 'pending',
    },
  ],
  btwItem: null,
};

const renderLayout = (uiState: Partial<UIState>) =>
  render(
    <UIActionsContext.Provider value={mockUIActions}>
      <UIStateContext.Provider value={uiState as UIState}>
        <DefaultAppLayout />
      </UIStateContext.Provider>
    </UIActionsContext.Provider>,
  );

describe('DefaultAppLayout', () => {
  it('renders sticky todo list before the composer in the main view', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'main',
      agents: new Map(),
    });

    const { lastFrame } = renderLayout(baseUIState);
    const output = lastFrame() ?? '';

    expect(output).toContain('StickyTodoList');
    expect(output.indexOf('StickyTodoList')).toBeGreaterThan(
      output.indexOf('MainContent'),
    );
    expect(output.indexOf('StickyTodoList')).toBeLessThan(
      output.indexOf('Composer'),
    );
  });

  it('does not render sticky todo list when dialogs are visible', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'main',
      agents: new Map(),
    });

    const { lastFrame } = renderLayout({
      ...baseUIState,
      dialogsVisible: true,
    });

    const output = lastFrame() ?? '';
    expect(output).not.toContain('StickyTodoList');
    expect(output).toContain('DialogManager');
  });

  it('does not render sticky todo list while waiting for confirmation', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'main',
      agents: new Map(),
    });

    const { lastFrame } = renderLayout({
      ...baseUIState,
      streamingState: StreamingState.WaitingForConfirmation,
    });

    const output = lastFrame() ?? '';
    expect(output).not.toContain('StickyTodoList');
    expect(output).toContain('Composer');
  });

  it('does not render sticky todo list when feedback dialog is open', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'main',
      agents: new Map(),
    });

    const { lastFrame } = renderLayout({
      ...baseUIState,
      isFeedbackDialogOpen: true,
    });

    const output = lastFrame() ?? '';
    expect(output).not.toContain('StickyTodoList');
    expect(output).toContain('Composer');
  });

  it('does not render sticky todo list in an agent tab view', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'agent-1',
      agents: new Map([['agent-1', {}]]),
    });

    const { lastFrame } = renderLayout(baseUIState);

    const output = lastFrame() ?? '';
    expect(output).not.toContain('StickyTodoList');
    expect(output).toContain('AgentChatView');
    expect(output).toContain('AgentComposer');
  });
});
