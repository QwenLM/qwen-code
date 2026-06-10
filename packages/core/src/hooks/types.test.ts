/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH,
  createHookOutput,
  DefaultHookOutput,
  UserPromptExpansionHookOutput,
  HookEventName,
} from './types.js';

describe('UserPromptSubmit getAdditionalContext', () => {
  it('sanitizes additionalContext', () => {
    const output = createHookOutput('UserPromptSubmit', {
      hookSpecificOutput: { additionalContext: '<xml>value</xml>' },
    });

    expect(output.getAdditionalContext()).toBe('&lt;xml&gt;value&lt;/xml&gt;');
  });
});

describe('UserPromptExpansionHookOutput.getAdditionalContext', () => {
  it('returns undefined when hookSpecificOutput is absent', () => {
    expect(
      new UserPromptExpansionHookOutput().getAdditionalContext(),
    ).toBeUndefined();
  });

  it('returns undefined when additionalContext is absent', () => {
    expect(
      new UserPromptExpansionHookOutput({
        hookSpecificOutput: {},
      }).getAdditionalContext(),
    ).toBeUndefined();
  });

  it('returns undefined when additionalContext is not a string', () => {
    expect(
      new UserPromptExpansionHookOutput({
        hookSpecificOutput: { additionalContext: 123 },
      }).getAdditionalContext(),
    ).toBeUndefined();
  });

  it('preserves empty-string semantics', () => {
    expect(
      new UserPromptExpansionHookOutput({
        hookSpecificOutput: { additionalContext: '' },
      }).getAdditionalContext(),
    ).toBe('');
  });

  it('escapes ampersands and angle brackets before capping the result', () => {
    const output = new UserPromptExpansionHookOutput({
      hookSpecificOutput: {
        additionalContext: `a&b<${'x'.repeat(
          MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH,
        )}`,
      },
    });

    const result = output.getAdditionalContext();

    expect(result).toHaveLength(
      MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH,
    );
    expect(result?.startsWith('a&amp;b&lt;')).toBe(true);
    expect(result).not.toContain('<');
  });

  it('does not leave a partial entity after truncation', () => {
    const output = new UserPromptExpansionHookOutput({
      hookSpecificOutput: {
        additionalContext:
          'x'.repeat(MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH - 1) +
          '<',
      },
    });

    const result = output.getAdditionalContext();

    expect(result).toBe(
      'x'.repeat(MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH - 1),
    );
  });

  it('does not leave a partial ampersand entity after truncation', () => {
    const output = new UserPromptExpansionHookOutput({
      hookSpecificOutput: {
        additionalContext:
          'x'.repeat(MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH - 2) +
          '&',
      },
    });

    const result = output.getAdditionalContext();

    expect(result).toBe(
      'x'.repeat(MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH - 2),
    );
  });
});

describe('terminalSequence on HookOutput', () => {
  it('DefaultHookOutput preserves terminalSequence', () => {
    const output = new DefaultHookOutput({
      terminalSequence: '\x07',
    });
    expect(output.terminalSequence).toBe('\x07');
  });

  it('terminalSequence does not affect blocking decision', () => {
    const output = new DefaultHookOutput({
      terminalSequence: '\x1b]9;hello\x07',
      decision: 'allow',
    });
    expect(output.isBlockingDecision()).toBe(false);
    expect(output.shouldStopExecution()).toBe(false);
  });

  it('createHookOutput preserves terminalSequence for all event types', () => {
    const events = [
      HookEventName.PreToolUse,
      HookEventName.PostToolUse,
      HookEventName.Notification,
      HookEventName.Stop,
      HookEventName.PermissionRequest,
    ];
    for (const eventName of events) {
      const output = createHookOutput(eventName, {
        terminalSequence: '\x07',
      });
      expect(output.terminalSequence).toBe('\x07');
    }
  });

  it('terminalSequence defaults to undefined', () => {
    const output = new DefaultHookOutput({});
    expect(output.terminalSequence).toBeUndefined();
  });
});
