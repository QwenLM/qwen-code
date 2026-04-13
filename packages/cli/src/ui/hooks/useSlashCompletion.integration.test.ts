/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { useSlashCompletion } from './useSlashCompletion.js';
import type { CommandContext, SlashCommand } from '../commands/types.js';
import { CommandKind } from '../commands/types.js';
import type { Suggestion } from '../components/SuggestionsDisplay.js';

type TestSlashCommand = Omit<SlashCommand, 'kind'> & {
  kind?: CommandKind;
  completionPriority?: number;
};

function createTestCommand(command: TestSlashCommand): SlashCommand {
  return {
    kind: CommandKind.BUILT_IN,
    ...command,
  } as SlashCommand;
}

function useTestHarnessForSlashCompletion(
  enabled: boolean,
  query: string | null,
  slashCommands: readonly SlashCommand[],
  commandContext: CommandContext,
) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [isPerfectMatch, setIsPerfectMatch] = useState(false);

  const { completionStart, completionEnd } = useSlashCompletion({
    enabled,
    query,
    slashCommands,
    commandContext,
    setSuggestions,
    setIsLoadingSuggestions,
    setIsPerfectMatch,
  });

  return {
    suggestions,
    isLoadingSuggestions,
    isPerfectMatch,
    completionStart,
    completionEnd,
  };
}

describe('useSlashCompletion integration', () => {
  const mockCommandContext = {} as CommandContext;

  it('prefers higher completionPriority over weaker fuzzy matches', async () => {
    const slashCommands = [
      createTestCommand({
        name: 'approval-mode',
        description: 'View or change the approval mode for tool usage',
      }),
      createTestCommand({
        name: 'model',
        description: 'Switch the model for this session',
        completionPriority: 100,
      }),
      createTestCommand({
        name: 'memory',
        description: 'Manage memory',
      }),
    ];

    const { result } = renderHook(() =>
      useTestHarnessForSlashCompletion(
        true,
        '/mo',
        slashCommands,
        mockCommandContext,
      ),
    );

    await waitFor(() => {
      expect(result.current.suggestions.length).toBeGreaterThan(1);
    });

    expect(result.current.suggestions[0]?.value).toBe('model');
    expect(result.current.suggestions[1]?.value).toBe('approval-mode');
  });

  it('prefers higher completionPriority for same-strength prefix matches', async () => {
    const slashCommands = [
      createTestCommand({
        name: 'memory',
        description: 'Manage memory',
      }),
      createTestCommand({
        name: 'model',
        description: 'Switch the model for this session',
        completionPriority: 100,
      }),
    ];

    const { result } = renderHook(() =>
      useTestHarnessForSlashCompletion(
        true,
        '/m',
        slashCommands,
        mockCommandContext,
      ),
    );

    await waitFor(() => {
      expect(result.current.suggestions.length).toBeGreaterThan(1);
    });

    expect(result.current.suggestions[0]?.value).toBe('model');
    expect(result.current.suggestions[1]?.value).toBe('memory');
  });
});
