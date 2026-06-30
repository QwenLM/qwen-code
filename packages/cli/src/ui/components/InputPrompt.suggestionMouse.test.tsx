/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { act } from '@testing-library/react';
import type { InputPromptProps } from './InputPrompt.js';
import { InputPrompt } from './InputPrompt.js';
import type { TextBuffer } from './shared/text-buffer.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import * as path from 'node:path';
import type { CommandContext, SlashCommand } from '../commands/types.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { UseShellHistoryReturn } from '../hooks/useShellHistory.js';
import { useShellHistory } from '../hooks/useShellHistory.js';
import type { UseCommandCompletionReturn } from '../hooks/useCommandCompletion.js';
import {
  useCommandCompletion,
  CompletionMode,
} from '../hooks/useCommandCompletion.js';
import { useInputHistory } from '../hooks/useInputHistory.js';
import { useReverseSearchCompletion } from '../hooks/useReverseSearchCompletion.js';
import { useVoiceInput } from '../hooks/use-voice-input.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

// Capture the props handed to SuggestionsDisplay so we can drive the mouse
// hover/select callbacks directly, without simulating raw SGR mouse bytes.
const captured = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));

vi.mock('./SuggestionsDisplay.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    SuggestionsDisplay: (props: Record<string, unknown>) => {
      captured.props = props;
      return null;
    },
  };
});

vi.mock('../hooks/useShellHistory.js');
vi.mock('../hooks/useCommandCompletion.js');
vi.mock('../hooks/useInputHistory.js');
vi.mock('../hooks/useReverseSearchCompletion.js');
vi.mock('../hooks/use-voice-input.js');
vi.mock('../contexts/UIStateContext.js', () => ({
  useUIState: vi.fn(() => ({ isFeedbackDialogOpen: false, messageQueue: [] })),
}));
vi.mock('../contexts/UIActionsContext.js', () => ({
  useUIActions: vi.fn(() => ({
    handleRetryLastPrompt: vi.fn(),
    temporaryCloseFeedbackDialog: vi.fn(),
    popAllQueuedMessages: vi.fn(() => null),
  })),
}));
vi.mock('../contexts/AgentViewContext.js', () => ({
  useAgentViewState: vi.fn(() => ({
    activeView: 'main',
    agents: new Map(),
    agentShellFocused: false,
    agentInputBufferText: '',
    agentTabBarFocused: false,
    agentApprovalModes: new Map(),
  })),
  useAgentViewActions: vi.fn(() => ({ setAgentTabBarFocused: vi.fn() })),
}));
vi.mock('../contexts/BackgroundTaskViewContext.js', () => ({
  useBackgroundTaskViewState: vi.fn(() => ({
    entries: [],
    selectedIndex: 0,
    dialogMode: 'closed',
    dialogOpen: false,
    pillFocused: false,
  })),
  useBackgroundTaskViewActions: vi.fn(() => ({
    setPillFocused: vi.fn(),
    setLivePanelFocused: vi.fn(),
    setLivePanelSelectedIndex: vi.fn(),
  })),
}));

const mockSlashCommands: SlashCommand[] = [];

describe('InputPrompt suggestion mouse routing', () => {
  let props: InputPromptProps;
  let mockBuffer: TextBuffer;
  let mockCommandCompletion: UseCommandCompletionReturn;

  const makeBuffer = (text: string): TextBuffer =>
    ({
      text,
      cursor: [0, text.length],
      lines: [text],
      setText: vi.fn(),
      replaceRangeByOffset: vi.fn(),
      viewportVisualLines: [text],
      allVisualLines: [text],
      visualCursor: [0, text.length],
      visualScrollRow: 0,
      handleInput: vi.fn(),
      move: vi.fn(),
      moveToOffset: vi.fn(),
      killLineRight: vi.fn(),
      killLineLeft: vi.fn(),
      openInExternalEditor: vi.fn(),
      newline: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
      backspace: vi.fn(),
      preferredCol: null,
      selectionAnchor: null,
      insert: vi.fn(),
      del: vi.fn(),
      replaceRange: vi.fn(),
      deleteWordLeft: vi.fn(),
      deleteWordRight: vi.fn(),
      visualToLogicalMap: [[0, 0]],
    }) as unknown as TextBuffer;

  beforeEach(() => {
    captured.props = null;
    vi.clearAllMocks();

    mockBuffer = makeBuffer('/sk');
    vi.mocked(useShellHistory).mockReturnValue({
      history: [],
      addCommandToHistory: vi.fn(),
      getPreviousCommand: vi.fn().mockReturnValue(null),
      getNextCommand: vi.fn().mockReturnValue(null),
      resetHistoryPosition: vi.fn(),
    } as UseShellHistoryReturn);

    mockCommandCompletion = {
      suggestions: [
        { label: 'skills', value: 'skills', submitOnAccept: true },
        { label: 'stats', value: 'stats' },
      ],
      activeSuggestionIndex: 0,
      isLoadingSuggestions: false,
      showSuggestions: true,
      visibleStartIndex: 0,
      isPerfectMatch: false,
      midInputGhostText: null,
      completionMode: CompletionMode.SLASH,
      navigateUp: vi.fn(),
      navigateDown: vi.fn(),
      resetCompletionState: vi.fn(),
      dismissCompletion: vi.fn(),
      setActiveSuggestionIndex: vi.fn(),
      setShowSuggestions: vi.fn(),
      handleAutocomplete: vi.fn(),
    } as unknown as UseCommandCompletionReturn;
    vi.mocked(useCommandCompletion).mockReturnValue(mockCommandCompletion);

    vi.mocked(useInputHistory).mockReturnValue({
      navigateUp: vi.fn(),
      navigateDown: vi.fn(),
      handleSubmit: vi.fn(),
      resetHistoryNav: vi.fn(),
    });
    vi.mocked(useReverseSearchCompletion).mockReturnValue({
      suggestions: [],
      activeSuggestionIndex: -1,
      visibleStartIndex: 0,
      showSuggestions: false,
      isLoadingSuggestions: false,
      navigateUp: vi.fn(),
      navigateDown: vi.fn(),
      handleAutocomplete: vi.fn(),
      resetCompletionState: vi.fn(),
      setActiveSuggestionIndex: vi.fn(),
    });
    vi.mocked(useVoiceInput).mockReturnValue({
      status: 'idle',
      interimText: '',
      audioLevel: 0,
      handleKeypress: vi.fn(() => false),
    });

    props = {
      buffer: mockBuffer,
      onSubmit: vi.fn(),
      userMessages: [],
      onClearScreen: vi.fn(),
      config: {
        getProjectRoot: () => path.join('test', 'project'),
        getTargetDir: () => path.join('test', 'project', 'src'),
        getVimMode: () => false,
        getFastModel: () => undefined,
        getWorkspaceContext: () => ({
          getDirectories: () => ['/test/project/src'],
        }),
      } as unknown as Config,
      slashCommands: mockSlashCommands,
      commandContext: createMockCommandContext() as CommandContext,
      shellModeActive: false,
      setShellModeActive: vi.fn(),
      approvalMode: ApprovalMode.DEFAULT,
      inputWidth: 80,
      suggestionsWidth: 80,
      focus: true,
      placeholder: '  Type your message or @path/to/file',
    };
  });

  it('passes the default-source mouse handlers to SuggestionsDisplay', () => {
    const { unmount } = renderWithProviders(<InputPrompt {...props} />);
    expect(captured.props).not.toBeNull();
    expect(typeof captured.props!['onSelectIndex']).toBe('function');
    expect(typeof captured.props!['onHoverIndex']).toBe('function');
    unmount();
  });

  it('hovering a suggestion updates the active index on the default source', () => {
    const { unmount } = renderWithProviders(<InputPrompt {...props} />);
    act(() => {
      (captured.props!['onHoverIndex'] as (i: number) => void)(1);
    });
    expect(mockCommandCompletion.setActiveSuggestionIndex).toHaveBeenCalledWith(
      1,
    );
    unmount();
  });

  it('clicking a leaf command auto-submits it (submitOnAccept), matching Enter', () => {
    const { unmount } = renderWithProviders(<InputPrompt {...props} />);
    act(() => {
      (captured.props!['onSelectIndex'] as (i: number) => void)(0);
    });
    expect(mockCommandCompletion.handleAutocomplete).toHaveBeenCalledWith(0);
    expect(props.onSubmit).toHaveBeenCalledWith('/skills');
    unmount();
  });

  it('clicking a non-leaf suggestion accepts without submitting', () => {
    const { unmount } = renderWithProviders(<InputPrompt {...props} />);
    act(() => {
      (captured.props!['onSelectIndex'] as (i: number) => void)(1);
    });
    expect(mockCommandCompletion.handleAutocomplete).toHaveBeenCalledWith(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it('routes hover/select to the command-search source while command search is active', async () => {
    // Ctrl+R (not in shell mode) enters command search. The mouse handlers
    // must then drive the command-search completion (not the default
    // completion), and a click must accept + reset it and exit search mode.
    const searchCompletion = {
      suggestions: [
        { label: 'first cmd', value: 'first cmd' },
        { label: 'second cmd', value: 'second cmd' },
      ],
      activeSuggestionIndex: 0,
      visibleStartIndex: 0,
      showSuggestions: true,
      isLoadingSuggestions: false,
      navigateUp: vi.fn(),
      navigateDown: vi.fn(),
      handleAutocomplete: vi.fn(),
      resetCompletionState: vi.fn(),
      setActiveSuggestionIndex: vi.fn(),
    };
    vi.mocked(useReverseSearchCompletion).mockReturnValue(searchCompletion);

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    // Enter command-search mode (Ctrl+R).
    await act(async () => {
      stdin.write('\x12');
      await Promise.resolve();
    });

    // Hover routes to the command-search source, not the default completion.
    act(() => {
      (captured.props!['onHoverIndex'] as (i: number) => void)(1);
    });
    expect(searchCompletion.setActiveSuggestionIndex).toHaveBeenCalledWith(1);
    expect(
      mockCommandCompletion.setActiveSuggestionIndex,
    ).not.toHaveBeenCalled();

    // Clicking accepts via the command-search source, resets it, and exits
    // search mode (so the UI can't get stuck in search after a click).
    act(() => {
      (captured.props!['onSelectIndex'] as (i: number) => void)(1);
    });
    expect(searchCompletion.handleAutocomplete).toHaveBeenCalledWith(1);
    expect(searchCompletion.resetCompletionState).toHaveBeenCalled();
    expect(mockCommandCompletion.handleAutocomplete).not.toHaveBeenCalled();
    unmount();
  });

  it('clicking an @folder suggestion dismisses the completion so the dropdown stays closed', () => {
    // @-mention mode showing a directory suggestion: accepting a folder appends
    // no trailing space, so the @ pattern would re-match and re-open the
    // dropdown unless the completion is explicitly dismissed.
    mockBuffer = makeBuffer('@src');
    props.buffer = mockBuffer;
    vi.mocked(useCommandCompletion).mockReturnValue({
      ...mockCommandCompletion,
      completionMode: CompletionMode.AT,
      suggestions: [{ label: 'src/', value: 'src/', isDirectory: true }],
    } as unknown as UseCommandCompletionReturn);

    const { unmount } = renderWithProviders(<InputPrompt {...props} />);
    act(() => {
      (captured.props!['onSelectIndex'] as (i: number) => void)(0);
    });
    expect(mockCommandCompletion.handleAutocomplete).toHaveBeenCalledWith(0);
    expect(mockCommandCompletion.dismissCompletion).toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
    unmount();
  });
});
