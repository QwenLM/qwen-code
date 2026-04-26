/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { ScreenReaderAppLayout } from './ScreenReaderAppLayout.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import { StreamingState } from '../types.js';

vi.mock('../components/Notifications.js', () => ({
  Notifications: () => <Text>Notifications</Text>,
}));

vi.mock('../components/MainContent.js', () => ({
  MainContent: () => <Text>MainContent</Text>,
}));

vi.mock('../components/DialogManager.js', () => ({
  DialogManager: () => <Text>DialogManager</Text>,
}));

vi.mock('../components/Composer.js', () => ({
  Composer: () => <Text>Composer</Text>,
}));

vi.mock('../components/Footer.js', () => ({
  Footer: () => <Text>Footer</Text>,
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

const baseUIState: Partial<UIState> = {
  dialogsVisible: false,
  isFeedbackDialogOpen: false,
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
    <UIStateContext.Provider value={uiState as UIState}>
      <ScreenReaderAppLayout />
    </UIStateContext.Provider>,
  );

describe('ScreenReaderAppLayout', () => {
  it('renders sticky todo list before the composer', () => {
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
    const { lastFrame } = renderLayout({
      ...baseUIState,
      dialogsVisible: true,
    });

    const output = lastFrame() ?? '';
    expect(output).not.toContain('StickyTodoList');
    expect(output).toContain('DialogManager');
  });

  it('does not render sticky todo list while waiting for confirmation', () => {
    const { lastFrame } = renderLayout({
      ...baseUIState,
      streamingState: StreamingState.WaitingForConfirmation,
    });

    const output = lastFrame() ?? '';
    expect(output).not.toContain('StickyTodoList');
    expect(output).toContain('Composer');
  });

  it('does not render sticky todo list when feedback dialog is open', () => {
    const { lastFrame } = renderLayout({
      ...baseUIState,
      isFeedbackDialogOpen: true,
    });

    const output = lastFrame() ?? '';
    expect(output).not.toContain('StickyTodoList');
    expect(output).toContain('Composer');
  });
});
