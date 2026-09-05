/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

// Regression tests for #9494: while a response streams, AppContainer state
// (session stats, pending item) changes identity, which rebuilds
// `commandContext`. That churn must NOT rebuild the slash suggestion list —
// rebuilding replaces the suggestions array, and the reset effect in
// useCommandCompletion then snaps the user's menu selection back to the
// first item.

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCommandCompletion } from './useCommandCompletion.js';
import type { CommandContext, SlashCommand } from '../commands/types.js';
import { CommandKind } from '../commands/types.js';
import { useTextBuffer } from '../components/shared/text-buffer.js';

vi.mock('./useAtCompletion', () => ({
  useAtCompletion: vi.fn(),
}));

function createTestCommand(command: Partial<SlashCommand>): SlashCommand {
  return {
    kind: CommandKind.BUILT_IN,
    name: 'test',
    description: 'test command',
    ...command,
  } as SlashCommand;
}

const defaultCommands: readonly SlashCommand[] = [
  createTestCommand({ name: 'memory', description: 'Manage memory' }),
  createTestCommand({ name: 'model', description: 'Switch the model' }),
  createTestCommand({ name: 'stats', description: 'Show session stats' }),
];

function makeContext(marker: string): CommandContext {
  return { services: { marker } } as unknown as CommandContext;
}

interface HarnessProps {
  ctx: CommandContext;
  commands?: readonly SlashCommand[];
}

function useHarness({ ctx, commands }: HarnessProps) {
  const buffer = useTextBuffer({
    initialText: '/',
    initialCursorOffset: 1,
    viewport: { width: 80, height: 20 },
    isValidPath: () => false,
    onChange: () => {},
  });
  const completion = useCommandCompletion(
    buffer,
    '/',
    commands ?? defaultCommands,
    ctx,
    false,
  );
  return { completion, buffer };
}

// Wait long enough for the async fuzzy-search pipeline (AsyncFzf) triggered
// by a dep change to settle.
async function flushCompletionPipeline() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

type HarnessResult = ReturnType<typeof useHarness>;

describe('slash completion during commandContext churn (#9494)', () => {
  it('keeps the suggestions array stable when only commandContext identity changes', async () => {
    const { result, rerender } = renderHook<HarnessResult, HarnessProps>(
      useHarness,
      {
        initialProps: { ctx: makeContext('A') },
      },
    );

    await waitFor(() => {
      expect(result.current.completion.suggestions.length).toBeGreaterThan(1);
    });

    const before = result.current.completion.suggestions;

    // Simulate streaming churn: the query is untouched, but the context
    // object is rebuilt (session stats / pending item changed upstream).
    rerender({ ctx: makeContext('B') });
    await flushCompletionPipeline();

    expect(result.current.completion.suggestions).toBe(before);
  });

  it('preserves the user menu selection across commandContext rebuilds', async () => {
    const { result, rerender } = renderHook<HarnessResult, HarnessProps>(
      useHarness,
      {
        initialProps: { ctx: makeContext('A') },
      },
    );

    await waitFor(() => {
      expect(result.current.completion.suggestions.length).toBeGreaterThan(1);
    });

    act(() => {
      result.current.completion.navigateDown();
    });
    expect(result.current.completion.activeSuggestionIndex).toBe(1);

    rerender({ ctx: makeContext('B') });
    await flushCompletionPipeline();

    expect(result.current.completion.activeSuggestionIndex).toBe(1);
  });

  it('still resets the selection when the query actually changes', async () => {
    const { result } = renderHook<HarnessResult, HarnessProps>(useHarness, {
      initialProps: { ctx: makeContext('A') },
    });

    await waitFor(() => {
      expect(result.current.completion.suggestions.length).toBeGreaterThan(1);
    });

    act(() => {
      result.current.completion.navigateDown();
    });
    expect(result.current.completion.activeSuggestionIndex).toBe(1);

    act(() => {
      result.current.buffer.setText('/s');
    });
    // "/s" only matches the 'stats' command — wait for the rebuilt list.
    await waitFor(() => {
      expect(result.current.completion.suggestions.length).toBe(1);
    });

    expect(result.current.completion.activeSuggestionIndex).toBe(0);
  });

  it('still rebuilds suggestions when the command list changes', async () => {
    const { result, rerender } = renderHook<HarnessResult, HarnessProps>(
      useHarness,
      {
        initialProps: { ctx: makeContext('A') },
      },
    );

    await waitFor(() => {
      expect(result.current.completion.suggestions.length).toBeGreaterThan(1);
    });
    const before = result.current.completion.suggestions;

    rerender({
      ctx: makeContext('A'),
      commands: [
        createTestCommand({ name: 'memory', description: 'Manage memory' }),
      ],
    });
    await waitFor(() => {
      expect(result.current.completion.suggestions).not.toBe(before);
    });
    expect(result.current.completion.suggestions.length).toBe(1);
  });

  it('argument completion still receives the latest commandContext', async () => {
    const completionSpy = vi
      .fn<(context: CommandContext, argString: string) => Promise<string[]>>()
      .mockResolvedValue(['arg-a', 'arg-b']);
    const markerOf = (callIndex: number): string =>
      (
        completionSpy.mock.calls[callIndex]![0] as unknown as {
          services: { marker: string };
        }
      ).services.marker;
    const commands = [
      createTestCommand({
        name: 'deploy',
        description: 'Deploy things',
        completion: completionSpy,
      }),
    ];

    const { result, rerender } = renderHook<HarnessResult, HarnessProps>(
      useHarness,
      {
        initialProps: { ctx: makeContext('A'), commands },
      },
    );

    // Switch to an argument-completion query ("/deploy ").
    act(() => {
      result.current.buffer.setText('/deploy ');
    });

    await waitFor(() => {
      expect(completionSpy).toHaveBeenCalled();
    });
    expect(markerOf(0)).toBe('A');

    completionSpy.mockClear();
    // New context identity AND a changed argument query: the async
    // completion must observe the new context, not a stale one.
    rerender({ ctx: makeContext('B'), commands });
    act(() => {
      result.current.buffer.setText('/deploy x');
    });
    await waitFor(() => {
      expect(completionSpy).toHaveBeenCalled();
    });
    expect(markerOf(0)).toBe('B');
  });
});
