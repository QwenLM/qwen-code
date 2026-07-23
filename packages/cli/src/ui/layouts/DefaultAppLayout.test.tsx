/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render } from 'ink-testing-library';
import { act } from '@testing-library/react';
import { Text } from 'ink';
import type { FleetViewProps } from '../components/fleet-view/FleetView.js';
import { DefaultAppLayout } from './DefaultAppLayout.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from '../contexts/UIActionsContext.js';
import { useAgentViewState } from '../contexts/AgentViewContext.js';
import { StreamingState } from '../types.js';

const dialogManagerMockState = vi.hoisted(() => ({ lineCount: 1 }));

vi.mock('../components/MainContent.js', () => ({
  MainContent: () => <Text>MainContent</Text>,
}));

vi.mock('../components/UpdateNotification.js', () => ({
  UpdateNotification: ({ message }: { message: string }) => (
    <Text>{`UpdateNotification: ${message}`}</Text>
  ),
}));

vi.mock('../components/DialogManager.js', () => ({
  DialogManager: () => (
    <Text>
      {Array.from(
        { length: dialogManagerMockState.lineCount },
        (_, i) => `DialogManager ${i + 1}`,
      ).join('\n')}
    </Text>
  ),
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

const fleetViewProps = vi.hoisted(() => ({
  current: null as unknown as FleetViewProps,
}));

vi.mock('../components/fleet-view/FleetView.js', () => ({
  FleetView: (props: FleetViewProps) => {
    fleetViewProps.current = props;
    return null;
  },
}));

const mockRemoveSession = vi.hoisted(() => vi.fn());
const mockConfig = vi.hoisted(() => ({
  getSessionId: vi.fn(() => 'current-session'),
  getSessionService: vi.fn(() => ({ removeSession: mockRemoveSession })),
  getWorkingDir: vi.fn(() => '/work'),
}));

vi.mock('../contexts/ConfigContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contexts/ConfigContext.js')>()),
  useConfig: () => mockConfig,
}));

vi.mock('../contexts/SettingsContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contexts/SettingsContext.js')>()),
  useSettings: () => ({ merged: { ui: {} } }),
}));

const fleetSessionsState = vi.hoisted(() => ({
  sessions: [] as unknown[],
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
}));

vi.mock('../hooks/use-fleet-view-sessions.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../hooks/use-fleet-view-sessions.js')
  >()),
  useFleetViewSessions: () => fleetSessionsState,
}));

const mockUIActions = {
  refreshStatic: vi.fn(),
  setFleetDoubleTapPending: vi.fn(),
  closeFleetView: vi.fn(),
  handleResume: vi.fn(),
  handleFinalSubmit: vi.fn(),
} as unknown as UIActions;

const baseUIState: Partial<UIState> = {
  dialogsVisible: false,
  isFeedbackDialogOpen: false,
  mainControlsRef: { current: null },
  mainAreaWidth: 80,
  terminalWidth: 80,
  terminalHeight: 24,
  staticExtraHeight: 0,
  constrainHeight: true,
  streamingState: StreamingState.Responding,
  historyManager: {
    addItem: vi.fn(),
    history: [],
    updateItem: vi.fn(),
    clearItems: vi.fn(),
    loadHistory: vi.fn(),
    truncateToItem: vi.fn(),
    compactOldItems: vi.fn(),
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

function frameHeight(frame: string): number {
  return frame.length === 0 ? 0 : frame.split('\n').length;
}

describe('DefaultAppLayout', () => {
  beforeEach(() => {
    dialogManagerMockState.lineCount = 1;
  });

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

  it('renders an update that arrives after startup above the composer', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'main',
      agents: new Map(),
    });

    const { lastFrame } = renderLayout({
      ...baseUIState,
      updateInfo: {
        message: 'Update successful!',
        update: {
          latest: '0.20.0',
          current: '0.19.12',
          type: 'latest',
          name: '@qwen-code/qwen-code',
        },
      },
    });
    const output = lastFrame() ?? '';

    expect(output).toContain('UpdateNotification: Update successful!');
    expect(output.indexOf('UpdateNotification')).toBeLessThan(
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
    expect(output).toContain('DialogManager 1');
  });

  it('keeps a tall dialog within the terminal frame when it appears', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'main',
      agents: new Map(),
    });
    dialogManagerMockState.lineCount = 20;
    const terminalHeight = 8;

    const { lastFrame } = renderLayout({
      ...baseUIState,
      dialogsVisible: true,
      terminalHeight,
    });

    const output = lastFrame() ?? '';
    expect(frameHeight(output)).toBeLessThanOrEqual(terminalHeight);
    expect(output).toContain('DialogManager 1');
    expect(output).not.toContain('DialogManager 20');
  });

  it('does not cap a tall dialog when height constraints are disabled', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'main',
      agents: new Map(),
    });
    dialogManagerMockState.lineCount = 20;
    const terminalHeight = 8;

    const { lastFrame } = renderLayout({
      ...baseUIState,
      dialogsVisible: true,
      terminalHeight,
      constrainHeight: false,
    });

    const output = lastFrame() ?? '';
    expect(frameHeight(output)).toBeGreaterThan(terminalHeight);
    expect(output).toContain('DialogManager 20');
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

  it('does not render sticky todo list when agent is idle', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'main',
      agents: new Map(),
    });

    const { lastFrame } = renderLayout({
      ...baseUIState,
      streamingState: StreamingState.Idle,
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

  it('renders update notifications in an agent tab view', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'agent-1',
      agents: new Map([['agent-1', {}]]),
    });

    const { lastFrame } = renderLayout({
      ...baseUIState,
      updateInfo: {
        message: 'Update successful!',
        update: {
          latest: '0.20.0',
          current: '0.19.12',
          type: 'latest',
          name: '@qwen-code/qwen-code',
        },
      },
    });
    const output = lastFrame() ?? '';

    expect(output).toContain('UpdateNotification: Update successful!');
    expect(output.indexOf('UpdateNotification')).toBeLessThan(
      output.indexOf('AgentComposer'),
    );
  });

  describe('FleetViewContainer', () => {
    const renderFleet = () => {
      mockedUseAgentViewState.mockReturnValue({
        activeView: 'main',
        agents: new Map(),
      });
      return renderLayout({ ...baseUIState, isFleetViewOpen: true });
    };

    beforeEach(() => {
      vi.clearAllMocks();
      fleetSessionsState.sessions = [];
      fleetSessionsState.loading = false;
      fleetSessionsState.error = null;
    });

    it('does not resume when attaching to the current session', () => {
      renderFleet();
      act(() => {
        fleetViewProps.current.onAttach('current-session');
      });
      expect(mockUIActions.closeFleetView).toHaveBeenCalled();
      expect(mockUIActions.handleResume).not.toHaveBeenCalled();
    });

    it('resumes a different session on attach', () => {
      renderFleet();
      act(() => {
        fleetViewProps.current.onAttach('other-session');
      });
      expect(mockUIActions.handleResume).toHaveBeenCalledWith('other-session');
    });

    it('refuses to delete the current session', () => {
      renderFleet();
      let result = true;
      act(() => {
        result = fleetViewProps.current.onDelete('current-session');
      });
      expect(result).toBe(false);
      expect(mockRemoveSession).not.toHaveBeenCalled();
    });

    it('deletes and refreshes a non-current session', () => {
      mockRemoveSession.mockResolvedValue(undefined);
      renderFleet();
      let result = false;
      act(() => {
        result = fleetViewProps.current.onDelete('other-session');
      });
      expect(result).toBe(true);
      expect(mockRemoveSession).toHaveBeenCalledWith('other-session');
    });

    it('dispatches the typed prompt and closes', () => {
      renderFleet();
      act(() => {
        fleetViewProps.current.onDispatch!('fix the bug');
      });
      expect(mockUIActions.closeFleetView).toHaveBeenCalled();
      expect(mockUIActions.handleFinalSubmit).toHaveBeenCalledWith(
        'fix the bug',
      );
    });
  });
});
