/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CommandContext, SlashCommand } from '../commands/types.js';
import { CommandKind } from '../commands/types.js';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import { useCommandCompletion } from './useCommandCompletion.js';

const commandContext = {} as CommandContext;

function useCompletionFor(text: string, commands: readonly SlashCommand[]) {
  const buffer = useTextBuffer({
    initialText: text,
    initialCursorOffset: text.length,
    viewport: { width: 80, height: 20 },
    isValidPath: () => false,
    onChange: () => {},
  });

  return useCommandCompletion(buffer, '/', commands, commandContext);
}

describe('useCommandCompletion integration', () => {
  const reviewSkill: SlashCommand = {
    name: 'review',
    description: 'Review current code',
    kind: CommandKind.SKILL,
  };
  const storageSkill: SlashCommand = {
    name: 'storage',
    description: 'Inspect storage usage',
    kind: CommandKind.SKILL,
    modelInvocable: true,
  };

  it('keeps skill suggestions available after a stacked skill', async () => {
    const { result } = renderHook(() =>
      useCompletionFor('/review /sto', [reviewSkill, storageSkill]),
    );

    await waitFor(() => {
      expect(result.current.suggestions.map((item) => item.value)).toEqual([
        'storage',
      ]);
    });
  });

  it('keeps model-invocable skill suggestions available mid-input', async () => {
    const { result } = renderHook(() =>
      useCompletionFor('please /sto', [storageSkill]),
    );

    await waitFor(() => {
      expect(result.current.suggestions.map((item) => item.value)).toEqual([
        'storage',
      ]);
    });
  });
});
