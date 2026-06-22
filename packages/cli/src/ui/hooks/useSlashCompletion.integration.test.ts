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

  it('prefers command name match over alias match for same-strength prefixes', async () => {
    // Real-world conflict: /re matches `resume` (name) and `reset` (alias of clear).
    // Without the name-vs-alias sort dimension, fzf gives the shorter `reset` a higher
    // score, so `clear` would appear first. The fix ensures `resume` (name match)
    // always ranks above any alias match at the same strength level.
    const slashCommands = [
      createTestCommand({
        name: 'clear',
        altNames: ['reset', 'new'],
        description: 'Clear conversation history',
      }),
      createTestCommand({
        name: 'resume',
        altNames: ['continue'],
        description: 'Resume a previous session',
      }),
      createTestCommand({
        name: 'recap',
        description: 'Show session recap',
      }),
    ];

    const { result } = renderHook(() =>
      useTestHarnessForSlashCompletion(
        true,
        '/re',
        slashCommands,
        mockCommandContext,
      ),
    );

    await waitFor(() => {
      expect(result.current.suggestions.length).toBeGreaterThan(1);
    });

    // resume and recap are name matches; reset is an alias match.
    // Name matches must come before alias matches regardless of fzf score.
    const names = result.current.suggestions.map((s) => s.value);
    const resumeIndex = names.indexOf('resume');
    const recapIndex = names.indexOf('recap');
    const clearIndex = names.indexOf('clear');
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(recapIndex).toBeGreaterThanOrEqual(0);
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(resumeIndex).toBeLessThan(clearIndex);
    expect(recapIndex).toBeLessThan(clearIndex);
  });
});
