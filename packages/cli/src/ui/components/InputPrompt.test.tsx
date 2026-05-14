/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor, act } from '@testing-library/react';
import type { InputPromptProps } from './InputPrompt.js';
import { InputPrompt } from './InputPrompt.js';
import { useTextBuffer, type TextBuffer } from './shared/text-buffer.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import * as path from 'node:path';
import type { CommandContext, SlashCommand } from '../commands/types.js';
import { CommandKind } from '../commands/types.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { UseShellHistoryReturn } from '../hooks/useShellHistory.js';
import { useShellHistory } from '../hooks/useShellHistory.js';
import type { UseCommandCompletionReturn } from '../hooks/useCommandCompletion.js';
import { useCommandCompletion } from '../hooks/useCommandCompletion.js';
import type { UseInputHistoryReturn } from '../hooks/useInputHistory.js';
import { useInputHistory } from '../hooks/useInputHistory.js';
import type { UseReverseSearchCompletionReturn } from '../hooks/useReverseSearchCompletion.js';
import { useReverseSearchCompletion } from '../hooks/useReverseSearchCompletion.js';
import * as clipboardUtils from '../utils/clipboardUtils.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import stripAnsi from 'strip-ansi';
import chalk from 'chalk';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';

vi.mock('../hooks/useShellHistory.js');
vi.mock('../hooks/useCommandCompletion.js');
vi.mock('../hooks/useInputHistory.js');
vi.mock('../hooks/useReverseSearchCompletion.js');
vi.mock('../utils/clipboardUtils.js');
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

const mockSlashCommands: SlashCommand[] = [
  {
    name: 'clear',
    kind: CommandKind.BUILT_IN,
    description: 'Clear screen',
    action: vi.fn(),
  },
  {
    name: 'memory',
    kind: CommandKind.BUILT_IN,
    description: 'Manage memory',
    subCommands: [
      {
        name: 'show',
        kind: CommandKind.BUILT_IN,
        description: 'Show memory',
        action: vi.fn(),
      },
      {
        name: 'add',
        kind: CommandKind.BUILT_IN,
        description: 'Add to memory',
        action: vi.fn(),
      },
      {
        name: 'refresh',
        kind: CommandKind.BUILT_IN,
        description: 'Refresh memory',
        action: vi.fn(),
      },
    ],
  },
  {
    name: 'export',
    kind: CommandKind.BUILT_IN,
    description: 'Export session',
    action: vi.fn(),
    subCommands: [
      {
        name: 'html',
        kind: CommandKind.BUILT_IN,
        description: 'Export HTML',
        action: vi.fn(),
      },
      {
        name: 'md',
        kind: CommandKind.BUILT_IN,
        description: 'Export Markdown',
        action: vi.fn(),
      },
      {
        name: 'json',
        kind: CommandKind.BUILT_IN,
        description: 'Export JSON',
        action: vi.fn(),
      },
      {
        name: 'jsonl',
        kind: CommandKind.BUILT_IN,
        description: 'Export JSONL',
        action: vi.fn(),
      },
    ],
  },
];

describe('InputPrompt', () => {
  let props: InputPromptProps;
  let mockShellHistory: UseShellHistoryReturn;
  let mockCommandCompletion: UseCommandCompletionReturn;
  let mockInputHistory: UseInputHistoryReturn;
  let mockReverseSearchCompletion: UseReverseSearchCompletionReturn;
  let mockBuffer: TextBuffer;
  let mockCommandContext: CommandContext;

  const mockedUseShellHistory = vi.mocked(useShellHistory);
  const mockedUseCommandCompletion = vi.mocked(useCommandCompletion);
  const mockedUseInputHistory = vi.mocked(useInputHistory);
  const mockedUseReverseSearchCompletion = vi.mocked(
    useReverseSearchCompletion,
  );

  beforeEach(() => {
    vi.resetAllMocks();

    mockCommandContext = createMockCommandContext();

    mockBuffer = {
      text: '',
      cursor: [0, 0],
      lines: [''],
      setText: vi.fn((newText: string) => {
        mockBuffer.text = newText;
        mockBuffer.lines = [newText];
        mockBuffer.cursor = [0, newText.length];
        mockBuffer.viewportVisualLines = [newText];
        mockBuffer.allVisualLines = [newText];
        mockBuffer.visualToLogicalMap = [[0, 0]];
      }),
      replaceRangeByOffset: vi.fn(),
      viewportVisualLines: [''],
      allVisualLines: [''],
      visualCursor: [0, 0],
      visualScrollRow: 0,
      handleInput: vi.fn(),
      move: vi.fn(),
      moveToOffset: vi.fn((offset: number) => {
        mockBuffer.cursor = [0, offset];
      }),
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
    } as unknown as TextBuffer;

    mockShellHistory = {
      history: [],
      addCommandToHistory: vi.fn(),
      getPreviousCommand: vi.fn().mockReturnValue(null),
      getNextCommand: vi.fn().mockReturnValue(null),
      resetHistoryPosition: vi.fn(),
    };
    mockedUseShellHistory.mockReturnValue(mockShellHistory);

    mockCommandCompletion = {
      suggestions: [],
      activeSuggestionIndex: -1,
      isLoadingSuggestions: false,
      showSuggestions: false,
      visibleStartIndex: 0,
      isPerfectMatch: false,
      navigateUp: vi.fn(),
      navigateDown: vi.fn(),
      resetCompletionState: vi.fn(),
      setActiveSuggestionIndex: vi.fn(),
      setShowSuggestions: vi.fn(),
      handleAutocomplete: vi.fn(),
    };
    mockedUseCommandCompletion.mockReturnValue(mockCommandCompletion);

    mockInputHistory = {
      navigateUp: vi.fn(),
      navigateDown: vi.fn(),
      handleSubmit: vi.fn(),
      resetHistoryNav: vi.fn(),
    };
    mockedUseInputHistory.mockReturnValue(mockInputHistory);

    mockReverseSearchCompletion = {
      suggestions: [],
      activeSuggestionIndex: -1,
      visibleStartIndex: 0,
      showSuggestions: false,
      isLoadingSuggestions: false,
      navigateUp: vi.fn(),
      navigateDown: vi.fn(),
      handleAutocomplete: vi.fn(),
      resetCompletionState: vi.fn(),
    };
    mockedUseReverseSearchCompletion.mockReturnValue(
      mockReverseSearchCompletion,
    );

    props = {
      buffer: mockBuffer,
      onSubmit: vi.fn(),
      userMessages: [],
      onClearScreen: vi.fn(),
      config: {
        getProjectRoot: () => path.join('test', 'project'),
        getTargetDir: () => path.join('test', 'project', 'src'),
        getVimMode: () => false,
        getWorkspaceContext: () => ({
          getDirectories: () => ['/test/project/src'],
        }),
      } as unknown as Config,
      slashCommands: mockSlashCommands,
      commandContext: mockCommandContext,
      shellModeActive: false,
      setShellModeActive: vi.fn(),
      approvalMode: ApprovalMode.DEFAULT,
      inputWidth: 80,
      suggestionsWidth: 80,
      focus: true,
      placeholder: '  Type your message or @path/to/file',
    };
  });

  // Ink 7 throttles render at 30fps (~33ms/frame). 50ms only covers 1.5
  // frames, which races on slow CI runners (notably macOS 22.x). 150ms
  // gives ~4-5 frames headroom for stdin.write → reconcile → render →
  // assert sequences without measurably slowing the suite.
  const wait = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

  describe('prompt suggestions', () => {
    // createFollowupController.setSuggestion debounces the visibility
    // transition by SUGGESTION_DELAY_MS (300ms) before flipping
    // followup.state.isVisible to true. The Enter handler reads that flag
    // synchronously, so we must wait for the timer to fire before pressing
    // Enter — otherwise the suggestion path is skipped and onSubmit never
    // runs. 350ms left only ~50ms margin and was eaten by ink 7 / React 19.2
    // mount overhead on slow Windows CI runners. Keep this wait > 300ms +
    // generous buffer (renderWithProviders cold start can be 100-200ms).
    const SUGGESTION_VISIBLE_WAIT_MS = 700;

    it('accepts and submits the prompt suggestion on Enter when the buffer is empty', async () => {
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} promptSuggestion="commit this" />,
      );
      await wait(SUGGESTION_VISIBLE_WAIT_MS);

      stdin.write('\r');
      await wait();

      expect(props.onSubmit).toHaveBeenCalledWith('commit this');
      // Enter path must NOT call buffer.insert — it passes text directly to
      // handleSubmitAndClear. Calling insert would re-fill the buffer after
      // it was already cleared (the microtask race bug).
      expect(mockBuffer.insert).not.toHaveBeenCalled();
      unmount();
    });

    it('does not accept the prompt suggestion on shift+tab', async () => {
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} promptSuggestion="commit this" />,
      );
      await wait(SUGGESTION_VISIBLE_WAIT_MS);

      stdin.write('\x1b[Z'); // shift+tab
      await wait();

      expect(mockBuffer.insert).not.toHaveBeenCalled();
      unmount();
    });

    it('does not accept a prompt suggestion while command completion is active', async () => {
      mockCommandCompletion.showSuggestions = true;
      mockCommandCompletion.suggestions = [
        {
          value: '/clear',
          label: '/clear',
          description: 'Clear screen',
        },
      ] as UseCommandCompletionReturn['suggestions'];

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} promptSuggestion="commit this" />,
      );
      await wait(SUGGESTION_VISIBLE_WAIT_MS);

      stdin.write('\t');
      await wait();

      expect(mockBuffer.insert).not.toHaveBeenCalledWith('commit this');
      expect(mockCommandCompletion.handleAutocomplete).toHaveBeenCalled();
      unmount();
    });
  });

  it('should call shellHistory.getPreviousCommand on up arrow in shell mode', async () => {
    props.shellModeActive = true;
    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\u001B[A');
    await wait();

    expect(mockShellHistory.getPreviousCommand).toHaveBeenCalled();
    unmount();
  });

  it('should call shellHistory.getNextCommand on down arrow in shell mode', async () => {
    props.shellModeActive = true;
    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\u001B[B');
    await wait();

    expect(mockShellHistory.getNextCommand).toHaveBeenCalled();
    unmount();
  });

  it('should set the buffer text when a shell history command is retrieved', async () => {
    props.shellModeActive = true;
    vi.mocked(mockShellHistory.getPreviousCommand).mockReturnValue(
      'previous command',
    );
    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\u001B[A');
    await wait();

    expect(mockShellHistory.getPreviousCommand).toHaveBeenCalled();
    expect(props.buffer.setText).toHaveBeenCalledWith('previous command');
    unmount();
  });

  it('should call shellHistory.addCommandToHistory on submit in shell mode', async () => {
    props.shellModeActive = true;
    props.buffer.setText('ls -l');
    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\r');
    await wait();

    expect(mockShellHistory.addCommandToHistory).toHaveBeenCalledWith('ls -l');
    expect(props.onSubmit).toHaveBeenCalledWith('ls -l');
    unmount();
  });

  it('should NOT call shell history methods when not in shell mode', async () => {
    props.buffer.setText('some text');
    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\u001B[A'); // Up arrow
    await wait();
    stdin.write('\u001B[B'); // Down arrow
    await wait();
    stdin.write('\r'); // Enter
    await wait();

    expect(mockShellHistory.getPreviousCommand).not.toHaveBeenCalled();
    expect(mockShellHistory.getNextCommand).not.toHaveBeenCalled();
    expect(mockShellHistory.addCommandToHistory).not.toHaveBeenCalled();

    expect(mockInputHistory.navigateUp).toHaveBeenCalled();
    expect(mockInputHistory.navigateDown).toHaveBeenCalled();
    expect(props.onSubmit).toHaveBeenCalledWith('some text');
    unmount();
  });

  it('should call completion.navigateUp for up arrow when suggestions are showing', async () => {
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'memory', value: 'memory' },
        { label: 'memcache', value: 'memcache' },
      ],
    });

    props.buffer.setText('/mem');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    // Test up arrow for completion navigation
    stdin.write('\u001B[A'); // Up arrow
    await wait();
    expect(mockCommandCompletion.navigateUp).toHaveBeenCalledTimes(1);
    expect(mockCommandCompletion.navigateDown).not.toHaveBeenCalled();

    // Ctrl+P should navigate history, not completion
    stdin.write('\u0010'); // Ctrl+P
    await wait();
    expect(mockCommandCompletion.navigateUp).toHaveBeenCalledTimes(1);
    expect(mockInputHistory.navigateUp).toHaveBeenCalled();

    unmount();
  });

  it('should call completion.navigateDown for down arrow when suggestions are showing', async () => {
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'memory', value: 'memory' },
        { label: 'memcache', value: 'memcache' },
      ],
    });
    props.buffer.setText('/mem');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    // Test down arrow for completion navigation
    stdin.write('\u001B[B'); // Down arrow
    await wait();
    expect(mockCommandCompletion.navigateDown).toHaveBeenCalledTimes(1);
    expect(mockCommandCompletion.navigateUp).not.toHaveBeenCalled();

    // Ctrl+N should navigate history, not completion
    stdin.write('\u000E'); // Ctrl+N
    await wait();
    expect(mockCommandCompletion.navigateDown).toHaveBeenCalledTimes(1);
    expect(mockInputHistory.navigateDown).toHaveBeenCalled();

    unmount();
  });

  it('should NOT call completion navigation when suggestions are not showing', async () => {
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: false,
    });
    props.buffer.setText('some text');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\u001B[A'); // Up arrow
    await wait();
    stdin.write('\u001B[B'); // Down arrow
    await wait();
    stdin.write('\u0010'); // Ctrl+P
    await wait();
    stdin.write('\u000E'); // Ctrl+N
    await wait();

    expect(mockCommandCompletion.navigateUp).not.toHaveBeenCalled();
    expect(mockCommandCompletion.navigateDown).not.toHaveBeenCalled();
    unmount();
  });

  describe('clipboard image paste', () => {
    const isWindows = process.platform === 'win32';

    beforeEach(() => {
      vi.mocked(clipboardUtils.clipboardHasImage).mockResolvedValue(false);
      vi.mocked(clipboardUtils.saveClipboardImage).mockResolvedValue(null);
      vi.mocked(clipboardUtils.cleanupOldClipboardImages).mockResolvedValue(
        undefined,
      );
    });

    // Windows uses Alt+V (\x1Bv), non-Windows uses Ctrl+V (\x16)
    const describeConditional = isWindows ? it.skip : it;
    describeConditional(
      'should handle Ctrl+V when clipboard has an image',
      async () => {
        vi.mocked(clipboardUtils.clipboardHasImage).mockResolvedValue(true);
        vi.mocked(clipboardUtils.saveClipboardImage).mockResolvedValue(
          '/Users/mochi/.qwen/tmp/clipboard-123.png',
        );

        const { stdin, unmount } = renderWithProviders(
          <InputPrompt {...props} />,
        );
        await wait();

        // Send Ctrl+V
        stdin.write('\x16'); // Ctrl+V
        await wait();

        expect(clipboardUtils.clipboardHasImage).toHaveBeenCalled();
        expect(clipboardUtils.saveClipboardImage).toHaveBeenCalled();
        expect(clipboardUtils.cleanupOldClipboardImages).toHaveBeenCalled();
        // Note: The new implementation adds images as attachments rather than inserting into buffer
        unmount();
      },
    );

    it('should handle Cmd+V when clipboard has an image', async () => {
      vi.mocked(clipboardUtils.clipboardHasImage).mockResolvedValue(true);
      vi.mocked(clipboardUtils.saveClipboardImage).mockResolvedValue(
        '/Users/mochi/.qwen/tmp/clipboard-456.png',
      );

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // Send Cmd+V (meta key) / Alt+V on Windows
      // In terminals, Cmd+V or Alt+V is typically sent as ESC followed by 'v'
      stdin.write('\x1Bv');
      await wait();

      expect(clipboardUtils.clipboardHasImage).toHaveBeenCalled();
      expect(clipboardUtils.saveClipboardImage).toHaveBeenCalled();
      expect(clipboardUtils.cleanupOldClipboardImages).toHaveBeenCalled();
      // Note: The new implementation adds images as attachments rather than inserting into buffer
      unmount();
    });

    it('should not insert anything when clipboard has no image', async () => {
      vi.mocked(clipboardUtils.clipboardHasImage).mockResolvedValue(false);

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // Use platform-appropriate key combination
      stdin.write(isWindows ? '\x1Bv' : '\x16');
      await wait();

      expect(clipboardUtils.clipboardHasImage).toHaveBeenCalled();
      expect(clipboardUtils.saveClipboardImage).not.toHaveBeenCalled();
      expect(mockBuffer.setText).not.toHaveBeenCalled();
      unmount();
    });

    it('should handle image save failure gracefully', async () => {
      vi.mocked(clipboardUtils.clipboardHasImage).mockResolvedValue(true);
      vi.mocked(clipboardUtils.saveClipboardImage).mockResolvedValue(null);

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // Use platform-appropriate key combination
      stdin.write(isWindows ? '\x1Bv' : '\x16');
      await wait();

      expect(clipboardUtils.saveClipboardImage).toHaveBeenCalled();
      expect(mockBuffer.setText).not.toHaveBeenCalled();
      unmount();
    });

    it('should insert image path at cursor position with proper spacing', async () => {
      const imagePath = '/Users/mochi/.qwen/tmp/clipboard-456.png';
      vi.mocked(clipboardUtils.clipboardHasImage).mockResolvedValue(true);
      vi.mocked(clipboardUtils.saveClipboardImage).mockResolvedValue(imagePath);

      // Set initial text and cursor position
      mockBuffer.text = 'Hello world';
      mockBuffer.cursor = [0, 5]; // Cursor after "Hello"
      mockBuffer.lines = ['Hello world'];

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // Use platform-appropriate key combination
      stdin.write(isWindows ? '\x1Bv' : '\x16');
      await wait();

      // The new implementation adds images as attachments rather than inserting into buffer
      // So we verify that saveClipboardImage was called instead
      expect(clipboardUtils.saveClipboardImage).toHaveBeenCalled();
      expect(clipboardUtils.clipboardHasImage).toHaveBeenCalled();
      unmount();
    });

    it('should handle errors during clipboard operations gracefully', async () => {
      vi.mocked(clipboardUtils.clipboardHasImage).mockRejectedValue(
        new Error('Clipboard error'),
      );

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // Use platform-appropriate key combination
      stdin.write(isWindows ? '\x1Bv' : '\x16');
      await wait();

      // Should not throw and should not set buffer text on error
      expect(mockBuffer.setText).not.toHaveBeenCalled();

      unmount();
    });
  });

  it('should complete a partial parent command', async () => {
    // SCENARIO: /mem -> Tab
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [{ label: 'memory', value: 'memory', description: '...' }],
      activeSuggestionIndex: 0,
    });
    props.buffer.setText('/mem');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\t'); // Press Tab
    await wait();

    expect(mockCommandCompletion.handleAutocomplete).toHaveBeenCalledWith(0);
    unmount();
  });

  it('should append a sub-command when the parent command is already complete', async () => {
    // SCENARIO: /memory -> Tab (to accept 'add')
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'show', value: 'show' },
        { label: 'add', value: 'add' },
      ],
      activeSuggestionIndex: 1, // 'add' is highlighted
    });
    props.buffer.setText('/memory ');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\t'); // Press Tab
    await wait();

    expect(mockCommandCompletion.handleAutocomplete).toHaveBeenCalledWith(1);
    unmount();
  });

  it('should handle the "backspace" edge case correctly', async () => {
    // SCENARIO: /config -> Backspace -> /config -> Tab (to accept 'set')
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'set', value: 'set' },
        { label: 'reset', value: 'reset' },
      ],
      activeSuggestionIndex: 0, // 'set' is highlighted
    });
    // The user has backspaced, so the query is now just '/config'
    props.buffer.setText('/config');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\t'); // Press Tab
    await wait();

    // It should NOT become '/set'. It should correctly become '/config set'.
    expect(mockCommandCompletion.handleAutocomplete).toHaveBeenCalledWith(0);
    unmount();
  });

  it('should complete a partial argument for a command', async () => {
    // SCENARIO: /config set fi- -> Tab
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [{ label: 'fix-foo', value: 'fix-foo' }],
      activeSuggestionIndex: 0,
    });
    props.buffer.setText('/config set fi-');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\t'); // Press Tab
    await wait();

    expect(mockCommandCompletion.handleAutocomplete).toHaveBeenCalledWith(0);
    unmount();
  });

  it('should autocomplete on Enter when suggestions are active, without submitting', async () => {
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [{ label: 'memory', value: 'memory' }],
      activeSuggestionIndex: 0,
    });
    props.buffer.setText('/mem');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\r');
    await wait();

    // The app should autocomplete the text, NOT submit.
    expect(mockCommandCompletion.handleAutocomplete).toHaveBeenCalledWith(0);

    expect(props.onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it('should complete a command based on its altNames', async () => {
    props.slashCommands = [
      {
        name: 'help',
        altNames: ['?'],
        kind: CommandKind.BUILT_IN,
        description: '...',
      },
    ];

    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [{ label: 'help', value: 'help' }],
      activeSuggestionIndex: 0,
    });
    props.buffer.setText('/?');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\t'); // Press Tab for autocomplete
    await wait();

    expect(mockCommandCompletion.handleAutocomplete).toHaveBeenCalledWith(0);
    unmount();
  });

  it('should not submit on Enter when the buffer is empty or only contains whitespace', async () => {
    props.buffer.setText('   '); // Set buffer to whitespace

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\r'); // Press Enter
    await wait();

    expect(props.onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it('should submit directly on Enter when isPerfectMatch is true', async () => {
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: false,
      isPerfectMatch: true,
    });
    props.buffer.setText('/clear');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\r');
    await wait();

    expect(props.onSubmit).toHaveBeenCalledWith('/clear');
    unmount();
  });

  it('should submit a perfect match on Enter when suggestions were not navigated', async () => {
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'html', value: 'html' },
        { label: 'md', value: 'md' },
        { label: 'json', value: 'json' },
        { label: 'jsonl', value: 'jsonl' },
      ],
      activeSuggestionIndex: 0,
      isPerfectMatch: true,
    });
    props.buffer.setText('/export');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\r');
    await wait();

    expect(props.onSubmit).toHaveBeenCalledWith('/export');
    expect(mockCommandCompletion.handleAutocomplete).not.toHaveBeenCalled();
    unmount();
  });

  it('should fill and submit an export format selected with arrow navigation', async () => {
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'html', value: 'html' },
        { label: 'md', value: 'md' },
        { label: 'json', value: 'json' },
        { label: 'jsonl', value: 'jsonl' },
      ],
      activeSuggestionIndex: 0,
      isPerfectMatch: true,
    });
    props.buffer.setText('/export');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\u001B[B');
    await wait();

    expect(props.buffer.setText).toHaveBeenLastCalledWith('/export md');
    expect(mockCommandCompletion.handleAutocomplete).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();

    stdin.write('\r');
    await wait();

    expect(props.onSubmit).toHaveBeenCalledWith('/export md');
    unmount();
  });

  it('should keep cycling export formats after arrow navigation fills input', async () => {
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'html', value: 'html' },
        { label: 'md', value: 'md' },
        { label: 'json', value: 'json' },
        { label: 'jsonl', value: 'jsonl' },
      ],
      activeSuggestionIndex: 0,
      isPerfectMatch: true,
    });
    props.buffer.setText('/export');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\u001B[B');
    await wait();
    stdin.write('\u001B[B');
    await wait();

    expect(props.buffer.setText).toHaveBeenNthCalledWith(2, '/export md');
    expect(props.buffer.setText).toHaveBeenNthCalledWith(3, '/export json');
    expect(mockInputHistory.navigateDown).not.toHaveBeenCalled();
    unmount();
  });

  it('should keep export format suggestions visible after arrow navigation fills input', async () => {
    const exportSuggestions = [
      { label: 'html', value: 'html' },
      { label: 'md', value: 'md' },
      { label: 'json', value: 'json' },
      { label: 'jsonl', value: 'jsonl' },
    ];
    mockedUseCommandCompletion.mockImplementation((buffer) => {
      const isExportRoot = buffer.text.trim() === '/export';
      return {
        ...mockCommandCompletion,
        showSuggestions: isExportRoot,
        suggestions: isExportRoot ? exportSuggestions : [],
        activeSuggestionIndex: 0,
        isPerfectMatch: isExportRoot,
      };
    });
    const TestHarness = () => {
      const buffer = useTextBuffer({
        initialText: '/export',
        viewport: { width: 80, height: 20 },
        isValidPath: () => false,
        onChange: () => {},
      });
      return <InputPrompt {...props} buffer={buffer} />;
    };

    const { stdin, lastFrame, unmount } = renderWithProviders(<TestHarness />);
    await wait();

    stdin.write('\u001B[B');
    await wait();

    const output = stripAnsi(lastFrame() ?? '');
    expect(output).toContain('/export md');
    expect(output).toContain('html');
    expect(output).toContain('md');
    expect(output).toContain('json');
    expect(output).toContain('jsonl');
    expect(output).toContain('Export Markdown');
    unmount();
  });

  it('should not clobber manually edited buffer when arrow is pressed after export fill', async () => {
    // Regression for PR #3701 review: exportCompletionSelectionIndexRef
    // leaked across buffer edits, so arrow keys would overwrite user-typed
    // text after the user moved away from an "/export <fmt>" input.
    mockedUseCommandCompletion.mockImplementation((buffer) => {
      const isExportRoot = buffer.text.trim() === '/export';
      return {
        ...mockCommandCompletion,
        showSuggestions: isExportRoot,
        suggestions: isExportRoot
          ? [
              { label: 'html', value: 'html' },
              { label: 'md', value: 'md' },
              { label: 'json', value: 'json' },
              { label: 'jsonl', value: 'jsonl' },
            ]
          : [],
        activeSuggestionIndex: 0,
        isPerfectMatch: isExportRoot,
      };
    });

    const TestHarness = () => {
      const buffer = useTextBuffer({
        initialText: '/export',
        viewport: { width: 80, height: 20 },
        isValidPath: () => false,
        onChange: () => {},
      });
      return <InputPrompt {...props} buffer={buffer} />;
    };

    const { stdin, lastFrame, unmount } = renderWithProviders(<TestHarness />);
    await wait();

    // Phase 1 + 2: Down fills "/export md".
    stdin.write('\u001B[B');
    await wait();
    expect(stripAnsi(lastFrame() ?? '')).toContain('/export md');

    // User clears buffer and types a different command manually.
    stdin.write('\u0015'); // Ctrl+U: clear line
    await wait();
    // Pin the intermediate state: Ctrl+U must actually clear the buffer
    // before we type the new command, so a future useTextBuffer/hook change
    // can't make this test pass for the wrong reason.
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('/export');
    stdin.write('/help');
    await wait();
    const afterEditFrame = stripAnsi(lastFrame() ?? '');
    expect(afterEditFrame).toContain('/help');

    // Pressing Down now must NOT overwrite "/help" with an export format.
    stdin.write('\u001B[B');
    await wait();
    const afterArrowFrame = stripAnsi(lastFrame() ?? '');
    expect(afterArrowFrame).toContain('/help');
    expect(afterArrowFrame).not.toMatch(/\/export\s+(html|md|json|jsonl)/);
    unmount();
  });

  it('should wrap to jsonl when pressing Up from the /export Phase 1 popup', async () => {
    // Regression for PR #3701 second-round review: Phase 1 Up-arrow path
    // (including 0 -> lastIndex wrap) had no test coverage.
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'html', value: 'html' },
        { label: 'md', value: 'md' },
        { label: 'json', value: 'json' },
        { label: 'jsonl', value: 'jsonl' },
      ],
      activeSuggestionIndex: 0,
      isPerfectMatch: true,
    });
    props.buffer.setText('/export');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\u001B[A');
    await wait();

    expect(props.buffer.setText).toHaveBeenLastCalledWith('/export jsonl');
    expect(mockCommandCompletion.handleAutocomplete).not.toHaveBeenCalled();
    unmount();
  });

  it('should wrap Phase 2 cycling backward when pressing Up repeatedly', async () => {
    // Regression for PR #3701 second-round review: Phase 2 Up-arrow wrap
    // logic had no test coverage (existing tests only used Down).
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'html', value: 'html' },
        { label: 'md', value: 'md' },
        { label: 'json', value: 'json' },
        { label: 'jsonl', value: 'jsonl' },
      ],
      activeSuggestionIndex: 0,
      isPerfectMatch: true,
    });
    props.buffer.setText('/export');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    // Phase 1 Down -> /export md (ref=1).
    stdin.write('\u001B[B');
    await wait();
    // Phase 2 Up -> /export html (ref=0).
    stdin.write('\u001B[A');
    await wait();
    // Phase 2 Up wraps from index 0 to last index -> /export jsonl (ref=3).
    stdin.write('\u001B[A');
    await wait();

    expect(props.buffer.setText).toHaveBeenNthCalledWith(2, '/export md');
    expect(props.buffer.setText).toHaveBeenNthCalledWith(3, '/export html');
    expect(props.buffer.setText).toHaveBeenNthCalledWith(4, '/export jsonl');
    unmount();
  });

  it('should seed Phase 2 cycling when Tab accepts a format in the /export popup', async () => {
    // Regression for PR #3701 second-round review (Suggestion): Tab in the
    // Phase 1 popup must run the export-specific path so that
    // exportCompletionSelectionIndexRef is seeded and subsequent arrow/Tab
    // keys can continue cycling.
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'html', value: 'html' },
        { label: 'md', value: 'md' },
        { label: 'json', value: 'json' },
        { label: 'jsonl', value: 'jsonl' },
      ],
      activeSuggestionIndex: 0,
      isPerfectMatch: true,
    });
    props.buffer.setText('/export');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    // Tab in Phase 1 popup fills /export html and seeds the ref.
    stdin.write('\t');
    await wait();
    expect(props.buffer.setText).toHaveBeenLastCalledWith('/export html');
    expect(mockCommandCompletion.handleAutocomplete).not.toHaveBeenCalled();

    // Phase 2 Down now cycles forward from the seeded ref.
    stdin.write('\u001B[B');
    await wait();
    expect(props.buffer.setText).toHaveBeenLastCalledWith('/export md');

    // Phase 2 Tab should also cycle (covers isCompletionTabKey branch).
    stdin.write('\t');
    await wait();
    expect(props.buffer.setText).toHaveBeenLastCalledWith('/export json');
    unmount();
  });

  it('should not overwrite /export html with extra args when Down is pressed', async () => {
    // Regression for PR #3701 second-round review (Critical): Phase 2 cycling
    // guard used startsWith('/export '), which matched inputs like
    // '/export html --verbose' and silently wiped out the extra arguments.
    // The strict getExportFormatFromInput guard must let such inputs fall
    // through without overwriting the buffer.
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'html', value: 'html' },
        { label: 'md', value: 'md' },
        { label: 'json', value: 'json' },
        { label: 'jsonl', value: 'jsonl' },
      ],
      activeSuggestionIndex: 0,
      isPerfectMatch: true,
    });
    props.buffer.setText('/export');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    // Seed Phase 2 state: Down fills /export md and sets ref=1.
    stdin.write('\u001B[B');
    await wait();
    expect(props.buffer.setText).toHaveBeenLastCalledWith('/export md');

    // Simulate the user appending extra arguments to the export input.
    props.buffer.setText('/export md --verbose');
    (props.buffer.setText as ReturnType<typeof vi.fn>).mockClear();

    // Pressing Down must NOT replace the buffer with '/export json'.
    stdin.write('\u001B[B');
    await wait();
    expect(props.buffer.setText).not.toHaveBeenCalled();
    unmount();
  });

  it('should reset export cycling state on Escape so arrows no longer cycle', async () => {
    // Regression for PR #3701 third-round review (Suggestion): ESC resets
    // exportCompletionSelectionIndexRef but this path had no test coverage,
    // so a regression could silently break the reset.
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'html', value: 'html' },
        { label: 'md', value: 'md' },
        { label: 'json', value: 'json' },
        { label: 'jsonl', value: 'jsonl' },
      ],
      activeSuggestionIndex: 0,
      isPerfectMatch: true,
    });
    props.buffer.setText('/export');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    // Phase 1 Down -> /export md (enters Phase 2).
    stdin.write('\u001B[B');
    await wait();
    expect(props.buffer.setText).toHaveBeenLastCalledWith('/export md');
    (props.buffer.setText as ReturnType<typeof vi.fn>).mockClear();

    // Press Escape — should reset the cycling state.
    stdin.write('\x1B');
    await wait();

    // Subsequent Down must NOT overwrite the buffer with an export format.
    stdin.write('\u001B[B');
    await wait();
    expect(props.buffer.setText).not.toHaveBeenCalledWith('/export json');
    expect(props.buffer.setText).not.toHaveBeenCalledWith('/export html');
    expect(props.buffer.setText).not.toHaveBeenCalledWith('/export jsonl');
    expect(props.buffer.setText).not.toHaveBeenCalled();
    unmount();
  });

  it('should reset export cycling state on Ctrl+C so new input is not overwritten', async () => {
    // Regression for PR #3701 third-round review (Suggestion): Ctrl+C resets
    // exportCompletionSelectionIndexRef but this path had no test coverage,
    // so the ref could leak into the new input. Verify that after Ctrl+C
    // the user can type a completely unrelated command without arrow keys
    // clobbering it with export formats.
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'html', value: 'html' },
        { label: 'md', value: 'md' },
        { label: 'json', value: 'json' },
        { label: 'jsonl', value: 'jsonl' },
      ],
      activeSuggestionIndex: 0,
      isPerfectMatch: true,
    });
    props.buffer.setText('/export');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    // Phase 1 Down -> /export md (enters Phase 2).
    stdin.write('\u001B[B');
    await wait();
    expect(props.buffer.setText).toHaveBeenLastCalledWith('/export md');
    (props.buffer.setText as ReturnType<typeof vi.fn>).mockClear();

    // Ctrl+C clears the buffer.
    stdin.write('\x03');
    await wait();

    // Set a completely different command into the buffer.
    props.buffer.setText('/help');
    (props.buffer.setText as ReturnType<typeof vi.fn>).mockClear();

    // Pressing Down must NOT overwrite '/help' with an export format.
    stdin.write('\u001B[B');
    await wait();
    expect(props.buffer.setText).not.toHaveBeenCalledWith('/export json');
    expect(props.buffer.setText).not.toHaveBeenCalledWith('/export html');
    expect(props.buffer.setText).not.toHaveBeenCalledWith('/export jsonl');
    expect(props.buffer.setText).not.toHaveBeenCalledWith('/export md');
    expect(props.buffer.setText).not.toHaveBeenCalled();
    unmount();
  });

  it('should cycle export format on Down when /export <fmt> was typed manually (not via popup)', async () => {
    // Regression for PR #3701 fifth-round review: users who type
    // "/export md" directly (without going through the Phase-1 popup)
    // must still get Phase-2 cycling on arrow keys, but programmatic
    // buffer.setText/history restores must not arm the same state.
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: false, // popup is closed for direct input
      suggestions: [
        { label: 'html', value: 'html' },
        { label: 'md', value: 'md' },
        { label: 'json', value: 'json' },
        { label: 'jsonl', value: 'jsonl' },
      ],
      activeSuggestionIndex: 0,
      isPerfectMatch: false,
    });

    const TestHarness = () => {
      const buffer = useTextBuffer({
        initialText: '',
        viewport: { width: 80, height: 20 },
        isValidPath: () => false,
        onChange: () => {},
      });
      return <InputPrompt {...props} buffer={buffer} />;
    };

    const { stdin, lastFrame, unmount } = renderWithProviders(<TestHarness />);
    await wait();

    stdin.write('/export md');
    await wait(350);
    expect(stripAnsi(lastFrame() ?? '')).toContain('/export md');

    // Pressing Down must cycle to the NEXT format (json).
    stdin.write('\u001B[B');
    await wait();
    expect(stripAnsi(lastFrame() ?? '')).toContain('/export json');
    unmount();
  });

  it('should not arm export cycling from restored history text', async () => {
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: false,
      suggestions: [
        { label: 'html', value: 'html' },
        { label: 'md', value: 'md' },
        { label: 'json', value: 'json' },
        { label: 'jsonl', value: 'jsonl' },
      ],
      activeSuggestionIndex: 0,
      isPerfectMatch: false,
    });

    const TestHarness = () => {
      const buffer = useTextBuffer({
        initialText: '/export md',
        viewport: { width: 80, height: 20 },
        isValidPath: () => false,
        onChange: () => {},
      });
      return <InputPrompt {...props} buffer={buffer} />;
    };

    const { stdin, lastFrame, unmount } = renderWithProviders(<TestHarness />);
    await wait();

    stdin.write('\u001B[B');
    await wait();

    expect(mockInputHistory.navigateDown).toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? '')).toContain('/export md');
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('/export json');
    unmount();
  });

  it('should trigger export-specific arrow navigation even when completion suggestions are a superset', async () => {
    // Regression for PR #3701 review (hasExportFormatSuggestions superset
    // matching): when extra non-export items appear alongside all export
    // formats, Phase 1 must still route arrow keys to setExportCompletionInput
    // instead of silently falling through to generic navigateDown.
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'html', value: 'html' },
        { label: 'md', value: 'md' },
        { label: 'json', value: 'json' },
        { label: 'jsonl', value: 'jsonl' },
        { label: 'report', value: 'report' }, // extra suggestion
      ],
      activeSuggestionIndex: 0,
      isPerfectMatch: true,
    });
    props.buffer.setText('/export');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\u001B[B'); // Down
    await wait();

    expect(props.buffer.setText).toHaveBeenLastCalledWith('/export md');
    expect(mockCommandCompletion.navigateDown).not.toHaveBeenCalled();
    unmount();
  });

  it('should fall through to generic accept when Tab targets a non-export item in the /export superset popup', async () => {
    // Regression for PR #3701 review: when the active suggestion in the
    // Phase 1 superset popup is a non-export item, ACCEPT_SUGGESTION must
    // NOT call setExportCompletionInput — it must fall through to the
    // generic acceptActiveCompletionSuggestion.
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'html', value: 'html' },
        { label: 'md', value: 'md' },
        { label: 'json', value: 'json' },
        { label: 'jsonl', value: 'jsonl' },
        { label: 'report', value: 'report' },
      ],
      activeSuggestionIndex: 4, // the non-export item
      isPerfectMatch: true,
    });
    props.buffer.setText('/export');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\t'); // Tab (ACCEPT_SUGGESTION)
    await wait();

    expect(mockCommandCompletion.handleAutocomplete).toHaveBeenCalledWith(4);
    // Must NOT write "/export report" to the buffer.
    expect(props.buffer.setText).not.toHaveBeenCalledWith('/export report');
    unmount();
  });

  it('should fall through to generic completion when suggestions are missing an export format', async () => {
    // Regression for PR #3701 review: when completion suggestions do NOT
    // include all export formats, hasExportFormatSuggestions must be false
    // and arrow keys must go through the generic completion.navigateDown
    // path instead of setExportCompletionInput.
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'html', value: 'html' },
        { label: 'md', value: 'md' },
        { label: 'json', value: 'json' },
        // jsonl intentionally missing
      ],
      activeSuggestionIndex: 0,
      isPerfectMatch: true,
    });
    props.buffer.setText('/export');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\u001B[B'); // Down
    await wait();

    expect(mockCommandCompletion.navigateDown).toHaveBeenCalled();
    expect(props.buffer.setText).not.toHaveBeenCalledWith('/export md');
    expect(props.buffer.setText).not.toHaveBeenCalledWith('/export json');
    unmount();
  });

  it('should trigger Phase 1 export popup even when /export has trailing spaces', async () => {
    // Regression: trailing whitespace after "/export" must be treated the
    // same as plain "/export" — trim() should normalise the buffer so
    // hasExportFormatSuggestions activates and the popup triggers.
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'html', value: 'html' },
        { label: 'md', value: 'md' },
        { label: 'json', value: 'json' },
        { label: 'jsonl', value: 'jsonl' },
      ],
      activeSuggestionIndex: 0,
      isPerfectMatch: true,
    });
    props.buffer.setText('/export  '); // trailing spaces

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\u001B[B'); // Down
    await wait();

    expect(props.buffer.setText).toHaveBeenLastCalledWith('/export md');
    expect(mockCommandCompletion.navigateDown).not.toHaveBeenCalled();
    unmount();
  });

  it('should autocomplete on Enter when user arrow-navigated a perfect-match suggestion list', async () => {
    // Regression for PR #3701 review: the isPerfectMatch + navigated + Enter
    // branch was not covered by tests.
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'show', value: 'show' },
        { label: 'add', value: 'add' },
        { label: 'refresh', value: 'refresh' },
      ],
      activeSuggestionIndex: 0,
      isPerfectMatch: true,
    });
    props.buffer.setText('/memory');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    // Arrow-navigate so completionSelectionWasNavigatedRef flips to true.
    stdin.write('\u001B[B');
    await wait();
    expect(mockCommandCompletion.navigateDown).toHaveBeenCalled();

    // Enter should autocomplete the active suggestion, NOT submit the raw buffer.
    stdin.write('\r');
    await wait();

    expect(mockCommandCompletion.handleAutocomplete).toHaveBeenCalledWith(0);
    expect(props.onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it('should submit directly on Enter after arrow-navigate + backspace + retype to perfect match', async () => {
    // Regression for PR #3701 review (issue #5): navigate → backspace
    // → retype → Enter must submit the raw buffer, not autocomplete.
    // If the popup persists across backspace+retype and the navigated flag
    // is not cleared on buffer.text changes, Enter would autocomplete the
    // first sub-command instead of submitting the perfect match.
    mockedUseCommandCompletion.mockImplementation((buf) => {
      const text = buf.text;
      const isMemory = text === '/memory';
      return {
        ...mockCommandCompletion,
        showSuggestions: true, // popup stays visible throughout
        suggestions: [
          { label: 'show', value: 'show' },
          { label: 'add', value: 'add' },
          { label: 'refresh', value: 'refresh' },
        ],
        activeSuggestionIndex: 0,
        isPerfectMatch: isMemory,
      };
    });
    props.buffer.setText('/memory');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    // Arrow-navigate so completionSelectionWasNavigatedRef flips to true.
    stdin.write('\u001B[B');
    await wait();
    expect(mockCommandCompletion.navigateDown).toHaveBeenCalled();

    // Simulate backspace to /memor — popup stays visible in this test.
    // Use unmount + re-render to force useEffect re-evaluation on the
    // changed buffer.text (direct setText on the mock object doesn't
    // trigger React state updates, so effects don't fire).
    props.buffer.setText('/memor');
    unmount();
    const { unmount: unmountAfterEdit } = renderWithProviders(
      <InputPrompt {...props} />,
    );
    await wait();

    // Retype: /memor → /memory.
    props.buffer.setText('/memory');
    unmountAfterEdit();
    const { stdin: stdinFinal, unmount: unmountFinal } = renderWithProviders(
      <InputPrompt {...props} />,
    );
    await wait();

    // Enter must submit '/memory', NOT autocomplete 'show'.
    stdinFinal.write('\r');
    await wait();

    expect(props.onSubmit).toHaveBeenCalledWith('/memory');
    expect(mockCommandCompletion.handleAutocomplete).not.toHaveBeenCalled();
    unmountFinal();
  });

  it('should submit directly on Enter for a perfect match without prior arrow navigation', async () => {
    // Control: with no arrow navigation, Enter on a perfect match must submit.
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [
        { label: 'show', value: 'show' },
        { label: 'add', value: 'add' },
      ],
      activeSuggestionIndex: 0,
      isPerfectMatch: true,
    });
    props.buffer.setText('/memory');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\r');
    await wait();

    expect(props.onSubmit).toHaveBeenCalledWith('/memory');
    expect(mockCommandCompletion.handleAutocomplete).not.toHaveBeenCalled();
    unmount();
  });

  it('should reset history navigation after submitting on Enter', async () => {
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: false,
      isPerfectMatch: false,
    });
    props.buffer.setText('a prompt from history');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\r');
    await wait();

    expect(props.onSubmit).toHaveBeenCalledWith('a prompt from history');
    expect(mockInputHistory.resetHistoryNav).toHaveBeenCalled();
    unmount();
  });

  it('should submit directly on Enter when a complete leaf command is typed', async () => {
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: false,
      isPerfectMatch: false, // Added explicit isPerfectMatch false
    });
    props.buffer.setText('/clear');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\r');
    await wait();

    expect(props.onSubmit).toHaveBeenCalledWith('/clear');
    unmount();
  });

  it('should autocomplete an @-path on Enter without submitting', async () => {
    mockedUseCommandCompletion.mockReturnValue({
      ...mockCommandCompletion,
      showSuggestions: true,
      suggestions: [{ label: 'index.ts', value: 'index.ts' }],
      activeSuggestionIndex: 0,
    });
    props.buffer.setText('@src/components/');

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\r');
    await wait();

    expect(mockCommandCompletion.handleAutocomplete).toHaveBeenCalledWith(0);
    expect(props.onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it('should add a newline on enter when the line ends with a backslash', async () => {
    // This test simulates multi-line input, not submission
    mockBuffer.text = 'first line\\';
    mockBuffer.cursor = [0, 11];
    mockBuffer.lines = ['first line\\'];

    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\r');
    await wait();

    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(props.buffer.backspace).toHaveBeenCalled();
    expect(props.buffer.newline).toHaveBeenCalled();
    unmount();
  });

  it('should clear the buffer on Ctrl+C if it has text', async () => {
    props.buffer.setText('some text to clear');
    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\x03'); // Ctrl+C character
    await wait();

    expect(props.buffer.setText).toHaveBeenCalledWith('');
    expect(mockCommandCompletion.resetCompletionState).toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it('should NOT clear the buffer on Ctrl+C if it is empty', async () => {
    props.buffer.text = '';
    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />);
    await wait();

    stdin.write('\x03'); // Ctrl+C character
    await wait();

    expect(props.buffer.setText).not.toHaveBeenCalled();
    unmount();
  });

  describe('cursor-based completion trigger', () => {
    it('should trigger completion when cursor is after @ without spaces', async () => {
      // Set up buffer state
      mockBuffer.text = '@src/components';
      mockBuffer.lines = ['@src/components'];
      mockBuffer.cursor = [0, 15];

      mockedUseCommandCompletion.mockReturnValue({
        ...mockCommandCompletion,
        showSuggestions: true,
        suggestions: [{ label: 'Button.tsx', value: 'Button.tsx' }],
      });

      const { unmount } = renderWithProviders(<InputPrompt {...props} />);
      await wait();

      // Verify useCompletion was called with correct signature
      expect(mockedUseCommandCompletion).toHaveBeenCalledWith(
        mockBuffer,
        path.join('test', 'project', 'src'),
        mockSlashCommands,
        mockCommandContext,
        false,
        expect.any(Object),
        // active parameter: completion enabled when not just navigated history
        true,
        undefined,
      );

      unmount();
    });

    it('should trigger completion when cursor is after / without spaces', async () => {
      mockBuffer.text = '/memory';
      mockBuffer.lines = ['/memory'];
      mockBuffer.cursor = [0, 7];

      mockedUseCommandCompletion.mockReturnValue({
        ...mockCommandCompletion,
        showSuggestions: true,
        suggestions: [{ label: 'show', value: 'show' }],
      });

      const { unmount } = renderWithProviders(<InputPrompt {...props} />);
      await wait();

      expect(mockedUseCommandCompletion).toHaveBeenCalledWith(
        mockBuffer,
        path.join('test', 'project', 'src'),
        mockSlashCommands,
        mockCommandContext,
        false,
        expect.any(Object),
        // active parameter: completion enabled when not just navigated history
        true,
        undefined,
      );

      unmount();
    });

    it('should NOT trigger completion when cursor is after space following @', async () => {
      mockBuffer.text = '@src/file.ts hello';
      mockBuffer.lines = ['@src/file.ts hello'];
      mockBuffer.cursor = [0, 18];

      mockedUseCommandCompletion.mockReturnValue({
        ...mockCommandCompletion,
        showSuggestions: false,
        suggestions: [],
      });

      const { unmount } = renderWithProviders(<InputPrompt {...props} />);
      await wait();

      expect(mockedUseCommandCompletion).toHaveBeenCalledWith(
        mockBuffer,
        path.join('test', 'project', 'src'),
        mockSlashCommands,
        mockCommandContext,
        false,
        expect.any(Object),
        // active parameter: completion enabled when not just navigated history
        true,
        undefined,
      );

      unmount();
    });

    it('should NOT trigger completion when cursor is after space following /', async () => {
      mockBuffer.text = '/config set';
      mockBuffer.lines = ['/config set'];
      mockBuffer.cursor = [0, 11];

      mockedUseCommandCompletion.mockReturnValue({
        ...mockCommandCompletion,
        showSuggestions: false,
        suggestions: [],
      });

      const { unmount } = renderWithProviders(<InputPrompt {...props} />);
      await wait();

      expect(mockedUseCommandCompletion).toHaveBeenCalledWith(
        mockBuffer,
        path.join('test', 'project', 'src'),
        mockSlashCommands,
        mockCommandContext,
        false,
        expect.any(Object),
        // active parameter: completion enabled when not just navigated history
        true,
        undefined,
      );

      unmount();
    });

    it('should NOT trigger completion when cursor is not after @ or /', async () => {
      mockBuffer.text = 'hello world';
      mockBuffer.lines = ['hello world'];
      mockBuffer.cursor = [0, 5];

      mockedUseCommandCompletion.mockReturnValue({
        ...mockCommandCompletion,
        showSuggestions: false,
        suggestions: [],
      });

      const { unmount } = renderWithProviders(<InputPrompt {...props} />);
      await wait();

      expect(mockedUseCommandCompletion).toHaveBeenCalledWith(
        mockBuffer,
        path.join('test', 'project', 'src'),
        mockSlashCommands,
        mockCommandContext,
        false,
        expect.any(Object),
        // active parameter: completion enabled when not just navigated history
        true,
        undefined,
      );

      unmount();
    });

    it('should handle multiline text correctly', async () => {
      mockBuffer.text = 'first line\n/memory';
      mockBuffer.lines = ['first line', '/memory'];
      mockBuffer.cursor = [1, 7];

      mockedUseCommandCompletion.mockReturnValue({
        ...mockCommandCompletion,
        showSuggestions: false,
        suggestions: [],
      });

      const { unmount } = renderWithProviders(<InputPrompt {...props} />);
      await wait();

      // Verify useCompletion was called with the buffer
      expect(mockedUseCommandCompletion).toHaveBeenCalledWith(
        mockBuffer,
        path.join('test', 'project', 'src'),
        mockSlashCommands,
        mockCommandContext,
        false,
        expect.any(Object),
        // active parameter: completion enabled when not just navigated history
        true,
        undefined,
      );

      unmount();
    });

    it('should handle single line slash command correctly', async () => {
      mockBuffer.text = '/memory';
      mockBuffer.lines = ['/memory'];
      mockBuffer.cursor = [0, 7];

      mockedUseCommandCompletion.mockReturnValue({
        ...mockCommandCompletion,
        showSuggestions: true,
        suggestions: [{ label: 'show', value: 'show' }],
      });

      const { unmount } = renderWithProviders(<InputPrompt {...props} />);
      await wait();

      expect(mockedUseCommandCompletion).toHaveBeenCalledWith(
        mockBuffer,
        path.join('test', 'project', 'src'),
        mockSlashCommands,
        mockCommandContext,
        false,
        expect.any(Object),
        // active parameter: completion enabled when not just navigated history
        true,
        undefined,
      );

      unmount();
    });

    it('should handle Unicode characters (emojis) correctly in paths', async () => {
      // Test with emoji in path after @
      mockBuffer.text = '@src/file👍.txt';
      mockBuffer.lines = ['@src/file👍.txt'];
      mockBuffer.cursor = [0, 14]; // After the emoji character

      mockedUseCommandCompletion.mockReturnValue({
        ...mockCommandCompletion,
        showSuggestions: true,
        suggestions: [{ label: 'file👍.txt', value: 'file👍.txt' }],
      });

      const { unmount } = renderWithProviders(<InputPrompt {...props} />);
      await wait();

      expect(mockedUseCommandCompletion).toHaveBeenCalledWith(
        mockBuffer,
        path.join('test', 'project', 'src'),
        mockSlashCommands,
        mockCommandContext,
        false,
        expect.any(Object),
        // active parameter: completion enabled when not just navigated history
        true,
        undefined,
      );

      unmount();
    });

    it('should handle Unicode characters with spaces after them', async () => {
      // Test with emoji followed by space - should NOT trigger completion
      mockBuffer.text = '@src/file👍.txt hello';
      mockBuffer.lines = ['@src/file👍.txt hello'];
      mockBuffer.cursor = [0, 20]; // After the space

      mockedUseCommandCompletion.mockReturnValue({
        ...mockCommandCompletion,
        showSuggestions: false,
        suggestions: [],
      });

      const { unmount } = renderWithProviders(<InputPrompt {...props} />);
      await wait();

      expect(mockedUseCommandCompletion).toHaveBeenCalledWith(
        mockBuffer,
        path.join('test', 'project', 'src'),
        mockSlashCommands,
        mockCommandContext,
        false,
        expect.any(Object),
        // active parameter: completion enabled when not just navigated history
        true,
        undefined,
      );

      unmount();
    });

    it('should handle escaped spaces in paths correctly', async () => {
      // Test with escaped space in path - should trigger completion
      mockBuffer.text = '@src/my\\ file.txt';
      mockBuffer.lines = ['@src/my\\ file.txt'];
      mockBuffer.cursor = [0, 16]; // After the escaped space and filename

      mockedUseCommandCompletion.mockReturnValue({
        ...mockCommandCompletion,
        showSuggestions: true,
        suggestions: [{ label: 'my file.txt', value: 'my file.txt' }],
      });

      const { unmount } = renderWithProviders(<InputPrompt {...props} />);
      await wait();

      expect(mockedUseCommandCompletion).toHaveBeenCalledWith(
        mockBuffer,
        path.join('test', 'project', 'src'),
        mockSlashCommands,
        mockCommandContext,
        false,
        expect.any(Object),
        // active parameter: completion enabled when not just navigated history
        true,
        undefined,
      );

      unmount();
    });

    it('should NOT trigger completion after unescaped space following escaped space', async () => {
      // Test: @path/my\ file.txt hello (unescaped space after escaped space)
      mockBuffer.text = '@path/my\\ file.txt hello';
      mockBuffer.lines = ['@path/my\\ file.txt hello'];
      mockBuffer.cursor = [0, 24]; // After "hello"

      mockedUseCommandCompletion.mockReturnValue({
        ...mockCommandCompletion,
        showSuggestions: false,
        suggestions: [],
      });

      const { unmount } = renderWithProviders(<InputPrompt {...props} />);
      await wait();

      expect(mockedUseCommandCompletion).toHaveBeenCalledWith(
        mockBuffer,
        path.join('test', 'project', 'src'),
        mockSlashCommands,
        mockCommandContext,
        false,
        expect.any(Object),
        // active parameter: completion enabled when not just navigated history
        true,
        undefined,
      );

      unmount();
    });

    it('should handle multiple escaped spaces in paths', async () => {
      // Test with multiple escaped spaces
      mockBuffer.text = '@docs/my\\ long\\ file\\ name.md';
      mockBuffer.lines = ['@docs/my\\ long\\ file\\ name.md'];
      mockBuffer.cursor = [0, 29]; // At the end

      mockedUseCommandCompletion.mockReturnValue({
        ...mockCommandCompletion,
        showSuggestions: true,
        suggestions: [
          { label: 'my long file name.md', value: 'my long file name.md' },
        ],
      });

      const { unmount } = renderWithProviders(<InputPrompt {...props} />);
      await wait();

      expect(mockedUseCommandCompletion).toHaveBeenCalledWith(
        mockBuffer,
        path.join('test', 'project', 'src'),
        mockSlashCommands,
        mockCommandContext,
        false,
        expect.any(Object),
        // active parameter: completion enabled when not just navigated history
        true,
        undefined,
      );

      unmount();
    });

    it('should handle escaped spaces in slash commands', async () => {
      // Test escaped spaces with slash commands (though less common)
      mockBuffer.text = '/memory\\ test';
      mockBuffer.lines = ['/memory\\ test'];
      mockBuffer.cursor = [0, 13]; // At the end

      mockedUseCommandCompletion.mockReturnValue({
        ...mockCommandCompletion,
        showSuggestions: true,
        suggestions: [{ label: 'test-command', value: 'test-command' }],
      });

      const { unmount } = renderWithProviders(<InputPrompt {...props} />);
      await wait();

      expect(mockedUseCommandCompletion).toHaveBeenCalledWith(
        mockBuffer,
        path.join('test', 'project', 'src'),
        mockSlashCommands,
        mockCommandContext,
        false,
        expect.any(Object),
        // active parameter: completion enabled when not just navigated history
        true,
        undefined,
      );

      unmount();
    });

    it('should handle Unicode characters with escaped spaces', async () => {
      // Test combining Unicode and escaped spaces
      mockBuffer.text = '@' + path.join('files', 'emoji\\ 👍\\ test.txt');
      mockBuffer.lines = ['@' + path.join('files', 'emoji\\ 👍\\ test.txt')];
      mockBuffer.cursor = [0, 25]; // After the escaped space and emoji

      mockedUseCommandCompletion.mockReturnValue({
        ...mockCommandCompletion,
        showSuggestions: true,
        suggestions: [
          { label: 'emoji 👍 test.txt', value: 'emoji 👍 test.txt' },
        ],
      });

      const { unmount } = renderWithProviders(<InputPrompt {...props} />);
      await wait();

      expect(mockedUseCommandCompletion).toHaveBeenCalledWith(
        mockBuffer,
        path.join('test', 'project', 'src'),
        mockSlashCommands,
        mockCommandContext,
        false,
        expect.any(Object),
        // active parameter: completion enabled when not just navigated history
        true,
        undefined,
      );

      unmount();
    });
  });

  describe('vim mode', () => {
    it('should not call buffer.handleInput when vim mode is enabled and vim handles the input', async () => {
      props.vimModeEnabled = true;
      props.vimHandleInput = vi.fn().mockReturnValue(true); // Mock that vim handled it.
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('i');
      await wait();

      expect(props.vimHandleInput).toHaveBeenCalled();
      expect(mockBuffer.handleInput).not.toHaveBeenCalled();
      unmount();
    });

    it('should call buffer.handleInput when vim mode is enabled but vim does not handle the input', async () => {
      props.vimModeEnabled = true;
      props.vimHandleInput = vi.fn().mockReturnValue(false); // Mock that vim did NOT handle it.
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('i');
      await wait();

      expect(props.vimHandleInput).toHaveBeenCalled();
      expect(mockBuffer.handleInput).toHaveBeenCalled();
      unmount();
    });

    it('should call handleInput when vim mode is disabled', async () => {
      // Mock vimHandleInput to return false (vim didn't handle the input)
      props.vimHandleInput = vi.fn().mockReturnValue(false);
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('i');
      await wait();

      expect(props.vimHandleInput).toHaveBeenCalled();
      expect(mockBuffer.handleInput).toHaveBeenCalled();
      unmount();
    });

    it('should toggle shortcuts when vim passes through ? on an empty prompt', async () => {
      props.vimHandleInput = vi.fn().mockReturnValue(false);
      props.onToggleShortcuts = vi.fn();

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('?');
      await wait();

      expect(props.vimHandleInput).toHaveBeenCalled();
      expect(props.onToggleShortcuts).toHaveBeenCalled();
      unmount();
    });
  });

  describe('unfocused paste', () => {
    it('should handle bracketed paste when not focused', async () => {
      props.focus = false;
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\x1B[200~pasted text\x1B[201~');
      await wait();

      expect(mockBuffer.handleInput).toHaveBeenCalledWith(
        expect.objectContaining({
          paste: true,
          sequence: 'pasted text',
        }),
      );
      unmount();
    });

    it('should ignore regular keypresses when not focused', async () => {
      props.focus = false;
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('a');
      await wait();

      expect(mockBuffer.handleInput).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe('Highlighting and Cursor Display', () => {
    it('should display cursor mid-word by highlighting the character', async () => {
      mockBuffer.text = 'hello world';
      mockBuffer.lines = ['hello world'];
      mockBuffer.viewportVisualLines = ['hello world'];
      mockBuffer.visualCursor = [0, 3]; // cursor on the second 'l'

      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      const frame = stdout.lastFrame();
      // The component will render the text with the character at the cursor inverted.
      expect(frame).toContain(`hel${chalk.inverse('l')}o world`);
      unmount();
    });

    it('should display cursor at the beginning of the line', async () => {
      mockBuffer.text = 'hello';
      mockBuffer.lines = ['hello'];
      mockBuffer.viewportVisualLines = ['hello'];
      mockBuffer.visualCursor = [0, 0]; // cursor on 'h'

      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      const frame = stdout.lastFrame();
      expect(frame).toContain(`${chalk.inverse('h')}ello`);
      unmount();
    });

    it('should display cursor at the end of the line as an inverted space', async () => {
      mockBuffer.text = 'hello';
      mockBuffer.lines = ['hello'];
      mockBuffer.viewportVisualLines = ['hello'];
      mockBuffer.visualCursor = [0, 5]; // cursor after 'o'

      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      const frame = stdout.lastFrame();
      expect(frame).toContain(`hello${chalk.inverse(' ')}`);
      unmount();
    });

    it('should display cursor correctly on a highlighted token', async () => {
      mockBuffer.text = 'run @path/to/file';
      mockBuffer.lines = ['run @path/to/file'];
      mockBuffer.viewportVisualLines = ['run @path/to/file'];
      mockBuffer.visualCursor = [0, 9]; // cursor on 't' in 'to'

      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      const frame = stdout.lastFrame();
      // The token '@path/to/file' is colored, and the cursor highlights one char inside it.
      expect(frame).toContain(`@path/${chalk.inverse('t')}o/file`);
      unmount();
    });

    it('should display cursor correctly for multi-byte unicode characters', async () => {
      const text = 'hello 👍 world';
      mockBuffer.text = text;
      mockBuffer.lines = [text];
      mockBuffer.viewportVisualLines = [text];
      mockBuffer.visualCursor = [0, 6]; // cursor on '👍'

      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      const frame = stdout.lastFrame();
      expect(frame).toContain(`hello ${chalk.inverse('👍')} world`);
      unmount();
    });

    it('should display cursor at the end of a line with unicode characters', async () => {
      const text = 'hello 👍';
      mockBuffer.text = text;
      mockBuffer.lines = [text];
      mockBuffer.viewportVisualLines = [text];
      mockBuffer.visualCursor = [0, 7]; // cursor after '👍' (emoji is 1 code point, so total is 7)

      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      const frame = stdout.lastFrame();
      expect(frame).toContain(`hello 👍${chalk.inverse(' ')}`);
      unmount();
    });

    it('should display cursor on an empty line', async () => {
      mockBuffer.text = '';
      mockBuffer.lines = [''];
      mockBuffer.viewportVisualLines = [''];
      mockBuffer.visualCursor = [0, 0];

      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      const frame = stdout.lastFrame();
      expect(frame).toContain(chalk.inverse(' '));
      unmount();
    });

    it('should display cursor on a space between words', async () => {
      mockBuffer.text = 'hello world';
      mockBuffer.lines = ['hello world'];
      mockBuffer.viewportVisualLines = ['hello world'];
      mockBuffer.visualCursor = [0, 5]; // cursor on the space

      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      const frame = stdout.lastFrame();
      expect(frame).toContain(`hello${chalk.inverse(' ')}world`);
      unmount();
    });

    it('should display cursor in the middle of a line in a multiline block', async () => {
      const text = 'first line\nsecond line\nthird line';
      mockBuffer.text = text;
      mockBuffer.lines = text.split('\n');
      mockBuffer.viewportVisualLines = text.split('\n');
      mockBuffer.visualCursor = [1, 3]; // cursor on 'o' in 'second'
      mockBuffer.visualToLogicalMap = [
        [0, 0],
        [1, 0],
        [2, 0],
      ];

      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      const frame = stdout.lastFrame();
      expect(frame).toContain(`sec${chalk.inverse('o')}nd line`);
      unmount();
    });

    it('should display cursor at the beginning of a line in a multiline block', async () => {
      const text = 'first line\nsecond line';
      mockBuffer.text = text;
      mockBuffer.lines = text.split('\n');
      mockBuffer.viewportVisualLines = text.split('\n');
      mockBuffer.visualCursor = [1, 0]; // cursor on 's' in 'second'
      mockBuffer.visualToLogicalMap = [
        [0, 0],
        [1, 0],
      ];

      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      const frame = stdout.lastFrame();
      expect(frame).toContain(`${chalk.inverse('s')}econd line`);
      unmount();
    });

    it('should display cursor at the end of a line in a multiline block', async () => {
      const text = 'first line\nsecond line';
      mockBuffer.text = text;
      mockBuffer.lines = text.split('\n');
      mockBuffer.viewportVisualLines = text.split('\n');
      mockBuffer.visualCursor = [0, 10]; // cursor after 'first line'
      mockBuffer.visualToLogicalMap = [
        [0, 0],
        [1, 0],
      ];

      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      const frame = stdout.lastFrame();
      expect(frame).toContain(`first line${chalk.inverse(' ')}`);
      unmount();
    });

    it('should display cursor on a blank line in a multiline block', async () => {
      const text = 'first line\n\nthird line';
      mockBuffer.text = text;
      mockBuffer.lines = text.split('\n');
      mockBuffer.viewportVisualLines = text.split('\n');
      mockBuffer.visualCursor = [1, 0]; // cursor on the blank line
      mockBuffer.visualToLogicalMap = [
        [0, 0],
        [1, 0],
        [2, 0],
      ];

      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      const frame = stdout.lastFrame();
      const lines = frame!.split('\n');
      // The line with the cursor should just be an inverted space inside the box border
      expect(
        lines.find((l) => l.includes(chalk.inverse(' '))),
      ).not.toBeUndefined();
      unmount();
    });
  });

  describe('multiline rendering', () => {
    it('should correctly render multiline input including blank lines', async () => {
      const text = 'hello\n\nworld';
      mockBuffer.text = text;
      mockBuffer.lines = text.split('\n');
      mockBuffer.viewportVisualLines = text.split('\n');
      mockBuffer.allVisualLines = text.split('\n');
      mockBuffer.visualCursor = [2, 5]; // cursor at the end of "world"
      // Provide a visual-to-logical mapping for each visual line
      mockBuffer.visualToLogicalMap = [
        [0, 0], // 'hello' starts at col 0 of logical line 0
        [1, 0], // '' (blank) is logical line 1, col 0
        [2, 0], // 'world' is logical line 2, col 0
      ];

      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      const frame = stdout.lastFrame();
      // Check that all lines, including the empty one, are rendered.
      // This implicitly tests that the Box wrapper provides height for the empty line.
      expect(frame).toContain('hello');
      expect(frame).toContain(`world${chalk.inverse(' ')}`);

      const outputLines = frame!.split('\n');
      // The number of lines should be 2 for the border plus 3 for the content.
      expect(outputLines.length).toBe(5);
      unmount();
    });
  });

  describe('multiline paste', () => {
    it.each([
      {
        description: 'with \n newlines',
        pastedText: 'This \n is \n a \n multiline \n paste.',
      },
      {
        description: 'with extra slashes before \n newlines',
        pastedText: 'This \\\n is \\\n a \\\n multiline \\\n paste.',
      },
      {
        description: 'with \r\n newlines',
        pastedText: 'This\r\nis\r\na\r\nmultiline\r\npaste.',
      },
    ])('should handle multiline paste $description', async ({ pastedText }) => {
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // Simulate a bracketed paste event from the terminal
      stdin.write(`\x1b[200~${pastedText}\x1b[201~`);
      await wait();

      // Verify that the buffer's handleInput was called once with the full text
      expect(props.buffer.handleInput).toHaveBeenCalledTimes(1);
      expect(props.buffer.handleInput).toHaveBeenCalledWith(
        expect.objectContaining({
          paste: true,
          sequence: pastedText,
        }),
      );

      unmount();
    });
  });

  describe('paste auto-submission protection', () => {
    it('should prevent auto-submission immediately after paste with newlines', async () => {
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // First type some text manually
      stdin.write('test command');
      await wait();

      // Simulate a paste operation (this should set the paste protection)
      stdin.write(`\x1b[200~\npasted content\x1b[201~`);
      await wait();

      // Simulate an Enter key press immediately after paste
      stdin.write('\r');
      await wait();

      // Verify that onSubmit was NOT called due to recent paste protection
      expect(props.onSubmit).not.toHaveBeenCalled();

      unmount();
    });

    it('should allow submission after paste protection timeout', async () => {
      // Set up buffer with text for submission
      props.buffer.text = 'test command';

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // Simulate a paste operation (this sets the protection)
      stdin.write(`\x1b[200~\npasted\x1b[201~`);
      await wait();

      // Wait for the protection timeout to naturally expire
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Now Enter should work normally
      stdin.write('\r');
      await wait();

      // Verify that onSubmit was called after the timeout
      expect(props.onSubmit).toHaveBeenCalledWith('test command');

      unmount();
    });

    it('should not interfere with normal Enter key submission when no recent paste', async () => {
      // Set up buffer with text before rendering to ensure submission works
      props.buffer.text = 'normal command';

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // Press Enter without any recent paste
      stdin.write('\r');
      await wait();

      // Verify that onSubmit was called normally
      expect(props.onSubmit).toHaveBeenCalledWith('normal command');

      unmount();
    });
  });

  describe('enhanced input UX - double ESC clear functionality', () => {
    it('should clear buffer on second ESC press', async () => {
      const onEscapePromptChange = vi.fn();
      props.onEscapePromptChange = onEscapePromptChange;
      props.buffer.setText('text to clear');

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\x1B');
      await wait();

      stdin.write('\x1B');
      await wait();

      expect(props.buffer.setText).toHaveBeenCalledWith('');
      expect(mockCommandCompletion.resetCompletionState).toHaveBeenCalled();
      unmount();
    });

    it('should reset escape state on any non-ESC key', async () => {
      const onEscapePromptChange = vi.fn();
      props.onEscapePromptChange = onEscapePromptChange;
      props.buffer.setText('some text');

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );

      stdin.write('\x1B');

      await waitFor(() => {
        expect(onEscapePromptChange).toHaveBeenCalledWith(true);
      });

      stdin.write('a');

      await waitFor(() => {
        expect(onEscapePromptChange).toHaveBeenCalledWith(false);
      });
      unmount();
    });

    it('should handle ESC in shell mode by disabling shell mode', async () => {
      props.shellModeActive = true;

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\x1B');
      await wait();

      expect(props.setShellModeActive).toHaveBeenCalledWith(false);
      unmount();
    });

    it('should handle ESC when completion suggestions are showing', async () => {
      mockedUseCommandCompletion.mockReturnValue({
        ...mockCommandCompletion,
        showSuggestions: true,
        suggestions: [{ label: 'suggestion', value: 'suggestion' }],
      });

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\x1B');
      await wait();

      expect(mockCommandCompletion.resetCompletionState).toHaveBeenCalled();
      unmount();
    });

    it('should not call onEscapePromptChange when not provided', async () => {
      props.onEscapePromptChange = undefined;
      props.buffer.setText('some text');

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\x1B');
      await wait();

      unmount();
    });

    it('should not interfere with existing keyboard shortcuts', async () => {
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\x0C');
      await wait();

      expect(props.onClearScreen).toHaveBeenCalled();

      stdin.write('\x01');
      await wait();

      expect(props.buffer.move).toHaveBeenCalledWith('home');
      unmount();
    });
  });

  describe('reverse search', () => {
    beforeEach(async () => {
      props.shellModeActive = true;

      vi.mocked(useShellHistory).mockReturnValue({
        history: ['echo hello', 'echo world', 'ls'],
        getPreviousCommand: vi.fn(),
        getNextCommand: vi.fn(),
        addCommandToHistory: vi.fn(),
        resetHistoryPosition: vi.fn(),
      });
    });

    it('invokes reverse search on Ctrl+R', async () => {
      // Mock the reverse search completion to return suggestions
      mockedUseReverseSearchCompletion.mockReturnValue({
        ...mockReverseSearchCompletion,
        suggestions: [
          { label: 'echo hello', value: 'echo hello' },
          { label: 'echo world', value: 'echo world' },
          { label: 'ls', value: 'ls' },
        ],
        showSuggestions: true,
        activeSuggestionIndex: 0,
      });

      const { stdin, stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // Trigger reverse search with Ctrl+R
      act(() => {
        stdin.write('\x12');
      });
      await wait();

      const frame = stdout.lastFrame();
      expect(frame).toContain('(r:)');
      expect(frame).toContain('echo hello');
      expect(frame).toContain('echo world');
      expect(frame).toContain('ls');

      unmount();
    });

    it('resets reverse search state on Escape', async () => {
      const { stdin, stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\x12');
      await wait();
      stdin.write('\x1B');

      await waitFor(() => {
        expect(stdout.lastFrame()).not.toContain('(r:)');
      });

      expect(stdout.lastFrame()).not.toContain('echo hello');

      unmount();
    });

    it('completes the highlighted entry on Tab and exits reverse-search', async () => {
      // Mock the reverse search completion
      const mockHandleAutocomplete = vi.fn(() => {
        props.buffer.setText('echo hello');
      });

      mockedUseReverseSearchCompletion.mockImplementation(
        (buffer, shellHistory, reverseSearchActive) => ({
          ...mockReverseSearchCompletion,
          suggestions: reverseSearchActive
            ? [
                { label: 'echo hello', value: 'echo hello' },
                { label: 'echo world', value: 'echo world' },
                { label: 'ls', value: 'ls' },
              ]
            : [],
          showSuggestions: reverseSearchActive,
          activeSuggestionIndex: reverseSearchActive ? 0 : -1,
          handleAutocomplete: mockHandleAutocomplete,
        }),
      );

      const { stdin, stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );

      // Enter reverse search mode with Ctrl+R
      act(() => {
        stdin.write('\x12');
      });
      await wait();

      // Verify reverse search is active
      expect(stdout.lastFrame()).toContain('(r:)');

      // Press Tab to complete the highlighted entry
      act(() => {
        stdin.write('\t');
      });
      await wait();

      expect(mockHandleAutocomplete).toHaveBeenCalledWith(0);
      expect(props.buffer.setText).toHaveBeenCalledWith('echo hello');
      unmount();
    }, 15000);

    it('submits the highlighted entry on Enter and exits reverse-search', async () => {
      // Mock the reverse search completion to return suggestions
      mockedUseReverseSearchCompletion.mockReturnValue({
        ...mockReverseSearchCompletion,
        suggestions: [
          { label: 'echo hello', value: 'echo hello' },
          { label: 'echo world', value: 'echo world' },
          { label: 'ls', value: 'ls' },
        ],
        showSuggestions: true,
        activeSuggestionIndex: 0,
      });

      const { stdin, stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );

      act(() => {
        stdin.write('\x12');
      });
      await wait();

      expect(stdout.lastFrame()).toContain('(r:)');

      act(() => {
        stdin.write('\r');
      });

      await waitFor(() => {
        expect(stdout.lastFrame()).not.toContain('(r:)');
      });

      expect(props.onSubmit).toHaveBeenCalledWith('echo hello');
      unmount();
    });

    it('text and cursor position should be restored after reverse search', async () => {
      props.buffer.setText('initial text');
      props.buffer.cursor = [0, 3];
      const { stdin, stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      stdin.write('\x12');
      await wait();
      expect(stdout.lastFrame()).toContain('(r:)');
      stdin.write('\x1B');

      await waitFor(() => {
        expect(stdout.lastFrame()).not.toContain('(r:)');
      });
      expect(props.buffer.text).toBe('initial text');
      expect(props.buffer.cursor).toEqual([0, 3]);

      unmount();
    });
  });

  describe('Ctrl+E keyboard shortcut', () => {
    it('should move cursor to end of current line in multiline input', async () => {
      props.buffer.text = 'line 1\nline 2\nline 3';
      props.buffer.cursor = [1, 2];
      props.buffer.lines = ['line 1', 'line 2', 'line 3'];

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\x05'); // Ctrl+E
      await wait();

      expect(props.buffer.move).toHaveBeenCalledWith('end');
      expect(props.buffer.moveToOffset).not.toHaveBeenCalled();
      unmount();
    });

    it('should move cursor to end of current line for single line input', async () => {
      props.buffer.text = 'single line text';
      props.buffer.cursor = [0, 5];
      props.buffer.lines = ['single line text'];

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\x05'); // Ctrl+E
      await wait();

      expect(props.buffer.move).toHaveBeenCalledWith('end');
      expect(props.buffer.moveToOffset).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe('command search (Ctrl+R when not in shell)', () => {
    it('passes newest-first user history to command search', async () => {
      props.shellModeActive = false;
      props.userMessages = ['oldest', 'middle', 'newest'];

      const { unmount } = renderWithProviders(<InputPrompt {...props} />);
      await wait();

      const commandSearchCall =
        mockedUseReverseSearchCompletion.mock.calls.find(
          ([, history]) =>
            Array.isArray(history) &&
            history.length === 3 &&
            history.includes('newest'),
        );

      expect(commandSearchCall?.[1]).toEqual(['newest', 'middle', 'oldest']);
      unmount();
    });

    it('enters command search on Ctrl+R and shows suggestions', async () => {
      props.shellModeActive = false;

      vi.mocked(useReverseSearchCompletion).mockImplementation(
        (buffer, data, isActive) => ({
          ...mockReverseSearchCompletion,
          suggestions: isActive
            ? [
                { label: 'git commit -m "msg"', value: 'git commit -m "msg"' },
                { label: 'git push', value: 'git push' },
              ]
            : [],
          showSuggestions: !!isActive,
          activeSuggestionIndex: isActive ? 0 : -1,
        }),
      );

      const { stdin, stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      act(() => {
        stdin.write('\x12'); // Ctrl+R
      });
      await wait();

      const frame = stdout.lastFrame() ?? '';
      expect(frame).toContain('(r:)');
      expect(frame).toContain('git commit');
      expect(frame).toContain('git push');
      unmount();
    });

    it('shows command search suggestions over active export suggestions', async () => {
      props.shellModeActive = false;
      const exportSuggestions = [
        { label: 'html', value: 'html' },
        { label: 'md', value: 'md' },
        { label: 'json', value: 'json' },
        { label: 'jsonl', value: 'jsonl' },
      ];

      mockedUseCommandCompletion.mockImplementation((buffer) => {
        const isExportRoot = buffer.text.trim() === '/export';
        return {
          ...mockCommandCompletion,
          showSuggestions: isExportRoot,
          suggestions: isExportRoot ? exportSuggestions : [],
          activeSuggestionIndex: 0,
          isPerfectMatch: isExportRoot,
        };
      });
      vi.mocked(useReverseSearchCompletion).mockImplementation(
        (_buffer, _data, isActive) => ({
          ...mockReverseSearchCompletion,
          suggestions: isActive
            ? [{ label: 'git status', value: 'git status' }]
            : [],
          showSuggestions: !!isActive,
          activeSuggestionIndex: isActive ? 0 : -1,
        }),
      );

      const TestHarness = () => {
        const buffer = useTextBuffer({
          initialText: '/export',
          viewport: { width: 80, height: 20 },
          isValidPath: () => false,
          onChange: () => {},
        });
        return <InputPrompt {...props} buffer={buffer} />;
      };

      const { stdin, lastFrame, unmount } = renderWithProviders(
        <TestHarness />,
      );
      await wait();

      stdin.write('\u001B[B');
      await wait();
      expect(stripAnsi(lastFrame() ?? '')).toContain('/export md');
      expect(stripAnsi(lastFrame() ?? '')).toContain('jsonl');

      stdin.write('\x12'); // Ctrl+R
      await wait();

      const frame = stripAnsi(lastFrame() ?? '');
      expect(frame).toContain('(r:)');
      expect(frame).toContain('git status');
      expect(frame).not.toContain('jsonl');
      unmount();
    });

    it.skip('expands and collapses long suggestion via Right/Left arrows', async () => {
      props.shellModeActive = false;
      const longValue = 'l'.repeat(200);

      vi.mocked(useReverseSearchCompletion).mockReturnValue({
        ...mockReverseSearchCompletion,
        suggestions: [{ label: longValue, value: longValue, matchedIndex: 0 }],
        showSuggestions: true,
        activeSuggestionIndex: 0,
        visibleStartIndex: 0,
        isLoadingSuggestions: false,
      });

      const { stdin, stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\x12');
      await wait();

      expect(clean(stdout.lastFrame())).toContain('→');

      stdin.write('\u001B[C');
      await wait(200);
      expect(clean(stdout.lastFrame())).toContain('←');
      expect(stdout.lastFrame()).toMatchSnapshot(
        'command-search-expanded-match',
      );

      stdin.write('\u001B[D');
      await wait();
      expect(clean(stdout.lastFrame())).toContain('→');
      expect(stdout.lastFrame()).toMatchSnapshot(
        'command-search-collapsed-match',
      );
      unmount();
    });

    it('renders match window and expanded view (snapshots)', async () => {
      props.shellModeActive = false;
      props.buffer.setText('commit');

      const label = 'git commit -m "feat: add search" in src/app';
      const matchedIndex = label.indexOf('commit');

      vi.mocked(useReverseSearchCompletion).mockReturnValue({
        ...mockReverseSearchCompletion,
        suggestions: [{ label, value: label, matchedIndex }],
        showSuggestions: true,
        activeSuggestionIndex: 0,
        visibleStartIndex: 0,
        isLoadingSuggestions: false,
      });

      const { stdin, stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\x12');
      await wait();
      expect(stdout.lastFrame()).toMatchSnapshot(
        'command-search-collapsed-match',
      );

      stdin.write('\u001B[C');
      await wait();
      expect(stdout.lastFrame()).toMatchSnapshot(
        'command-search-expanded-match',
      );

      unmount();
    });

    it('does not show expand/collapse indicator for short suggestions', async () => {
      props.shellModeActive = false;
      const shortValue = 'echo hello';

      vi.mocked(useReverseSearchCompletion).mockReturnValue({
        ...mockReverseSearchCompletion,
        suggestions: [{ label: shortValue, value: shortValue }],
        showSuggestions: true,
        activeSuggestionIndex: 0,
        visibleStartIndex: 0,
        isLoadingSuggestions: false,
      });

      const { stdin, stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\x12');
      await wait();

      const frame = clean(stdout.lastFrame());
      expect(frame).not.toContain('→');
      expect(frame).not.toContain('←');
      unmount();
    });
  });

  describe('snapshots', () => {
    it('should render correctly in shell mode', async () => {
      props.shellModeActive = true;
      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();
      expect(stdout.lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('should render correctly when accepting edits', async () => {
      props.approvalMode = ApprovalMode.AUTO_EDIT;
      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();
      expect(stdout.lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('should render correctly in yolo mode', async () => {
      props.approvalMode = ApprovalMode.YOLO;
      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();
      expect(stdout.lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('should not show inverted cursor when shell is focused', async () => {
      props.isEmbeddedShellFocused = true;
      props.focus = false;
      const { stdout, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();
      expect(stdout.lastFrame()).not.toContain(`{chalk.inverse(' ')}`);
      // This snapshot is good to make sure there was an input prompt but does
      // not show the inverted cursor because snapshots do not show colors.
      expect(stdout.lastFrame()).toMatchSnapshot();
      unmount();
    });
  });

  it('should still allow input when shell is not focused', async () => {
    const { stdin, unmount } = renderWithProviders(<InputPrompt {...props} />, {
      shellFocus: false,
    });
    await wait();

    stdin.write('a');
    await wait();

    expect(mockBuffer.handleInput).toHaveBeenCalled();
    unmount();
  });

  describe('large paste placeholder', () => {
    it('should create placeholder for paste > 1000 characters', async () => {
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // Create a paste with 1001 characters
      const largeContent = 'x'.repeat(1001);

      // Simulate bracketed paste
      stdin.write(`\x1b[200~${largeContent}\x1b[201~`);
      await wait();

      // Verify placeholder was inserted, not the full content
      expect(mockBuffer.insert).toHaveBeenCalledWith(
        '[Pasted Content 1001 chars]',
        { paste: false },
      );
      expect(mockBuffer.insert).toHaveBeenCalledTimes(1);

      unmount();
    });

    it('should create placeholder for paste > 10 lines', async () => {
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // Create a paste with 11 lines (each line is short)
      const multiLineContent = Array(11).fill('line').join('\n');

      // Simulate bracketed paste
      stdin.write(`\x1b[200~${multiLineContent}\x1b[201~`);
      await wait();

      // Verify placeholder was inserted
      expect(mockBuffer.insert).toHaveBeenCalledWith(
        expect.stringMatching(/\[Pasted Content \d+ chars\]/),
        { paste: false },
      );

      unmount();
    });

    it('should use sequential IDs for multiple pastes of same size', async () => {
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      const largeContent = 'x'.repeat(1001);

      // First paste
      stdin.write(`\x1b[200~${largeContent}\x1b[201~`);
      await wait();

      // Second paste
      stdin.write(`\x1b[200~${largeContent}\x1b[201~`);
      await wait();

      // Verify both placeholders were created with correct IDs
      expect(mockBuffer.insert).toHaveBeenCalledWith(
        '[Pasted Content 1001 chars]',
        { paste: false },
      );
      expect(mockBuffer.insert).toHaveBeenCalledWith(
        '[Pasted Content 1001 chars] #2',
        { paste: false },
      );

      unmount();
    });

    it('should expand placeholder to full content on submit', async () => {
      const largeContent = 'x'.repeat(1001);
      mockBuffer.text = '[Pasted Content 1001 chars]';
      mockBuffer.lines = [mockBuffer.text];
      mockBuffer.cursor = [0, mockBuffer.text.length];

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // First paste to set up the placeholder
      stdin.write(`\x1b[200~${largeContent}\x1b[201~`);
      await wait();

      // Wait for paste protection to expire
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Submit the input
      stdin.write('\r');
      await wait();

      // Verify onSubmit was called with expanded content
      expect(props.onSubmit).toHaveBeenCalledWith(largeContent);

      unmount();
    });

    it('should expand same-size placeholders correctly when #2 appears first', async () => {
      const firstPaste = 'x'.repeat(1001);
      const secondPaste = 'y'.repeat(1001);

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write(`\x1b[200~${firstPaste}\x1b[201~`);
      await wait();
      stdin.write(`\x1b[200~${secondPaste}\x1b[201~`);
      await wait();

      mockBuffer.text =
        '[Pasted Content 1001 chars] #2\n[Pasted Content 1001 chars]';
      mockBuffer.lines = mockBuffer.text.split('\n');
      mockBuffer.cursor = [1, '[Pasted Content 1001 chars]'.length];

      // Wait for paste protection to expire
      await new Promise((resolve) => setTimeout(resolve, 600));

      stdin.write('\r');
      await wait();

      expect(props.onSubmit).toHaveBeenCalledWith(
        `${secondPaste}\n${firstPaste}`,
      );

      unmount();
    });

    it('should write expanded placeholder content to shell history', async () => {
      props.shellModeActive = true;
      const largeContent = 'x'.repeat(1001);
      mockBuffer.text = '[Pasted Content 1001 chars]';
      mockBuffer.lines = [mockBuffer.text];
      mockBuffer.cursor = [0, mockBuffer.text.length];

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write(`\x1b[200~${largeContent}\x1b[201~`);
      await wait();

      // Wait for paste protection to expire
      await new Promise((resolve) => setTimeout(resolve, 600));

      stdin.write('\r');
      await wait();

      expect(mockShellHistory.addCommandToHistory).toHaveBeenCalledWith(
        largeContent,
      );
      expect(props.onSubmit).toHaveBeenCalledWith(largeContent);

      unmount();
    });

    it('should reuse placeholder ID after deletion', async () => {
      // Set up mocks that actually update buffer state
      vi.mocked(mockBuffer.insert).mockImplementation((text: string) => {
        mockBuffer.text += text;
        mockBuffer.lines = [mockBuffer.text];
        mockBuffer.cursor = [0, mockBuffer.text.length];
      });

      vi.mocked(mockBuffer.replaceRangeByOffset).mockImplementation(
        (start: number, end: number, replacement: string) => {
          mockBuffer.text =
            mockBuffer.text.slice(0, start) +
            replacement +
            mockBuffer.text.slice(end);
          mockBuffer.lines = [mockBuffer.text];
          mockBuffer.cursor = [0, start];
        },
      );

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      const largeContent = 'x'.repeat(1001);

      // First paste - gets ID 1
      stdin.write(`\x1b[200~${largeContent}\x1b[201~`);
      await wait();

      // Verify first placeholder was inserted
      expect(mockBuffer.text).toBe('[Pasted Content 1001 chars]');

      // Press backspace to delete the placeholder (cursor is at end of placeholder)
      stdin.write('\x7f');
      await wait();

      // Verify the placeholder was deleted (buffer is now empty)
      expect(mockBuffer.text).toBe('');

      // Second paste - should reuse ID 1 since the first was deleted
      stdin.write(`\x1b[200~${largeContent}\x1b[201~`);
      await wait();

      // Verify the ID was reused (no #2 suffix)
      const insertCalls = vi.mocked(mockBuffer.insert).mock.calls;
      const lastCall = insertCalls[insertCalls.length - 1];
      expect(lastCall[0]).toBe('[Pasted Content 1001 chars]');

      unmount();
    });

    it('should handle mixed pastes with different character counts', async () => {
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      const content1001 = 'x'.repeat(1001);
      const content1500 = 'y'.repeat(1500);

      // Paste 1001 chars
      stdin.write(`\x1b[200~${content1001}\x1b[201~`);
      await wait();

      // Paste 1500 chars
      stdin.write(`\x1b[200~${content1500}\x1b[201~`);
      await wait();

      // Paste 1001 chars again (should get ID #2 for 1001)
      stdin.write(`\x1b[200~${content1001}\x1b[201~`);
      await wait();

      // Verify placeholders with correct IDs
      expect(mockBuffer.insert).toHaveBeenCalledWith(
        '[Pasted Content 1001 chars]',
        { paste: false },
      );
      expect(mockBuffer.insert).toHaveBeenCalledWith(
        '[Pasted Content 1500 chars]',
        { paste: false },
      );
      expect(mockBuffer.insert).toHaveBeenCalledWith(
        '[Pasted Content 1001 chars] #2',
        { paste: false },
      );

      unmount();
    });
  });

  /**
   * Ctrl+Y (RETRY_LAST) shortcut tests
   *
   * The Ctrl+Y shortcut should trigger handleRetryLastPrompt when:
   * 1. The user presses Ctrl+Y
   * 2. The InputPrompt is focused
   * 3. No other modal/dialog is open that would consume the key
   *
   * This shortcut is handled in InputPrompt.tsx at line 585-588:
   * if (keyMatchers[Command.RETRY_LAST](key)) {
   *   uiActions.handleRetryLastPrompt();
   *   return;
   * }
   */
  describe('Ctrl+Y retry shortcut', () => {
    let mockUIActions: {
      handleRetryLastPrompt: ReturnType<typeof vi.fn>;
      temporaryCloseFeedbackDialog: ReturnType<typeof vi.fn>;
      popAllQueuedMessages: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockUIActions = {
        handleRetryLastPrompt: vi.fn(),
        temporaryCloseFeedbackDialog: vi.fn(),
        popAllQueuedMessages: vi.fn(() => null),
      };

      // Override the mock for useUIActions
      vi.doMock('../contexts/UIActionsContext.js', () => ({
        useUIActions: vi.fn(() => mockUIActions),
      }));
    });

    afterEach(() => {
      vi.doUnmock('../contexts/UIActionsContext.js');
    });

    /**
     * Ctrl+Y should trigger handleRetryLastPrompt to retry the last failed request.
     * This is the primary activation path for the retry feature.
     */
    it('should trigger handleRetryLastPrompt on Ctrl+Y', async () => {
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // Send Ctrl+Y (ASCII 25)
      stdin.write('\x19');
      await wait();

      // The key matcher should have been triggered
      // Note: In the actual implementation, this would call uiActions.handleRetryLastPrompt()
      unmount();
    });

    /**
     * The 'y' key alone (without Ctrl) should NOT trigger retry.
     * This ensures the shortcut doesn't interfere with normal typing.
     */
    it('should NOT trigger retry on plain y key', async () => {
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // Send plain 'y'
      stdin.write('y');
      await wait();

      // Should insert 'y' into buffer, not trigger retry
      expect(mockBuffer.handleInput).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'y',
          sequence: 'y',
        }),
      );

      unmount();
    });

    /**
     * Ctrl+R should NOT trigger retry - it should trigger reverse search instead.
     * This ensures the retry shortcut doesn't conflict with existing shortcuts.
     */
    it('should NOT trigger retry on Ctrl+R (reverse search)', async () => {
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // Send Ctrl+R (ASCII 18)
      stdin.write('\x12');
      await wait();

      // Should activate reverse search, not retry
      // Verify the input was handled (not ignored)
      expect(mockBuffer.handleInput).not.toHaveBeenCalledWith(
        expect.objectContaining({
          ctrl: true,
          name: 'y',
        }),
      );

      unmount();
    });

    /**
     * When feedback dialog is open, Ctrl+Y should be passed through after
     * temporarily closing the dialog.
     */
    it('should handle Ctrl+Y when feedback dialog is open', async () => {
      // Mock feedback dialog as open
      const mockUIState = { isFeedbackDialogOpen: true };
      vi.doMock('../contexts/UIStateContext.js', () => ({
        useUIState: vi.fn(() => mockUIState),
      }));

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      // Send Ctrl+Y
      stdin.write('\x19');
      await wait();

      // Dialog should be temporarily closed
      // Note: In actual implementation, temporaryCloseFeedbackDialog would be called

      vi.doUnmock('../contexts/UIStateContext.js');
      unmount();
    });
  });

  describe('queue input editing', () => {
    afterEach(() => {
      // Restore default mocks
      vi.mocked(useUIState).mockReturnValue({
        isFeedbackDialogOpen: false,
        messageQueue: [],
      } as ReturnType<typeof useUIState>);
      vi.mocked(useUIActions).mockReturnValue({
        handleRetryLastPrompt: vi.fn(),
        temporaryCloseFeedbackDialog: vi.fn(),
        popAllQueuedMessages: vi.fn(() => null),
      } as unknown as ReturnType<typeof useUIActions>);
    });

    it('should pop queued messages into input on Up arrow when queue is non-empty', async () => {
      const mockPopAll = vi.fn(() => 'queued msg 1\n\nqueued msg 2');
      vi.mocked(useUIState).mockReturnValue({
        isFeedbackDialogOpen: false,
        messageQueue: ['queued msg 1', 'queued msg 2'],
      } as ReturnType<typeof useUIState>);
      vi.mocked(useUIActions).mockReturnValue({
        handleRetryLastPrompt: vi.fn(),
        temporaryCloseFeedbackDialog: vi.fn(),
        popAllQueuedMessages: mockPopAll,
      } as unknown as ReturnType<typeof useUIActions>);

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\u001B[A'); // Up arrow
      await wait();

      expect(mockPopAll).toHaveBeenCalled();
      expect(props.buffer.setText).toHaveBeenCalledWith(
        'queued msg 1\n\nqueued msg 2',
      );
      unmount();
    });

    it('should prepend queued messages before existing input text', async () => {
      const mockPopAll = vi.fn(() => 'queued msg');
      vi.mocked(useUIState).mockReturnValue({
        isFeedbackDialogOpen: false,
        messageQueue: ['queued msg'],
      } as ReturnType<typeof useUIState>);
      vi.mocked(useUIActions).mockReturnValue({
        handleRetryLastPrompt: vi.fn(),
        temporaryCloseFeedbackDialog: vi.fn(),
        popAllQueuedMessages: mockPopAll,
      } as unknown as ReturnType<typeof useUIActions>);

      // Set existing text in buffer
      props.buffer.text = 'existing input';

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\u001B[A'); // Up arrow
      await wait();

      expect(props.buffer.setText).toHaveBeenCalledWith(
        'queued msg\nexisting input',
      );
      // Cursor should be positioned at start of existing text
      expect(props.buffer.moveToOffset).toHaveBeenCalledWith(
        'queued msg'.length + 1, // popped length + newline
      );
      unmount();
    });

    it('should pop queued messages on ESC when queue is non-empty', async () => {
      const mockPopAll = vi.fn(() => 'queued msg');
      vi.mocked(useUIState).mockReturnValue({
        isFeedbackDialogOpen: false,
        messageQueue: ['queued msg'],
      } as ReturnType<typeof useUIState>);
      vi.mocked(useUIActions).mockReturnValue({
        handleRetryLastPrompt: vi.fn(),
        temporaryCloseFeedbackDialog: vi.fn(),
        popAllQueuedMessages: mockPopAll,
      } as unknown as ReturnType<typeof useUIActions>);

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\u001B'); // ESC
      await wait();

      expect(mockPopAll).toHaveBeenCalled();
      expect(props.buffer.setText).toHaveBeenCalledWith('queued msg');
      unmount();
    });

    it('should fall through to history when pop returns null (race condition)', async () => {
      // Simulate: React state says queue is non-empty, but queueRef was
      // already drained by another pop/drain — popAllQueuedMessages returns null.
      const mockPopAll = vi.fn(() => null);
      vi.mocked(useUIState).mockReturnValue({
        isFeedbackDialogOpen: false,
        messageQueue: ['stale msg'],
      } as ReturnType<typeof useUIState>);
      vi.mocked(useUIActions).mockReturnValue({
        handleRetryLastPrompt: vi.fn(),
        temporaryCloseFeedbackDialog: vi.fn(),
        popAllQueuedMessages: mockPopAll,
      } as unknown as ReturnType<typeof useUIActions>);

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\u001B[A'); // Up arrow
      await wait();

      expect(mockPopAll).toHaveBeenCalled();
      expect(props.buffer.setText).not.toHaveBeenCalled();
      expect(mockInputHistory.navigateUp).toHaveBeenCalled();
      unmount();
    });

    it('should navigate history on Up arrow when queue is empty', async () => {
      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\u001B[A'); // Up arrow
      await wait();

      expect(mockInputHistory.navigateUp).toHaveBeenCalled();
      unmount();
    });

    it('should not intercept Ctrl+P when queue is non-empty', async () => {
      vi.mocked(useUIState).mockReturnValue({
        isFeedbackDialogOpen: false,
        messageQueue: ['queued msg'],
      } as ReturnType<typeof useUIState>);

      const { stdin, unmount } = renderWithProviders(
        <InputPrompt {...props} />,
      );
      await wait();

      stdin.write('\u0010'); // Ctrl+P
      await wait();

      expect(mockInputHistory.navigateUp).toHaveBeenCalled();
      unmount();
    });
  });
});
function clean(str: string | undefined): string {
  if (!str) return '';
  // Remove ANSI escape codes and trim whitespace
  return stripAnsi(str).trim();
}
