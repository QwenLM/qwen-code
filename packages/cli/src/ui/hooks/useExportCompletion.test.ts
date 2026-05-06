/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandKind, type SlashCommand } from '../commands/types.js';
import type { TextBuffer } from '../components/shared/text-buffer.js';
import type { Key } from './useKeypress.js';
import type { UseCommandCompletionReturn } from './useCommandCompletion.js';
import {
  getExportFormatFromInput,
  getNextExportCompletionIndex,
  useExportCompletion,
} from './useExportCompletion.js';

const EXPORT_FORMATS = ['html', 'md', 'json', 'jsonl'] as const;

const exportSlashCommands: readonly SlashCommand[] = [
  {
    name: 'export',
    kind: CommandKind.BUILT_IN,
    description: 'Export conversation',
    subCommands: EXPORT_FORMATS.map((name) => ({
      name,
      kind: CommandKind.BUILT_IN,
      description: `Export ${name}`,
    })),
  },
];

function createTextBuffer(initialText: string): TextBuffer {
  let text = initialText;
  const buffer = {
    get text() {
      return text;
    },
    get lines() {
      return [text];
    },
    get cursor() {
      return [0, text.length] as [number, number];
    },
    setText: vi.fn((nextText: string) => {
      text = nextText;
    }),
  };

  return buffer as unknown as TextBuffer;
}

function createKey(name: string): Key {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    paste: false,
    sequence: '',
  };
}

function createCompletion(
  overrides: Partial<UseCommandCompletionReturn> = {},
): UseCommandCompletionReturn {
  return {
    suggestions: EXPORT_FORMATS.map((format) => ({
      label: format,
      value: format,
    })),
    activeSuggestionIndex: 0,
    visibleStartIndex: 0,
    showSuggestions: false,
    isLoadingSuggestions: false,
    isPerfectMatch: false,
    setActiveSuggestionIndex: vi.fn(),
    setShowSuggestions: vi.fn(),
    resetCompletionState: vi.fn(),
    navigateUp: vi.fn(),
    navigateDown: vi.fn(),
    handleAutocomplete: vi.fn(),
    midInputGhostText: null,
    ...overrides,
  };
}

describe('getExportFormatFromInput', () => {
  it.each([
    ['', null],
    ['/export', null],
    ['/export ', null],
    ['/export yaml', null],
    ['/export md extra', null],
    ['/help md', null],
    ['/export md', 'md'],
    ['  /export jsonl  ', 'jsonl'],
  ])('parses %j as %j', (input, expected) => {
    expect(getExportFormatFromInput(input, EXPORT_FORMATS)).toBe(expected);
  });

  it('returns null when there are no valid formats', () => {
    expect(getExportFormatFromInput('/export md', [])).toBeNull();
  });
});

describe('getNextExportCompletionIndex', () => {
  it('returns the current index for an empty format list', () => {
    expect(getNextExportCompletionIndex([], 3, 'down')).toBe(3);
  });

  it('wraps downward at the end of the list', () => {
    expect(getNextExportCompletionIndex(EXPORT_FORMATS, 3, 'down')).toBe(0);
  });

  it('wraps upward at the start of the list', () => {
    expect(getNextExportCompletionIndex(EXPORT_FORMATS, 0, 'up')).toBe(3);
  });

  it('moves from out-of-range indexes back into the cycle', () => {
    expect(getNextExportCompletionIndex(EXPORT_FORMATS, -1, 'down')).toBe(0);
    expect(getNextExportCompletionIndex(EXPORT_FORMATS, 99, 'down')).toBe(0);
    expect(getNextExportCompletionIndex(EXPORT_FORMATS, -1, 'up')).toBe(3);
  });

  it('keeps a single-item list on the only index', () => {
    expect(getNextExportCompletionIndex(['html'], 0, 'down')).toBe(0);
    expect(getNextExportCompletionIndex(['html'], 0, 'up')).toBe(0);
  });
});

describe('useExportCompletion', () => {
  it('returns null display props outside export cycling', () => {
    const buffer = createTextBuffer('/export');
    const { result } = renderHook(() =>
      useExportCompletion(buffer, exportSlashCommands),
    );

    expect(result.current.shouldShowSuggestions).toBe(false);
    expect(result.current.suggestionDisplayProps).toBeNull();
  });

  it('does not seed cycling state from buffer text alone', () => {
    const buffer = createTextBuffer('/export md');
    const completion = createCompletion();
    const { result } = renderHook(() =>
      useExportCompletion(buffer, exportSlashCommands),
    );

    let consumed = true;
    act(() => {
      consumed = result.current.handleExportInput(
        createKey('down'),
        completion,
      );
    });

    expect(consumed).toBe(false);
    expect(buffer.setText).not.toHaveBeenCalled();
  });

  it('seeds cycling state after a marked user text edit', () => {
    const buffer = createTextBuffer('');
    const completion = createCompletion();
    const { result, rerender } = renderHook(
      ({ textBuffer }) => useExportCompletion(textBuffer, exportSlashCommands),
      { initialProps: { textBuffer: buffer } },
    );

    act(() => {
      result.current.markNextTextChangeAsUserInput();
      buffer.setText('/export md');
    });
    rerender({ textBuffer: buffer });
    vi.mocked(buffer.setText).mockClear();

    let consumed = false;
    act(() => {
      consumed = result.current.handleExportInput(
        createKey('down'),
        completion,
      );
    });

    expect(consumed).toBe(true);
    expect(buffer.setText).toHaveBeenLastCalledWith('/export json');
  });

  it('clears refs and cycling state on reset', () => {
    const buffer = createTextBuffer('/export md');
    const completion = createCompletion();
    const { result } = renderHook(() =>
      useExportCompletion(buffer, exportSlashCommands),
    );

    act(() => {
      result.current.navigatedRef.current = true;
      result.current.navigatedTextRef.current = '/memory';
      result.current.reset();
    });

    expect(result.current.navigatedRef.current).toBe(false);
    expect(result.current.navigatedTextRef.current).toBe('');

    let consumed = true;
    act(() => {
      consumed = result.current.handleExportInput(
        createKey('down'),
        completion,
      );
    });

    expect(consumed).toBe(false);
    expect(buffer.setText).not.toHaveBeenCalled();
  });

  it('shows export suggestions after phase-1 cycling updates the buffer', () => {
    const buffer = createTextBuffer('/export');
    const completion = createCompletion({
      showSuggestions: true,
      isPerfectMatch: true,
    });
    const { result, rerender } = renderHook(
      ({ textBuffer }) => useExportCompletion(textBuffer, exportSlashCommands),
      { initialProps: { textBuffer: buffer } },
    );

    act(() => {
      result.current.handleExportInput(createKey('down'), completion);
    });
    rerender({ textBuffer: buffer });

    expect(result.current.shouldShowSuggestions).toBe(true);
    expect(result.current.suggestionDisplayProps).toMatchObject({
      activeIndex: 1,
      isLoading: false,
      scrollOffset: 0,
    });
    expect(
      result.current.suggestionDisplayProps?.suggestions.map((s) => s.value),
    ).toEqual(['html', 'md', 'json', 'jsonl']);
  });

  it('keeps the returned object stable when dependencies do not change', () => {
    const buffer = createTextBuffer('');
    const { result, rerender } = renderHook(
      ({ textBuffer }) => useExportCompletion(textBuffer, exportSlashCommands),
      { initialProps: { textBuffer: buffer } },
    );
    const firstResult = result.current;

    rerender({ textBuffer: buffer });

    expect(result.current).toBe(firstResult);
  });
});
