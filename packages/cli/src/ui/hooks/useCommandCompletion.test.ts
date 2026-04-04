/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCommandCompletion } from './useCommandCompletion.js';
import type { CommandContext } from '../commands/types.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import { useEffect } from 'react';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import type { UseAtCompletionProps } from './useAtCompletion.js';
import { useAtCompletion } from './useAtCompletion.js';
import type { UseSlashCompletionProps } from './useSlashCompletion.js';
import { useSlashCompletion } from './useSlashCompletion.js';
import { usePathCompletion } from './usePathCompletion.js';

vi.mock('./useAtCompletion', () => ({
  useAtCompletion: vi.fn(),
}));

vi.mock('./useSlashCompletion', () => ({
  useSlashCompletion: vi.fn(() => ({
    completionStart: 0,
    completionEnd: 0,
  })),
}));

vi.mock('./usePathCompletion', () => ({
  usePathCompletion: vi.fn(() => undefined),
}));

// Helper to set up mocks in a consistent way for both child hooks
const setupMocks = ({
  atSuggestions = [],
  slashSuggestions = [],
  isLoading = false,
  isPerfectMatch = false,
  slashCompletionRange = { completionStart: 0, completionEnd: 0 },
}: {
  atSuggestions?: Suggestion[];
  slashSuggestions?: Suggestion[];
  isLoading?: boolean;
  isPerfectMatch?: boolean;
  slashCompletionRange?: { completionStart: number; completionEnd: number };
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
      return slashCompletionRange;
    },
  );
};

describe('useCommandCompletion', () => {
  const mockCommandContext = {} as CommandContext;
  const mockConfig = {} as Config;
  const testDirs: string[] = [];
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
            testDirs,
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

      it('should reset state when completion mode becomes IDLE', async () => {
        setupMocks({
          atSuggestions: [{ label: 'src/file.txt', value: 'src/file.txt' }],
        });

        const { result } = renderHook(() => {
          const textBuffer = useTextBufferForTest('@file');
          const completion = useCommandCompletion(
            textBuffer,
            testDirs,
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
            testDirs,
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
            testDirs,
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

      it('should correctly identify the completion context with multiple @ symbols', async () => {
        const text = '@file1 @file2';
        const cursorOffset = 3; // @fi|le1 @file2

        renderHook(() =>
          useCommandCompletion(
            useTextBufferForTest(text, cursorOffset),
            testDirs,
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
            testDirs,
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
            testDirs,
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
            testDirs,
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
            testDirs,
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
            testDirs,
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
            testDirs,
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
          testDirs,
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
          testDirs,
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

    it('should complete a file path when @ appears after a slash command', async () => {
      setupMocks({
        atSuggestions: [{ label: 'src/index.ts', value: 'src/index.ts' }],
      });

      const text = '/review @src/ind';
      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest(text);
        const completion = useCommandCompletion(
          textBuffer,
          testDirs,
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
          testDirs,
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

    it('should complete a file path', async () => {
      setupMocks({
        atSuggestions: [{ label: 'src/file1.txt', value: 'src/file1.txt' }],
      });

      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest('@src/fi');
        const completion = useCommandCompletion(
          textBuffer,
          testDirs,
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
          testDirs,
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
  });

  describe('PATH mode completion', () => {
    it('completes a path without trailing space', async () => {
      // Mock usePathCompletion to actually provide suggestions
      vi.mocked(usePathCompletion).mockImplementation(
        ({
          enabled,
          setSuggestions,
          setIsLoadingSuggestions,
        }: {
          enabled: boolean;
          setSuggestions: (s: Suggestion[]) => void;
          setIsLoadingSuggestions: (l: boolean) => void;
        }) => {
          useEffect(() => {
            if (enabled) {
              setSuggestions([
                {
                  label: './src/',
                  value: './src/',
                  description: 'directory',
                },
              ]);
              setIsLoadingSuggestions(false);
            }
          }, [enabled, setSuggestions, setIsLoadingSuggestions]);
        },
      );

      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest('./sr');
        const completion = useCommandCompletion(
          textBuffer,
          testDirs,
          testRootDir,
          [],
          mockCommandContext,
          false,
          mockConfig,
        );
        return { ...completion, textBuffer };
      });

      await waitFor(() => {
        expect(result.current.suggestions).toHaveLength(1);
      });

      act(() => {
        result.current.handleAutocomplete(0);
      });

      // PATH mode should NOT add a trailing space (unlike AT/SLASH mode)
      expect(result.current.textBuffer.text).toBe('./src/');
    });

    it('enters PATH mode when typing a path-like token', () => {
      const { result } = renderHook(() =>
        useCommandCompletion(
          useTextBufferForTest('./src'),
          testDirs,
          testRootDir,
          [],
          mockCommandContext,
          false,
          mockConfig,
        ),
      );

      expect(result.current.showSuggestions).toBe(false);
    });

    it('enters PATH mode for absolute paths starting with /', () => {
      const mockSlashCommands = [
        { name: 'help', description: 'Show help', action: async () => {} },
      ];

      vi.mocked(usePathCompletion).mockClear();

      renderHook(() =>
        useCommandCompletion(
          useTextBufferForTest('/home'),
          testDirs,
          testRootDir,
          mockSlashCommands,
          mockCommandContext,
          false,
          mockConfig,
        ),
      );

      // /home doesn't match any slash command, falls through to PATH mode
      expect(vi.mocked(usePathCompletion)).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true, query: '/home' }),
      );
    });

    it('enters PATH mode for ~/ paths', () => {
      const { result } = renderHook(() =>
        useCommandCompletion(
          useTextBufferForTest('~/.config'),
          testDirs,
          testRootDir,
          [],
          mockCommandContext,
          false,
          mockConfig,
        ),
      );

      expect(result.current.showSuggestions).toBe(false);
    });

    it('enters PATH mode for ../ paths', () => {
      const { result } = renderHook(() =>
        useCommandCompletion(
          useTextBufferForTest('../lib'),
          testDirs,
          testRootDir,
          [],
          mockCommandContext,
          false,
          mockConfig,
        ),
      );

      expect(result.current.showSuggestions).toBe(false);
    });

    it('bare / stays in SLASH mode when commands are registered', () => {
      const mockSlashCommands = [
        { name: 'help', description: 'Show help', action: async () => {} },
      ];

      vi.mocked(usePathCompletion).mockClear();

      renderHook(() =>
        useCommandCompletion(
          useTextBufferForTest('/'),
          testDirs,
          testRootDir,
          mockSlashCommands,
          mockCommandContext,
          false,
          mockConfig,
        ),
      );

      // / alone should enter SLASH mode, so PATH completion must be disabled
      expect(vi.mocked(usePathCompletion)).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );
    });

    it('SLASH mode takes precedence over PATH for matching commands', () => {
      const mockSlashCommands = [
        { name: 'help', description: 'Show help', action: async () => {} },
      ];

      const { result } = renderHook(() =>
        useCommandCompletion(
          useTextBufferForTest('/h'),
          testDirs,
          testRootDir,
          mockSlashCommands,
          mockCommandContext,
          false,
          mockConfig,
        ),
      );

      // /h matches /help prefix, so SLASH mode (not PATH)
      expect(result.current.showSuggestions).toBe(false);
    });
  });
});
