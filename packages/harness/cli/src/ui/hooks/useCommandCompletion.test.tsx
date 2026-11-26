/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  afterEach,
  type Mock,
} from 'vitest';
import { act, useEffect } from 'react';
import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import {
  useCommandCompletion,
  CompletionMode,
} from './useCommandCompletion.js';
import type { CommandContext, SlashCommand } from '../commands/types.js';
import type { Config } from '@qwen-code/core';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import {
  useAtCompletion,
  type UseAtCompletionProps,
} from './useAtCompletion.js';
import {
  useSlashCompletion,
  type UseSlashCompletionProps,
} from './useSlashCompletion.js';
import { useShellCompletion } from './useShellCompletion.js';
import { CommandService } from '../../services/CommandService.js';

vi.mock('./useAtCompletion', () => ({
  useAtCompletion: vi.fn(),
}));

vi.mock('./usePromptCompletion', () => ({
  usePromptCompletion: vi.fn(() => ({
    text: '',
    isLoading: false,
    isActive: false,
    accept: vi.fn(),
    clear: vi.fn(),
    markSelected: vi.fn(),
  })),
}));

vi.mock('./useSlashCompletion', () => ({
  useSlashCompletion: vi.fn(() => ({
    completionStart: 0,
    completionEnd: 0,
  })),
}));

vi.mock('./useShellCompletion', () => ({
  useShellCompletion: vi.fn(() => ({
    completionStart: 0,
    completionEnd: 0,
    query: '',
    activeStart: 0,
  })),
}));

// Helper to set up mocks in a consistent way for both child hooks
const setupMocks = ({
  atSuggestions = [],
  slashSuggestions = [],
  shellSuggestions = [],
  isLoading = false,
  isPerfectMatch = false,
  slashCompletionRange = {
    completionStart: 0,
    completionEnd: 0,
    getCommandFromSuggestion: () => undefined,
  },
  shellCompletionRange = {
    completionStart: 0,
    completionEnd: 0,
    query: '',
    activeStart: 0,
  },
}: {
  atSuggestions?: Suggestion[];
  slashSuggestions?: Suggestion[];
  shellSuggestions?: Suggestion[];
  isLoading?: boolean;
  isPerfectMatch?: boolean;
  slashCompletionRange?: {
    completionStart: number;
    completionEnd: number;
    getCommandFromSuggestion: (
      suggestion: Suggestion,
    ) => SlashCommand | undefined;
  };
  shellCompletionRange?: {
    completionStart: number;
    completionEnd: number;
    query: string;
    activeStart?: number;
  };
}) => {
  // Mock for @-completions
  (useAtCompletion as Mock).mockImplementation(
    ({
      enabled,
      setSuggestions,
      setIsLoadingSuggestions,
    }: UseAtCompletionProps) => {
      useEffect(() => {
        if (enabled) {
          setIsLoadingSuggestions(isLoading);
          setSuggestions(atSuggestions);
        }
      }, [enabled, setSuggestions, setIsLoadingSuggestions]);
    },
  );

  // Mock for /-completions
  (useSlashCompletion as Mock).mockImplementation(
    ({
      enabled,
      setSuggestions,
      setIsLoadingSuggestions,
      setIsPerfectMatch,
    }: UseSlashCompletionProps) => {
      useEffect(() => {
        if (enabled) {
          setIsLoadingSuggestions(isLoading);
          setSuggestions(slashSuggestions);
          setIsPerfectMatch(isPerfectMatch);
        }
      }, [enabled, setSuggestions, setIsLoadingSuggestions, setIsPerfectMatch]);
      // The hook returns a range, which we can mock simply
      return slashCompletionRange;
    },
  );

  // Mock for shell completions
  (useShellCompletion as Mock).mockImplementation(
    ({ enabled, setSuggestions, setIsLoadingSuggestions }) => {
      useEffect(() => {
        if (enabled) {
          setIsLoadingSuggestions(isLoading);
          setSuggestions(shellSuggestions);
        }
      }, [enabled, setSuggestions, setIsLoadingSuggestions]);
      return {
        ...shellCompletionRange,
        activeStart: shellCompletionRange.activeStart ?? 0,
      };
    },
  );
};

describe('useCommandCompletion', () => {
  const mockCommandContext = {} as CommandContext;
  const mockConfig = {
    getEnablePromptCompletion: () => false,
  } as unknown as Config;
  const testRootDir = '/';

  // Helper to create real TextBuffer objects within renderHook
  function useTextBufferForTest(text: string, cursorOffset?: number) {
    return useTextBuffer({
      initialText: text,
      initialCursorOffset: cursorOffset ?? text.length,
      viewport: { width: 80, height: 20 },
      onChange: () => {},
    });
  }

  let hookResult: ReturnType<typeof useCommandCompletion> & {
    textBuffer: ReturnType<typeof useTextBuffer>;
  };

  function TestComponent({
    initialText,
    cursorOffset,
    shellModeActive,
    active,
  }: {
    initialText: string;
    cursorOffset?: number;
    shellModeActive: boolean;
    active: boolean;
  }) {
    const textBuffer = useTextBufferForTest(initialText, cursorOffset);
    const completion = useCommandCompletion({
      buffer: textBuffer,
      cwd: testRootDir,
      slashCommands: [],
      commandContext: mockCommandContext,
      reverseSearchActive: false,
      shellModeActive,
      config: mockConfig,
      active,
    });
    hookResult = { ...completion, textBuffer };
    return null;
  }

  const renderCommandCompletionHook = async (
    initialText: string,
    cursorOffset?: number,
    shellModeActive = false,
    active = true,
  ) => {
    const renderResult = await renderWithProviders(
      <TestComponent
        initialText={initialText}
        cursorOffset={cursorOffset}
        shellModeActive={shellModeActive}
        active={active}
      />,
    );
    return {
      result: {
        get current() {
          return hookResult;
        },
      },
      ...renderResult,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default mocks before each test
    setupMocks({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not reread the command catalog while typing ordinary text', async () => {
    const read = vi.spyOn(CommandService, 'readCurrentCommands');
    const view = await renderCommandCompletionHook('hello');
    expect(read).not.toHaveBeenCalled();
    await act(async () => { view.result.current.textBuffer.setText('hello world'); });
    expect(read).not.toHaveBeenCalled();
    await act(async () => { view.result.current.textBuffer.setText('/help'); });
    await waitFor(() => expect(read).toHaveBeenCalled());
    view.unmount();
  });

  it('rereads plugin commands when input changes without a reload notification', async () => {
    let commands = [{ name: 'first', description: 'First' }] as SlashCommand[];
    vi.spyOn(CommandService, 'readCurrentCommands').mockImplementation(() => commands);
    const view = await renderCommandCompletionHook('/f');
    expect(vi.mocked(useSlashCompletion).mock.lastCall?.[0].slashCommands).toBe(commands);
    commands = [{ name: 'second', description: 'Second' }] as SlashCommand[];
    await act(async () => { view.result.current.textBuffer.setText('/s'); });
    await waitFor(() => expect(vi.mocked(useSlashCompletion).mock.lastCall?.[0].slashCommands).toBe(commands));
    view.unmount();
  });


  describe('Core Hook Behavior', () => {
    describe('State Management', () => {
      it('should initialize with default state', async () => {
        const { result } = await renderCommandCompletionHook('');

        expect(result.current.suggestions).toEqual([]);
        expect(result.current.activeSuggestionIndex).toBe(-1);
        expect(result.current.visibleStartIndex).toBe(0);
        expect(result.current.showSuggestions).toBe(false);
        expect(result.current.isLoadingSuggestions).toBe(false);
        expect(result.current.completionMode).toBe(CompletionMode.IDLE);
      });

      it('should reset state when completion mode becomes IDLE', async () => {
        setupMocks({
          atSuggestions: [{ label: 'src/file.txt', value: 'src/file.txt' }],
        });

        const { result } = await renderCommandCompletionHook('@file');

        await waitFor(() => {
          expect(result.current.suggestions).toHaveLength(1);
        });

        expect(result.current.showSuggestions).toBe(true);

        act(() => {
          result.current.textBuffer.replaceRangeByOffset(
            0,
            5,
            'just some text',
          );
        });

        await waitFor(() => {
          expect(result.current.showSuggestions).toBe(false);
        });
      });

      it('should reset all state to default values', async () => {
        const { result } = await renderCommandCompletionHook('@files');

        act(() => {
          result.current.setActiveSuggestionIndex(5);
        });

        act(() => {
          result.current.resetCompletionState();
        });

        expect(result.current.activeSuggestionIndex).toBe(-1);
        expect(result.current.visibleStartIndex).toBe(0);
        expect(result.current.showSuggestions).toBe(false);
      });

      it('should call useAtCompletion with the correct query for an escaped space', async () => {
        const text = '@src/a\\ file.txt';
        const { result } = await renderCommandCompletionHook(text);

        await waitFor(() => {
          expect(useAtCompletion).toHaveBeenLastCalledWith(
            expect.objectContaining({
              enabled: true,
              pattern: 'src/a\\ file.txt',
            }),
          );
          expect(result.current.completionMode).toBe(CompletionMode.AT);
        });
      });

      it('should correctly identify the completion context with multiple @ symbols', async () => {
        const text = '@file1 @file2';
        const cursorOffset = 3; // @fi|le1 @file2

        await renderCommandCompletionHook(text, cursorOffset);

        await waitFor(() => {
          expect(useAtCompletion).toHaveBeenLastCalledWith(
            expect.objectContaining({
              enabled: true,
              pattern: 'file1',
            }),
          );
        });
      });

      it.each([
        {
          shellModeActive: false,
          expectedSuggestions: 1,
          expectedShowSuggestions: true,
          description:
            'should show slash command suggestions when shellModeActive is false',
        },
        {
          shellModeActive: true,
          expectedSuggestions: 0,
          expectedShowSuggestions: false,
          description:
            'should not show slash command suggestions when shellModeActive is true',
        },
      ])(
        '$description',
        async ({
          shellModeActive,
          expectedSuggestions,
          expectedShowSuggestions,
        }) => {
          setupMocks({
            slashSuggestions: [{ label: 'clear', value: 'clear' }],
          });

          const { result } = await renderCommandCompletionHook(
            '/',
            undefined,
            shellModeActive,
          );

          await waitFor(() => {
            expect(result.current.suggestions.length).toBe(expectedSuggestions);
            expect(result.current.showSuggestions).toBe(
              expectedShowSuggestions,
            );
            if (!shellModeActive) {
              expect(result.current.completionMode).toBe(CompletionMode.SLASH);
            }
          });
        },
      );
    });

    describe('Navigation', () => {
      const mockSuggestions = [
        { label: 'cmd1', value: 'cmd1' },
        { label: 'cmd2', value: 'cmd2' },
        { label: 'cmd3', value: 'cmd3' },
        { label: 'cmd4', value: 'cmd4' },
        { label: 'cmd5', value: 'cmd5' },
      ];

      beforeEach(() => {
        setupMocks({ slashSuggestions: mockSuggestions });
      });

      it('should handle navigateUp with no suggestions', async () => {
        setupMocks({ slashSuggestions: [] });

        const { result } = await renderCommandCompletionHook('/');

        act(() => {
          result.current.navigateUp();
        });

        expect(result.current.activeSuggestionIndex).toBe(-1);
      });

      it('should handle navigateDown with no suggestions', async () => {
        setupMocks({ slashSuggestions: [] });
        const { result } = await renderCommandCompletionHook('/');

        act(() => {
          result.current.navigateDown();
        });

        expect(result.current.activeSuggestionIndex).toBe(-1);
      });

      it('should navigate up through suggestions with wrap-around', async () => {
        const { result } = await renderCommandCompletionHook('/');

        await waitFor(() => {
          expect(result.current.suggestions.length).toBe(5);
        });

        expect(result.current.activeSuggestionIndex).toBe(0);

        act(() => {
          result.current.navigateUp();
        });

        expect(result.current.activeSuggestionIndex).toBe(4);
      });

      it('should navigate down through suggestions with wrap-around', async () => {
        const { result } = await renderCommandCompletionHook('/');

        await waitFor(() => {
          expect(result.current.suggestions.length).toBe(5);
        });

        act(() => {
          result.current.setActiveSuggestionIndex(4);
        });
        expect(result.current.activeSuggestionIndex).toBe(4);

        act(() => {
          result.current.navigateDown();
        });

        expect(result.current.activeSuggestionIndex).toBe(0);
      });

      it('should handle navigation with multiple suggestions', async () => {
        const { result } = await renderCommandCompletionHook('/');

        await waitFor(() => {
          expect(result.current.suggestions.length).toBe(5);
        });

        expect(result.current.activeSuggestionIndex).toBe(0);

        act(() => result.current.navigateDown());
        expect(result.current.activeSuggestionIndex).toBe(1);

        act(() => result.current.navigateDown());
        expect(result.current.activeSuggestionIndex).toBe(2);

        act(() => result.current.navigateUp());
        expect(result.current.activeSuggestionIndex).toBe(1);

        act(() => result.current.navigateUp());
        expect(result.current.activeSuggestionIndex).toBe(0);

        act(() => result.current.navigateUp());
        expect(result.current.activeSuggestionIndex).toBe(4);
      });

      it('should automatically select the first item when suggestions are available', async () => {
        setupMocks({ slashSuggestions: mockSuggestions });

        const { result } = await renderCommandCompletionHook('/');

        await waitFor(() => {
          expect(result.current.suggestions.length).toBe(
            mockSuggestions.length,
          );
          expect(result.current.activeSuggestionIndex).toBe(0);
        });
      });
    });
  });

  describe('handleAutocomplete', () => {
    it('inserts the model ID when the selected suggestion displays a model name', async () => {
      setupMocks({
        slashSuggestions: [
          { label: 'Qwen3.8-Max', value: 'qmodel_38max' },
        ],
        slashCompletionRange: {
          completionStart: 7,
          completionEnd: 11,
          getCommandFromSuggestion: () =>
            ({ action: vi.fn() }) as unknown as SlashCommand,
        },
      });

      const { result } = await renderCommandCompletionHook('/model Qwen');

      await waitFor(() => {
        expect(result.current.suggestions).toEqual([
          { label: 'Qwen3.8-Max', value: 'qmodel_38max' },
        ]);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      expect(result.current.textBuffer.text).toBe('/model qmodel_38max ');
    });

    it('should complete a partial command and ADD a space even if it has an action', async () => {
      setupMocks({
        slashSuggestions: [{ label: 'memory', value: 'memory' }],
        slashCompletionRange: {
          completionStart: 1,
          completionEnd: 4,
          getCommandFromSuggestion: () =>
            ({ action: vi.fn() }) as unknown as SlashCommand,
        },
      });

      const { result } = await renderCommandCompletionHook('/mem');

      await waitFor(() => {
        expect(result.current.suggestions.length).toBe(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      expect(result.current.textBuffer.text).toBe('/memory ');
    });

    it('should complete a partial command and ADD a space if it has NO action (e.g. just a parent)', async () => {
      setupMocks({
        slashSuggestions: [{ label: 'chat', value: 'chat' }],
        slashCompletionRange: {
          completionStart: 1,
          completionEnd: 5,
          getCommandFromSuggestion: () => ({}) as unknown as SlashCommand, // No action
        },
      });

      const { result } = await renderCommandCompletionHook('/chat');

      await waitFor(() => {
        expect(result.current.suggestions.length).toBe(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      expect(result.current.textBuffer.text).toBe('/chat ');
    });

    it('should complete a file path', async () => {
      setupMocks({
        atSuggestions: [{ label: 'src/file1.txt', value: 'src/file1.txt' }],
        slashCompletionRange: {
          completionStart: 0,
          completionEnd: 0,
          getCommandFromSuggestion: () => undefined,
        },
      });

      const { result } = await renderCommandCompletionHook('@src/fi');

      await waitFor(() => {
        expect(result.current.suggestions.length).toBe(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      expect(result.current.textBuffer.text).toBe('@src/file1.txt ');
    });

    it('should insert canonical slash command text when suggestion provides insertValue', async () => {
      setupMocks({
        slashSuggestions: [
          {
            label: 'resume',
            value: 'resume',
            insertValue: 'resume',
          },
        ],
        slashCompletionRange: {
          completionStart: 1,
          completionEnd: 5,
          getCommandFromSuggestion: () => undefined,
        },
      });

      const { result } = await renderCommandCompletionHook('/resu');

      await waitFor(() => {
        expect(result.current.suggestions.length).toBe(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      expect(result.current.textBuffer.text).toBe('/resume ');
    });

    it('should complete a file path when cursor is not at the end of the line', async () => {
      const text = '@src/fi is a good file';
      const cursorOffset = 7; // after "i"

      setupMocks({
        atSuggestions: [{ label: 'src/file1.txt', value: 'src/file1.txt' }],
        slashCompletionRange: {
          completionStart: 0,
          completionEnd: 0,
          getCommandFromSuggestion: () => undefined,
        },
      });

      const { result } = await renderCommandCompletionHook(text, cursorOffset);

      await waitFor(() => {
        expect(result.current.suggestions.length).toBe(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      expect(result.current.textBuffer.text).toBe(
        '@src/file1.txt is a good file',
      );
    });

    it('should complete a directory path ending with / without a trailing space', async () => {
      setupMocks({
        atSuggestions: [{ label: 'src/components/', value: 'src/components/' }],
        slashCompletionRange: {
          completionStart: 0,
          completionEnd: 0,
          getCommandFromSuggestion: () => undefined,
        },
      });

      const { result } = await renderCommandCompletionHook('@src/comp');

      await waitFor(() => {
        expect(result.current.suggestions.length).toBe(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      expect(result.current.textBuffer.text).toBe('@src/components/');
    });

    it('should complete a directory path ending with \\ without a trailing space', async () => {
      setupMocks({
        atSuggestions: [
          { label: 'src\\components\\', value: 'src\\components\\' },
        ],
        slashCompletionRange: {
          completionStart: 0,
          completionEnd: 0,
          getCommandFromSuggestion: () => undefined,
        },
      });

      const { result } = await renderCommandCompletionHook('@src\\comp');

      await waitFor(() => {
        expect(result.current.suggestions.length).toBe(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      expect(result.current.textBuffer.text).toBe('@src\\components\\');
    });

    it('should ADD a space for AT completion even if name matches a command with an action', async () => {
      // Setup a mock where getCommandFromSuggestion WOULD return a command with an action
      // if it were in SLASH mode.
      setupMocks({
        atSuggestions: [{ label: 'memory', value: 'memory' }],
        slashCompletionRange: {
          completionStart: 0,
          completionEnd: 0,
          getCommandFromSuggestion: () =>
            ({ action: vi.fn() }) as unknown as SlashCommand,
        },
      });

      const { result } = await renderCommandCompletionHook('@mem');

      await waitFor(() => {
        expect(result.current.suggestions.length).toBe(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      // Should have a space because it's AT mode, not SLASH mode
      expect(result.current.textBuffer.text).toBe('@memory ');
    });

    it('should show ghost text for a single shell completion', async () => {
      const text = 'l';
      setupMocks({
        shellSuggestions: [{ label: 'ls', value: 'ls' }],
        shellCompletionRange: {
          completionStart: 0,
          completionEnd: 1,
          query: 'l',
          activeStart: 0,
        },
      });

      const { result } = await renderCommandCompletionHook(
        text,
        text.length,
        true, // shellModeActive
      );

      await waitFor(() => {
        expect(result.current.isLoadingSuggestions).toBe(false);
      });

      // Should show "ls " as ghost text (including trailing space)
      expect(result.current.promptCompletion.text).toBe('ls ');
    });

    it('should not offer an acceptable completion the renderer cannot draw', async () => {
      // Trailing text makes the rewritten line a non-prefix of the buffer, so
      // no ghost is drawn — a truthy `text` here would let Tab silently accept
      // something the user never saw.
      const text = 'l foo';
      setupMocks({
        shellSuggestions: [{ label: 'ls', value: 'ls' }],
        shellCompletionRange: {
          completionStart: 0,
          completionEnd: 1,
          query: 'l',
          activeStart: 0,
        },
      });

      const { result } = await renderCommandCompletionHook(
        text,
        1, // cursor sits right after the 'l'
        true, // shellModeActive
      );

      await waitFor(() => {
        expect(result.current.isLoadingSuggestions).toBe(false);
      });

      expect(result.current.promptCompletion.text).toBe('');
    });

    it('should not show ghost text if there are multiple completions', async () => {
      const text = 'l';
      setupMocks({
        shellSuggestions: [
          { label: 'ls', value: 'ls' },
          { label: 'ln', value: 'ln' },
        ],
        shellCompletionRange: {
          completionStart: 0,
          completionEnd: 1,
          query: 'l',
          activeStart: 0,
        },
      });

      const { result } = await renderCommandCompletionHook(
        text,
        text.length,
        true, // shellModeActive
      );

      await waitFor(() => {
        expect(result.current.isLoadingSuggestions).toBe(false);
      });

      expect(result.current.promptCompletion.text).toBe('');
    });

    it('should not show ghost text if the typed text extends past the completion', async () => {
      // "ls " is already typed.
      const text = 'ls ';
      const cursorOffset = text.length;

      const { result } = await renderCommandCompletionHook(
        text,
        cursorOffset,
        true, // shellModeActive
      );

      await waitFor(() => {
        expect(result.current.isLoadingSuggestions).toBe(false);
      });

      expect(result.current.promptCompletion.text).toBe('');
    });

    it('should clear ghost text after user types a space when exact match ghost text was showing', async () => {
      const textWithoutSpace = 'ls';

      setupMocks({
        shellSuggestions: [{ label: 'ls', value: 'ls' }],
        shellCompletionRange: {
          completionStart: 0,
          completionEnd: 2,
          query: 'ls',
          activeStart: 0,
        },
      });

      const { result } = await renderCommandCompletionHook(
        textWithoutSpace,
        textWithoutSpace.length,
        true, // shellModeActive
      );

      await waitFor(() => {
        expect(result.current.isLoadingSuggestions).toBe(false);
      });

      // Initially no ghost text because "ls" perfectly matches "ls"
      expect(result.current.promptCompletion.text).toBe('');

      // Now simulate typing a space.
      // In the real app, shellCompletionRange.completionStart would change immediately to 3,
      // but suggestions (and activeStart) would still be from the previous token for a few ms.
      setupMocks({
        shellSuggestions: [{ label: 'ls', value: 'ls' }], // Stale suggestions
        shellCompletionRange: {
          completionStart: 3, // New token position
          completionEnd: 3,
          query: '',
          activeStart: 0, // Stale active start
        },
      });

      act(() => {
        result.current.textBuffer.setText('ls ', 'end');
      });

      await waitFor(() => {
        expect(result.current.isLoadingSuggestions).toBe(false);
      });

      // Should STILL be empty because completionStart (3) !== activeStart (0)
      expect(result.current.promptCompletion.text).toBe('');
    });
  });

  describe('prompt completion filtering', () => {
    it('should not trigger prompt completion for line comments', async () => {
      const mockConfig = {
        getEnablePromptCompletion: () => true,
      } as unknown as Config;

      let hookResult: ReturnType<typeof useCommandCompletion> & {
        textBuffer: ReturnType<typeof useTextBuffer>;
      };

      function TestComponent() {
        const textBuffer = useTextBufferForTest('// This is a line comment');
        const completion = useCommandCompletion({
          buffer: textBuffer,
          cwd: testRootDir,
          slashCommands: [],
          commandContext: mockCommandContext,
          reverseSearchActive: false,
          shellModeActive: false,
          config: mockConfig,
          active: true,
        });
        hookResult = { ...completion, textBuffer };
        return null;
      }
      await renderWithProviders(<TestComponent />);

      // Should not trigger prompt completion for comments
      await waitFor(() => {
        expect(hookResult!.suggestions.length).toBe(0);
      });
    });

    it('should not trigger prompt completion for block comments', async () => {
      const mockConfig = {
        getEnablePromptCompletion: () => true,
      } as unknown as Config;

      let hookResult: ReturnType<typeof useCommandCompletion> & {
        textBuffer: ReturnType<typeof useTextBuffer>;
      };

      function TestComponent() {
        const textBuffer = useTextBufferForTest(
          '/* This is a block comment */',
        );
        const completion = useCommandCompletion({
          buffer: textBuffer,
          cwd: testRootDir,
          slashCommands: [],
          commandContext: mockCommandContext,
          reverseSearchActive: false,
          shellModeActive: false,
          config: mockConfig,
          active: true,
        });
        hookResult = { ...completion, textBuffer };
        return null;
      }
      await renderWithProviders(<TestComponent />);

      // Should not trigger prompt completion for comments
      await waitFor(() => {
        expect(hookResult!.suggestions.length).toBe(0);
      });
    });

    it('should trigger prompt completion for regular text when enabled', async () => {
      const mockConfig = {
        getEnablePromptCompletion: () => true,
      } as unknown as Config;

      let hookResult: ReturnType<typeof useCommandCompletion> & {
        textBuffer: ReturnType<typeof useTextBuffer>;
      };

      function TestComponent() {
        const textBuffer = useTextBufferForTest(
          'This is regular text that should trigger completion',
        );
        const completion = useCommandCompletion({
          buffer: textBuffer,
          cwd: testRootDir,
          slashCommands: [],
          commandContext: mockCommandContext,
          reverseSearchActive: false,
          shellModeActive: false,
          config: mockConfig,
          active: true,
        });
        hookResult = { ...completion, textBuffer };
        return null;
      }
      await renderWithProviders(<TestComponent />);

      // This test verifies that comments are filtered out while regular text is not
      await waitFor(() => {
        expect(hookResult!.textBuffer.text).toBe(
          'This is regular text that should trigger completion',
        );
      });
    });
  });

  describe('@ completion after slash commands (issue #14420)', () => {
    it('should show file suggestions when typing @path after a slash command', async () => {
      setupMocks({
        atSuggestions: [{ label: 'src/file.txt', value: 'src/file.txt' }],
      });

      const text = '/mycommand @src/fi';
      const cursorOffset = text.length;

      await renderCommandCompletionHook(text, cursorOffset);

      await waitFor(() => {
        expect(useAtCompletion).toHaveBeenLastCalledWith(
          expect.objectContaining({
            enabled: true,
            pattern: 'src/fi',
          }),
        );
      });
    });

    it('should show slash suggestions when cursor is on command part (no @)', async () => {
      setupMocks({
        slashSuggestions: [{ label: 'mycommand', value: 'mycommand' }],
      });

      const text = '/mycom';
      const cursorOffset = text.length;

      const { result } = await renderCommandCompletionHook(text, cursorOffset);

      await waitFor(() => {
        expect(result.current.suggestions).toHaveLength(1);
        expect(result.current.suggestions[0]?.label).toBe('mycommand');
      });
    });

    it('should switch to @ completion when typing @ after slash command', async () => {
      setupMocks({
        atSuggestions: [{ label: 'file.txt', value: 'file.txt' }],
      });

      const text = '/command @';
      const cursorOffset = text.length;

      await renderCommandCompletionHook(text, cursorOffset);

      await waitFor(() => {
        expect(useAtCompletion).toHaveBeenLastCalledWith(
          expect.objectContaining({
            enabled: true,
            pattern: '',
          }),
        );
      });
    });

    it('should handle multiple @ references in a slash command', async () => {
      setupMocks({
        atSuggestions: [{ label: 'src/bar.ts', value: 'src/bar.ts' }],
      });

      const text = '/diff @src/foo.ts @src/ba';
      const cursorOffset = text.length;

      await renderCommandCompletionHook(text, cursorOffset);

      await waitFor(() => {
        expect(useAtCompletion).toHaveBeenLastCalledWith(
          expect.objectContaining({
            enabled: true,
            pattern: 'src/ba',
          }),
        );
      });
    });

    it('should complete file path and add trailing space', async () => {
      setupMocks({
        atSuggestions: [{ label: 'src/file.txt', value: 'src/file.txt' }],
        slashCompletionRange: {
          completionStart: 0,
          completionEnd: 0,
          getCommandFromSuggestion: () => undefined,
        },
      });

      const { result } = await renderCommandCompletionHook('/cmd @src/fi');

      await waitFor(() => {
        expect(result.current.suggestions.length).toBe(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      expect(result.current.textBuffer.text).toBe('/cmd @src/file.txt ');
    });

    it('should stay in slash mode when slash command has trailing space but no @', async () => {
      setupMocks({
        slashSuggestions: [{ label: 'help', value: 'help' }],
      });

      const text = '/help ';
      await renderCommandCompletionHook(text);

      await waitFor(() => {
        expect(useSlashCompletion).toHaveBeenLastCalledWith(
          expect.objectContaining({
            enabled: true,
          }),
        );
      });
    });
  });
});

describe('useCommandCompletion — inline command ghost', () => {
  const mockCommandContext = {} as CommandContext;
  const ghostCommands = [
    { name: 'extract-approach', description: 'extract', kind: 'skill' },
    { name: 'exit', description: 'exit', kind: 'built-in' },
    // A line-start command that owns no argument list — the reported shape.
    { name: 'note', description: 'note', kind: 'skill' },
    // A line-start command whose arguments are supplied by the dropdown.
    {
      name: 'add-dir',
      description: 'add dir',
      kind: 'built-in',
      completion: () => [],
    },
    // Same-prefix siblings, the catalog shape from the bug report.
    { name: 'wcs-engine', description: 'engine', kind: 'skill' },
    { name: 'wcs-engine-mock', description: 'mock', kind: 'skill' },
  ] as unknown as SlashCommand[];

  let ghostResult: ReturnType<typeof useCommandCompletion> & {
    textBuffer: ReturnType<typeof useTextBuffer>;
  };

  function GhostTestComponent({
    initialText,
    cursorOffset,
    shellModeActive = false,
    commandSearchActive = false,
    active = true,
  }: {
    initialText: string;
    cursorOffset?: number;
    shellModeActive?: boolean;
    commandSearchActive?: boolean;
    active?: boolean;
  }) {
    const textBuffer = useTextBuffer({
      initialText,
      initialCursorOffset: cursorOffset ?? initialText.length,
      viewport: { width: 80, height: 20 },
      onChange: () => {},
    });
    const completion = useCommandCompletion({
      buffer: textBuffer,
      cwd: '/',
      slashCommands: ghostCommands,
      commandContext: mockCommandContext,
      reverseSearchActive: false,
      commandSearchActive,
      shellModeActive,
      active,
    });
    ghostResult = { ...completion, textBuffer };
    return null;
  }

  const renderGhost = async (
    initialText: string,
    options: {
      cursorOffset?: number;
      shellModeActive?: boolean;
      commandSearchActive?: boolean;
      active?: boolean;
    } = {},
  ) => {
    await renderWithProviders(
      <GhostTestComponent initialText={initialText} {...options} />,
    );
    return {
      get current() {
        return ghostResult;
      },
    };
  };

  /** The ghost suffix as InputPrompt derives it for rendering. */
  const ghostSuffix = (
    result: ReturnType<typeof useCommandCompletion> & {
      textBuffer: ReturnType<typeof useTextBuffer>;
    },
  ) => {
    const { text } = result.promptCompletion;
    const bufferText = result.textBuffer.text;
    if (!text || !bufferText || !text.startsWith(bufferText)) {
      return '';
    }
    return text.slice(bufferText.length);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers the remaining command name for a mid-input slash token', async () => {
    const result = await renderGhost('hello /extra');
    expect(ghostSuffix(result.current)).toBe('ct-approach');
  });

  it('leaves a line-start slash to the dropdown', async () => {
    const result = await renderGhost('/extra');
    expect(result.current.completionMode).toBe(CompletionMode.SLASH);
    expect(ghostSuffix(result.current)).toBe('');
  });

  it('offers a ghost for a second slash token on a command line', async () => {
    const result = await renderGhost('/note /extra');
    expect(result.current.completionMode).toBe(CompletionMode.SLASH);
    expect(ghostSuffix(result.current)).toBe('ct-approach');
  });

  it('accepts the second token without disturbing the first command', async () => {
    const result = await renderGhost('/note /extra');

    act(() => {
      result.current.promptCompletion.accept();
    });

    expect(result.current.textBuffer.text).toBe('/note /extract-approach ');
  });

  it.each([
    ['at the argument position', '/add-dir /extra'],
    ['at argument depth two', '/add-dir ~/proj /extra'],
  ])(
    'shows no ghost when the line-start command owns its arguments %s',
    async (_label, text) => {
      const result = await renderGhost(text);
      expect(result.current.completionMode).toBe(CompletionMode.SLASH);
      expect(ghostSuffix(result.current)).toBe('');
    },
  );

  it('shows no ghost while the dropdown still has rows on screen', async () => {
    // Suggestions land through effects, so last keystroke's rows outlive the
    // synchronous ghost by a render. The dropdown owns Tab in that window.
    setupMocks({
      slashSuggestions: [{ label: '/note copy', value: 'copy' }],
    });
    const result = await renderGhost('/note /extra');

    expect(result.current.showSuggestions).toBe(true);
    expect(ghostSuffix(result.current)).toBe('');
  });

  it('shows no ghost while the dropdown is still loading', async () => {
    setupMocks({ isLoading: true });
    const result = await renderGhost('/note /extra');

    expect(ghostSuffix(result.current)).toBe('');
  });

  it('accepts a shared prefix without a trailing space', async () => {
    // wcs-engine-mock still shares the prefix, so the token is not finished.
    const result = await renderGhost('hello /wcs-e');
    expect(ghostSuffix(result.current)).toBe('ngine');

    act(() => {
      result.current.promptCompletion.accept();
    });

    expect(result.current.textBuffer.text).toBe('hello /wcs-engine');
  });

  it('offers a ghost on a continuation line that starts with a slash', async () => {
    const result = await renderGhost('hello\n/extra');
    expect(ghostSuffix(result.current)).toBe('ct-approach');
  });

  it('accepts into the buffer with a trailing space and the cursor after it', async () => {
    const result = await renderGhost('hello /extra');

    act(() => {
      result.current.promptCompletion.accept();
    });

    expect(result.current.textBuffer.text).toBe('hello /extract-approach ');
    expect(result.current.textBuffer.cursor).toEqual([
      0,
      'hello /extract-approach '.length,
    ]);
  });

  it('accepts correctly when the token is on a later line', async () => {
    const result = await renderGhost('hi\nsee /extra');

    act(() => {
      result.current.promptCompletion.accept();
    });

    expect(result.current.textBuffer.text).toBe('hi\nsee /extract-approach ');
  });

  it('hides the ghost after clear() and restores it once the token changes', async () => {
    const result = await renderGhost('hello /extra');
    expect(ghostSuffix(result.current)).toBe('ct-approach');

    act(() => {
      result.current.promptCompletion.clear();
    });
    await waitFor(() => {
      expect(ghostSuffix(result.current)).toBe('');
    });

    act(() => {
      result.current.textBuffer.setText('hello /extrac');
    });
    await waitFor(() => {
      expect(ghostSuffix(result.current)).toBe('t-approach');
    });
  });

  it('restores the ghost when the dismissed token is deleted and retyped', async () => {
    const result = await renderGhost('hello /extra');

    act(() => {
      result.current.promptCompletion.clear();
    });
    act(() => {
      result.current.textBuffer.setText('hello /extr');
    });
    act(() => {
      result.current.textBuffer.setText('hello /extra');
    });

    await waitFor(() => {
      expect(ghostSuffix(result.current)).toBe('ct-approach');
    });
  });

  it.each([
    ['no prefix match', 'hello /zzz', {}],
    ['an already complete name', 'hello /exit', {}],
    ['a bare slash', 'hello / ', {}],
    ['a slash with no leading separator', 'src/extra', {}],
    ['shell mode', 'hello /extra', { shellModeActive: true }],
    ['command search', 'hello /extra', { commandSearchActive: true }],
    ['completion disabled', 'hello /extra', { active: false }],
  ])('shows no ghost for %s', async (_label, text, options) => {
    const result = await renderGhost(text, options);
    expect(ghostSuffix(result.current)).toBe('');
  });

  it('shows no ghost when the cursor is not at the end of the line', async () => {
    // Cursor sits between "extra" and " world".
    const result = await renderGhost('hello /extra world', {
      cursorOffset: 'hello /extra'.length,
    });
    expect(ghostSuffix(result.current)).toBe('');
  });

  it('shows no ghost while @ completion owns the input', async () => {
    const result = await renderGhost('hello /extra @src');
    expect(result.current.completionMode).toBe(CompletionMode.AT);
    expect(ghostSuffix(result.current)).toBe('');
  });

  it('never mutates the buffer before the ghost is accepted', async () => {
    const result = await renderGhost('hello /extra');
    expect(ghostSuffix(result.current)).toBe('ct-approach');
    expect(result.current.textBuffer.text).toBe('hello /extra');
  });
});
