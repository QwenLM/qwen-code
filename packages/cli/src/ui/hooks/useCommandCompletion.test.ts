/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCommandCompletion } from './useCommandCompletion.js';
import type { CommandContext, SlashCommand } from '../commands/types.js';
import { CommandKind } from '../commands/types.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import { useEffect } from 'react';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import type { UseAtCompletionProps } from './useAtCompletion.js';
import { useAtCompletion } from './useAtCompletion.js';
import type { UseSlashCompletionProps } from './useSlashCompletion.js';
import { useSlashCompletion } from './useSlashCompletion.js';

vi.mock('./useAtCompletion', () => ({
  useAtCompletion: vi.fn(),
}));

vi.mock('./useSlashCompletion', () => ({
  useSlashCompletion: vi.fn(() => ({
    completionStart: 0,
    completionEnd: 0,
    isPerfectMatch: false,
  })),
}));

// Helper to set up mocks in a consistent way for both child hooks
const setupMocks = ({
  atSuggestions = [],
  slashSuggestions = [],
  isLoading = false,
  isPerfectMatch = false,
  slashCompletionRange = {
    completionStart: 0,
    completionEnd: 0,
    isPerfectMatch,
  },
}: {
  atSuggestions?: Suggestion[];
  slashSuggestions?: Suggestion[];
  isLoading?: boolean;
  isPerfectMatch?: boolean;
  slashCompletionRange?: {
    completionStart: number;
    completionEnd: number;
    isPerfectMatch?: boolean;
  };
}) => {
  // Mock for @-completions
  (useAtCompletion as vi.Mock).mockImplementation(
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
  (useSlashCompletion as vi.Mock).mockImplementation(
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
      return {
        ...slashCompletionRange,
        isPerfectMatch: slashCompletionRange.isPerfectMatch ?? isPerfectMatch,
      };
    },
  );
};

describe('useCommandCompletion', () => {
  const mockCommandContext = {} as CommandContext;
  const mockConfig = {} as Config;
  const testRootDir = '/';

  // Helper to create real TextBuffer objects within renderHook
  function useTextBufferForTest(text: string, cursorOffset?: number) {
    return useTextBuffer({
      initialText: text,
      initialCursorOffset: cursorOffset ?? text.length,
      viewport: { width: 80, height: 20 },
      isValidPath: () => false,
      onChange: () => {},
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default mocks before each test
    setupMocks({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Core Hook Behavior', () => {
    describe('State Management', () => {
      it('should initialize with default state', () => {
        const { result } = renderHook(() =>
          useCommandCompletion(
            useTextBufferForTest(''),
            testRootDir,
            [],
            mockCommandContext,
            false,
            mockConfig,
          ),
        );

        expect(result.current.suggestions).toEqual([]);
        expect(result.current.activeSuggestionIndex).toBe(-1);
        expect(result.current.visibleStartIndex).toBe(0);
        expect(result.current.showSuggestions).toBe(false);
        expect(result.current.isLoadingSuggestions).toBe(false);
      });

      it('uses the current slash perfect match before published state catches up', () => {
        setupMocks({
          isPerfectMatch: false,
          slashCompletionRange: {
            completionStart: 1,
            completionEnd: 5,
            isPerfectMatch: true,
          },
        });

        const { result } = renderHook(() =>
          useCommandCompletion(
            useTextBufferForTest('/quit'),
            testRootDir,
            [],
            mockCommandContext,
            false,
            mockConfig,
          ),
        );

        expect(result.current.isPerfectMatch).toBe(true);
      });

      it('should reset state when completion mode becomes IDLE', async () => {
        setupMocks({
          atSuggestions: [{ label: 'src/file.txt', value: 'src/file.txt' }],
        });

        const { result } = renderHook(() => {
          const textBuffer = useTextBufferForTest('@file');
          const completion = useCommandCompletion(
            textBuffer,
            testRootDir,
            [],
            mockCommandContext,
            false,
            mockConfig,
          );
          return { completion, textBuffer };
        });

        await waitFor(() => {
          expect(result.current.completion.suggestions).toHaveLength(1);
        });

        expect(result.current.completion.showSuggestions).toBe(true);

        act(() => {
          result.current.textBuffer.replaceRangeByOffset(
            0,
            5,
            'just some text',
          );
        });

        await waitFor(() => {
          expect(result.current.completion.showSuggestions).toBe(false);
        });
      });

      it('should reset all state to default values', () => {
        const { result } = renderHook(() =>
          useCommandCompletion(
            useTextBufferForTest('@files'),
            testRootDir,
            [],
            mockCommandContext,
            false,
            mockConfig,
          ),
        );

        act(() => {
          result.current.setActiveSuggestionIndex(5);
          result.current.setShowSuggestions(true);
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
        renderHook(() =>
          useCommandCompletion(
            useTextBufferForTest(text),
            testRootDir,
            [],
            mockCommandContext,
            false,
            mockConfig,
          ),
        );

        await waitFor(() => {
          expect(useAtCompletion).toHaveBeenLastCalledWith(
            expect.objectContaining({
              enabled: true,
              pattern: 'src/a\\ file.txt',
            }),
          );
        });
      });

      it('should not trigger AT completion when @ is not preceded by whitespace', async () => {
        const text = 'cici@192.168.0.160';
        renderHook(() =>
          useCommandCompletion(
            useTextBufferForTest(text),
            testRootDir,
            [],
            mockCommandContext,
            false,
            mockConfig,
          ),
        );

        await waitFor(() => {
          expect(useAtCompletion).toHaveBeenLastCalledWith(
            expect.objectContaining({
              enabled: false,
            }),
          );
        });
      });

      it('should not trigger AT completion for email-like patterns', async () => {
        const text = 'user@example.com';
        renderHook(() =>
          useCommandCompletion(
            useTextBufferForTest(text),
            testRootDir,
            [],
            mockCommandContext,
            false,
            mockConfig,
          ),
        );

        await waitFor(() => {
          expect(useAtCompletion).toHaveBeenLastCalledWith(
            expect.objectContaining({
              enabled: false,
            }),
          );
        });
      });

      it('should correctly identify the completion context with multiple @ symbols', async () => {
        const text = '@file1 @file2';
        const cursorOffset = 3; // @fi|le1 @file2

        renderHook(() =>
          useCommandCompletion(
            useTextBufferForTest(text, cursorOffset),
            testRootDir,
            [],
            mockCommandContext,
            false,
            mockConfig,
          ),
        );

        await waitFor(() => {
          expect(useAtCompletion).toHaveBeenLastCalledWith(
            expect.objectContaining({
              enabled: true,
              pattern: 'file1',
            }),
          );
        });
      });
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

      it('should handle navigateUp with no suggestions', () => {
        setupMocks({ slashSuggestions: [] });

        const { result } = renderHook(() =>
          useCommandCompletion(
            useTextBufferForTest('/'),
            testRootDir,
            [],
            mockCommandContext,
            false,
            mockConfig,
          ),
        );

        act(() => {
          result.current.navigateUp();
        });

        expect(result.current.activeSuggestionIndex).toBe(-1);
      });

      it('should handle navigateDown with no suggestions', () => {
        setupMocks({ slashSuggestions: [] });
        const { result } = renderHook(() =>
          useCommandCompletion(
            useTextBufferForTest('/'),
            testRootDir,
            [],
            mockCommandContext,
            false,
            mockConfig,
          ),
        );

        act(() => {
          result.current.navigateDown();
        });

        expect(result.current.activeSuggestionIndex).toBe(-1);
      });

      it('should navigate up through suggestions with wrap-around', async () => {
        const { result } = renderHook(() =>
          useCommandCompletion(
            useTextBufferForTest('/'),
            testRootDir,
            [],
            mockCommandContext,
            false,
            mockConfig,
          ),
        );

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
        const { result } = renderHook(() =>
          useCommandCompletion(
            useTextBufferForTest('/'),
            testRootDir,
            [],
            mockCommandContext,
            false,
            mockConfig,
          ),
        );

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
        const { result } = renderHook(() =>
          useCommandCompletion(
            useTextBufferForTest('/'),
            testRootDir,
            [],
            mockCommandContext,
            false,
            mockConfig,
          ),
        );

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

        const { result } = renderHook(() =>
          useCommandCompletion(
            useTextBufferForTest('/'),
            testRootDir,
            [],
            mockCommandContext,
            false,
            mockConfig,
          ),
        );

        await waitFor(() => {
          expect(result.current.suggestions.length).toBe(
            mockSuggestions.length,
          );
          expect(result.current.activeSuggestionIndex).toBe(0);
        });
      });
    });
  });

  describe('Completion mode detection', () => {
    it('should switch to AT mode when typing @ after a slash command (#2518)', async () => {
      setupMocks({
        atSuggestions: [{ label: 'src/file.txt', value: 'src/file.txt' }],
      });

      const text = '/qc:create-issue @file';
      renderHook(() =>
        useCommandCompletion(
          useTextBufferForTest(text),
          testRootDir,
          [],
          mockCommandContext,
          false,
          mockConfig,
        ),
      );

      await waitFor(() => {
        expect(useAtCompletion).toHaveBeenLastCalledWith(
          expect.objectContaining({
            enabled: true,
            pattern: 'file',
          }),
        );
      });
    });

    it('should remain in SLASH mode when no @ is typed after slash command', async () => {
      setupMocks({
        slashSuggestions: [{ label: 'help', value: 'help' }],
      });

      const text = '/help';
      renderHook(() =>
        useCommandCompletion(
          useTextBufferForTest(text),
          testRootDir,
          [],
          mockCommandContext,
          false,
          mockConfig,
        ),
      );

      await waitFor(() => {
        expect(useSlashCompletion).toHaveBeenLastCalledWith(
          expect.objectContaining({
            enabled: true,
            query: '/help',
          }),
        );
      });
    });

    it('should use slash completion for mid-input model-invocable commands', async () => {
      const skillCommand: SlashCommand = {
        name: 'front-end-store-rules',
        description: 'Store rules',
        kind: CommandKind.SKILL,
        modelInvocable: true,
      };
      const builtInCommand: SlashCommand = {
        name: 'clear',
        description: 'Clear conversation',
        kind: CommandKind.BUILT_IN,
        modelInvocable: false,
      };
      const fileCommand: SlashCommand = {
        name: 'store-notes',
        description: 'Store notes',
        kind: CommandKind.FILE,
        modelInvocable: true,
      };

      setupMocks({
        slashSuggestions: [
          { label: 'front-end-store-rules', value: 'front-end-store-rules' },
        ],
      });

      const { result } = renderHook(() =>
        useCommandCompletion(
          useTextBufferForTest('please /store'),
          testRootDir,
          [skillCommand, builtInCommand, fileCommand],
          mockCommandContext,
          false,
          mockConfig,
        ),
      );

      await waitFor(() => {
        expect(result.current.showSuggestions).toBe(true);
      });

      expect(useSlashCompletion).toHaveBeenLastCalledWith(
        expect.objectContaining({
          enabled: true,
          query: '/store',
          slashCommands: [skillCommand, fileCommand],
        }),
      );
    });

    it.each([
      {
        input: '/review /sto',
        expected: '/review /front-end-store-rules ',
      },
      {
        input: '/review\n/sto',
        expected: '/review\n/front-end-store-rules ',
      },
    ])(
      'should complete a repeated skill in $input',
      async ({ input, expected }) => {
        const firstSkill: SlashCommand = {
          name: 'review',
          description: 'Review changes',
          kind: CommandKind.SKILL,
          modelInvocable: true,
        };
        const secondSkill: SlashCommand = {
          name: 'front-end-store-rules',
          description: 'Store rules',
          kind: CommandKind.SKILL,
          modelInvocable: true,
        };
        const userOnlySkill: SlashCommand = {
          name: 'store-locally',
          description: 'Store locally',
          kind: CommandKind.SKILL,
          modelInvocable: false,
        };
        const fileCommand: SlashCommand = {
          name: 'store-notes',
          description: 'Store notes',
          kind: CommandKind.FILE,
          modelInvocable: true,
        };

        setupMocks({
          slashSuggestions: [
            { label: 'front-end-store-rules', value: 'front-end-store-rules' },
          ],
          slashCompletionRange: { completionStart: 1, completionEnd: 4 },
        });

        const { result } = renderHook(() => {
          const textBuffer = useTextBufferForTest(input);
          const completion = useCommandCompletion(
            textBuffer,
            testRootDir,
            [firstSkill, secondSkill, userOnlySkill, fileCommand],
            mockCommandContext,
            false,
            mockConfig,
          );
          return { ...completion, textBuffer };
        });

        await waitFor(() => {
          expect(result.current.showSuggestions).toBe(true);
        });

        expect(useSlashCompletion).toHaveBeenLastCalledWith(
          expect.objectContaining({
            enabled: true,
            query: '/sto',
            slashCommands: [firstSkill, secondSkill, userOnlySkill],
          }),
        );

        act(() => {
          result.current.handleAutocomplete(0);
        });

        expect(result.current.textBuffer.text).toBe(expected);
      },
    );

    it('should exclude hidden and non-user-invocable skills from stacked skill completion candidates', async () => {
      const firstSkill: SlashCommand = {
        name: 'review',
        description: 'Review changes',
        kind: CommandKind.SKILL,
        modelInvocable: true,
      };
      const visibleSkill: SlashCommand = {
        name: 'store-locally',
        description: 'Store locally',
        kind: CommandKind.SKILL,
        modelInvocable: false,
      };
      const hiddenSkill: SlashCommand = {
        name: 'store-secret',
        description: 'Hidden store skill',
        kind: CommandKind.SKILL,
        modelInvocable: false,
        hidden: true,
      };
      const nonUserInvocableSkill: SlashCommand = {
        name: 'store-internal',
        description: 'Internal store skill',
        kind: CommandKind.SKILL,
        modelInvocable: false,
        userInvocable: false,
      };
      const fileCommand: SlashCommand = {
        name: 'store-notes',
        description: 'Store notes',
        kind: CommandKind.FILE,
        modelInvocable: true,
      };

      renderHook(() =>
        useCommandCompletion(
          useTextBufferForTest('/review /sto'),
          testRootDir,
          [
            firstSkill,
            visibleSkill,
            hiddenSkill,
            nonUserInvocableSkill,
            fileCommand,
          ],
          mockCommandContext,
          false,
          mockConfig,
        ),
      );

      await waitFor(() => {
        expect(useSlashCompletion).toHaveBeenLastCalledWith(
          expect.objectContaining({
            enabled: true,
            query: '/sto',
            slashCommands: [firstSkill, visibleSkill],
          }),
        );
      });
    });

    it.each(['/stats /sto', '/unknown /sto', '/unknown\n/sto'])(
      'should not treat an invalid stacked prefix as mid-input completion: %s',
      async (input) => {
        const skillCommand: SlashCommand = {
          name: 'store-rules',
          description: 'Store rules',
          kind: CommandKind.SKILL,
          modelInvocable: true,
        };
        const builtInCommand: SlashCommand = {
          name: 'stats',
          description: 'Show stats',
          kind: CommandKind.BUILT_IN,
          modelInvocable: false,
        };

        const { result } = renderHook(() =>
          useCommandCompletion(
            useTextBufferForTest(input),
            testRootDir,
            [skillCommand, builtInCommand],
            mockCommandContext,
            false,
            mockConfig,
          ),
        );

        expect(result.current.midInputGhostText).toBeNull();

        await waitFor(() => {
          if (input.includes('\n')) {
            expect(useSlashCompletion).toHaveBeenLastCalledWith(
              expect.objectContaining({ enabled: false }),
            );
          } else {
            expect(useSlashCompletion).toHaveBeenLastCalledWith(
              expect.objectContaining({
                enabled: true,
                query: input,
                slashCommands: [skillCommand, builtInCommand],
              }),
            );
          }
        });
      },
    );

    it.each(['/tmp/foo.txt please /sto', '// note /sto'])(
      'should treat non-command slash-led prefixes as regular mid-input completion: %s',
      async (input) => {
        const skillCommand: SlashCommand = {
          name: 'store-rules',
          description: 'Store rules',
          kind: CommandKind.SKILL,
          modelInvocable: true,
        };

        setupMocks({
          slashSuggestions: [{ label: 'store-rules', value: 'store-rules' }],
        });

        const { result } = renderHook(() =>
          useCommandCompletion(
            useTextBufferForTest(input),
            testRootDir,
            [skillCommand],
            mockCommandContext,
            false,
            mockConfig,
          ),
        );

        await waitFor(() => {
          expect(result.current.showSuggestions).toBe(true);
        });

        expect(useSlashCompletion).toHaveBeenLastCalledWith(
          expect.objectContaining({
            enabled: true,
            query: '/sto',
            slashCommands: [skillCommand],
          }),
        );
      },
    );

    it('should keep an indented first command in line-start completion', async () => {
      const skillCommand: SlashCommand = {
        name: 'front-end-store-rules',
        description: 'Store rules',
        kind: CommandKind.SKILL,
        modelInvocable: true,
      };
      const builtInCommand: SlashCommand = {
        name: 'stats',
        description: 'Show stats',
        kind: CommandKind.BUILT_IN,
        modelInvocable: false,
      };

      renderHook(() =>
        useCommandCompletion(
          useTextBufferForTest('  /sto'),
          testRootDir,
          [skillCommand, builtInCommand],
          mockCommandContext,
          false,
          mockConfig,
        ),
      );

      await waitFor(() => {
        // This pins routing to the existing line-start path. The real slash
        // completion may still decide whether an indented query has candidates.
        expect(useSlashCompletion).toHaveBeenLastCalledWith(
          expect.objectContaining({
            enabled: true,
            query: '  /sto',
            slashCommands: [skillCommand, builtInCommand],
          }),
        );
      });
    });

    it('should complete a file path when @ appears after a slash command', async () => {
      setupMocks({
        atSuggestions: [{ label: 'src/index.ts', value: 'src/index.ts' }],
      });

      const text = '/review @src/ind';
      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest(text);
        const completion = useCommandCompletion(
          textBuffer,
          testRootDir,
          [],
          mockCommandContext,
          false,
          mockConfig,
        );
        return { ...completion, textBuffer };
      });

      await waitFor(() => {
        expect(result.current.suggestions.length).toBe(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      expect(result.current.textBuffer.text).toBe('/review @src/index.ts ');
    });
  });

  describe('handleAutocomplete', () => {
    it('should complete a partial command', async () => {
      setupMocks({
        slashSuggestions: [{ label: 'memory', value: 'memory' }],
        slashCompletionRange: { completionStart: 1, completionEnd: 4 },
      });

      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest('/mem');
        const completion = useCommandCompletion(
          textBuffer,
          testRootDir,
          [],
          mockCommandContext,
          false,
          mockConfig,
        );
        return { ...completion, textBuffer };
      });

      await waitFor(() => {
        expect(result.current.suggestions.length).toBe(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      expect(result.current.textBuffer.text).toBe('/memory ');
    });

    it('should complete the mid-input slash token at the cursor', async () => {
      setupMocks({
        slashSuggestions: [
          { label: 'front-end-store-rules', value: 'front-end-store-rules' },
        ],
        slashCompletionRange: { completionStart: 1, completionEnd: 4 },
      });

      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest('please /review /sto');
        const completion = useCommandCompletion(
          textBuffer,
          testRootDir,
          [
            {
              name: 'front-end-store-rules',
              description: 'Store rules',
              kind: CommandKind.SKILL,
              modelInvocable: true,
            },
          ],
          mockCommandContext,
          false,
          mockConfig,
        );
        return { ...completion, textBuffer };
      });

      await waitFor(() => {
        expect(result.current.suggestions.length).toBe(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      expect(result.current.textBuffer.text).toBe(
        'please /review /front-end-store-rules ',
      );
    });

    it('should complete a bare mid-input slash without inserting a space', async () => {
      setupMocks({
        slashSuggestions: [{ label: 'review', value: 'review' }],
        slashCompletionRange: { completionStart: 1, completionEnd: 1 },
      });

      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest('please /');
        const completion = useCommandCompletion(
          textBuffer,
          testRootDir,
          [
            {
              name: 'review',
              description: 'Review PR',
              kind: CommandKind.BUILT_IN,
              modelInvocable: true,
            },
          ],
          mockCommandContext,
          false,
          mockConfig,
        );
        return { ...completion, textBuffer };
      });

      await waitFor(() => {
        expect(result.current.suggestions.length).toBe(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      expect(result.current.textBuffer.text).toBe('please /review ');
    });

    it('should complete a file path', async () => {
      setupMocks({
        atSuggestions: [{ label: 'src/file1.txt', value: 'src/file1.txt' }],
      });

      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest('@src/fi');
        const completion = useCommandCompletion(
          textBuffer,
          testRootDir,
          [],
          mockCommandContext,
          false,
          mockConfig,
        );
        return { ...completion, textBuffer };
      });

      await waitFor(() => {
        expect(result.current.suggestions.length).toBe(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      expect(result.current.textBuffer.text).toBe('@src/file1.txt ');
    });

    it('should not append trailing space for directory completions', async () => {
      setupMocks({
        atSuggestions: [
          {
            label: 'src/components/',
            value: 'src/components/',
            isDirectory: true,
          },
        ],
      });

      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest('@src/com');
        const completion = useCommandCompletion(
          textBuffer,
          testRootDir,
          [],
          mockCommandContext,
          false,
          mockConfig,
        );
        return { ...completion, textBuffer };
      });

      await waitFor(() => {
        expect(result.current.suggestions.length).toBe(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      expect(result.current.textBuffer.text).toBe('@src/components/');
    });

    it('should complete a file path when cursor is not at the end of the line', async () => {
      const text = '@src/fi is a good file';
      const cursorOffset = 7; // after "i"

      setupMocks({
        atSuggestions: [{ label: 'src/file1.txt', value: 'src/file1.txt' }],
      });

      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest(text, cursorOffset);
        const completion = useCommandCompletion(
          textBuffer,
          testRootDir,
          [],
          mockCommandContext,
          false,
          mockConfig,
        );
        return { ...completion, textBuffer };
      });

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

    it('should preserve existing space after directory completions at mid-line cursor', async () => {
      const text = '@src/com is a dir';
      const cursorOffset = 8; // after "m"

      setupMocks({
        atSuggestions: [
          {
            label: 'src/components/',
            value: 'src/components/',
            isDirectory: true,
          },
        ],
      });

      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest(text, cursorOffset);
        const completion = useCommandCompletion(
          textBuffer,
          testRootDir,
          [],
          mockCommandContext,
          false,
          mockConfig,
        );
        return { ...completion, textBuffer };
      });

      await waitFor(() => {
        expect(result.current.suggestions.length).toBe(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      expect(result.current.textBuffer.text).toBe('@src/components/ is a dir');
    });
  });

  describe('argument hint ghost text', () => {
    it('shows argumentHint as inline ghost text for a complete slash command', () => {
      const slashCommands: SlashCommand[] = [
        {
          name: 'fix-issue',
          description: 'Fix GitHub issue',
          argumentHint: '[issue-number]',
          kind: CommandKind.FILE,
        },
      ];

      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest('/fix-issue');
        const completion = useCommandCompletion(
          textBuffer,
          testRootDir,
          slashCommands,
          mockCommandContext,
          false,
          mockConfig,
        );
        return completion;
      });

      expect(result.current.midInputGhostText).toEqual({
        text: '[issue-number]',
        insertPosition: '/fix-issue'.length,
        showCursorBeforeText: true,
      });
    });

    it('does not show ghost text while dropdown handles partial mid-input commands', () => {
      const slashCommands: SlashCommand[] = [
        {
          name: 'review',
          description: 'Review changed code',
          kind: CommandKind.SKILL,
          modelInvocable: true,
        },
        {
          name: 'rewind',
          description: 'Rewind conversation',
          kind: CommandKind.BUILT_IN,
          modelInvocable: false,
        },
      ];

      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest('please /rev');
        const completion = useCommandCompletion(
          textBuffer,
          testRootDir,
          slashCommands,
          mockCommandContext,
          false,
          mockConfig,
        );
        return completion;
      });

      expect(result.current.midInputGhostText).toBeNull();
    });

    it('shows argumentHint for a complete mid-input model-invocable command', () => {
      const slashCommands: SlashCommand[] = [
        {
          name: 'review',
          description: 'Review changed code',
          kind: CommandKind.SKILL,
          modelInvocable: true,
          argumentHint: '[pr-number]',
        },
      ];

      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest('please /review');
        const completion = useCommandCompletion(
          textBuffer,
          testRootDir,
          slashCommands,
          mockCommandContext,
          false,
          mockConfig,
        );
        return completion;
      });

      expect(result.current.midInputGhostText).toEqual({
        text: '[pr-number]',
        insertPosition: 'please /review'.length,
        acceptText: undefined,
        showCursorBeforeText: true,
      });
    });

    it('does not show argumentHint after arguments have started', () => {
      const slashCommands: SlashCommand[] = [
        {
          name: 'fix-issue',
          description: 'Fix GitHub issue',
          argumentHint: '[issue-number]',
          kind: CommandKind.FILE,
        },
      ];

      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest('/fix-issue 123');
        const completion = useCommandCompletion(
          textBuffer,
          testRootDir,
          slashCommands,
          mockCommandContext,
          false,
          mockConfig,
        );
        return completion;
      });

      expect(result.current.midInputGhostText).toBeNull();
    });

    it('returns null midInputGhostText when only non-modelInvocable commands match', () => {
      const slashCommands: SlashCommand[] = [
        {
          name: 'clear',
          description: 'Clear conversation',
          kind: CommandKind.BUILT_IN,
          modelInvocable: false,
        },
        {
          name: 'compress',
          description: 'Compress context',
          kind: CommandKind.BUILT_IN,
          modelInvocable: false,
        },
      ];

      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest('please /cl');
        const completion = useCommandCompletion(
          textBuffer,
          testRootDir,
          slashCommands,
          mockCommandContext,
          false,
          mockConfig,
        );
        return completion;
      });

      // '/cl' matches 'clear' but it is not modelInvocable, so no ghost text
      expect(result.current.midInputGhostText).toBeNull();
    });
  });
});
