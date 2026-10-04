/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { applyHookOutputToInput } from './hook-sequential-input.js';
import { HookEventName, type PreToolUseInput } from './types.js';

describe('sequential PreToolUse effective input', () => {
  it('replaces the whole input seen by the following hook', () => {
    const original = {
      tool_input: { value: 'model', removed: true },
    } as unknown as PreToolUseInput;
    const next = applyHookOutputToInput(
      original,
      {
        hookSpecificOutput: { updatedInput: { value: 'hook' } },
      },
      HookEventName.PreToolUse,
    ) as PreToolUseInput;
    expect(next.tool_input).toEqual({ value: 'hook' });
    expect(original.tool_input).toEqual({ value: 'model', removed: true });
  });
});
