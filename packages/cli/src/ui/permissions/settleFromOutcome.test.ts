/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { ToolConfirmationOutcome } from '@qwen-code/core';
import type { PermissionUpdate } from '@qwen-code/core';
import { settlePromptFromOutcome } from './settleFromOutcome.js';
import type { QueuedPermissionPrompt } from './permissionQueueStore.js';

const SUGGESTIONS: PermissionUpdate[] = [
  {
    type: 'addRules',
    destination: 'session',
    rules: [{ toolName: 'Bash', ruleContent: 'ls' }],
    behavior: 'allow',
  },
  // The mode change a write-tool prompt appends at the end of the list. The
  // settlement must remember it together with the rule, which is why the
  // scope — not a single pre-mapped update — travels to the store.
  {
    type: 'setMode',
    destination: 'session',
    mode: 'acceptEdits',
  },
];

function makeQueuedPrompt(
  overrides: Partial<QueuedPermissionPrompt> = {},
): QueuedPermissionPrompt {
  return {
    toolUseId: 'call-1',
    toolName: 'Bash',
    input: { command: 'ls' },
    reason: {
      message: 'Confirm',
      attribution: { type: 'other', reason: 'test' },
    } as QueuedPermissionPrompt['reason'],
    suggestions: SUGGESTIONS,
    skippable: true,
    approve: vi.fn(),
    reject: vi.fn(),
    abort: vi.fn(),
    ...overrides,
  };
}

describe('settlePromptFromOutcome', () => {
  it('ProceedSession approves with the session scope, leaving the suggestions to the store', () => {
    const prompt = makeQueuedPrompt();

    settlePromptFromOutcome(prompt, ToolConfirmationOutcome.ProceedSession);

    expect(prompt.approve).toHaveBeenCalledWith({ scope: 'session' });
    expect(prompt.reject).not.toHaveBeenCalled();
  });

  it('ProceedPersist approves with the persist scope', () => {
    const prompt = makeQueuedPrompt();

    settlePromptFromOutcome(prompt, ToolConfirmationOutcome.ProceedPersist);

    expect(prompt.approve).toHaveBeenCalledWith({ scope: 'persist' });
  });

  it('ProceedOnce approves without a scope, remembering nothing', () => {
    const prompt = makeQueuedPrompt();

    settlePromptFromOutcome(prompt, ToolConfirmationOutcome.ProceedOnce);

    expect(prompt.approve).toHaveBeenCalledWith({});
  });

  it('Cancel refuses, carrying the typed feedback as the refusal reason', () => {
    const prompt = makeQueuedPrompt();

    settlePromptFromOutcome(prompt, ToolConfirmationOutcome.Cancel, {
      cancelFeedback: 'use the scoped variant instead',
    });

    expect(prompt.reject).toHaveBeenCalledWith(
      'use the scoped variant instead',
    );
    expect(prompt.approve).not.toHaveBeenCalled();
  });

  it('Cancel without feedback refuses bare', () => {
    const prompt = makeQueuedPrompt();

    settlePromptFromOutcome(prompt, ToolConfirmationOutcome.Cancel);

    expect(prompt.reject).toHaveBeenCalledWith(undefined);
  });

  it('an answered question amends the call input on approval', () => {
    const prompt = makeQueuedPrompt({
      toolName: 'AskUserQuestion',
      input: { questions: [] },
    });

    settlePromptFromOutcome(prompt, ToolConfirmationOutcome.ProceedOnce, {
      answers: { Q: 'A' },
    });

    expect(prompt.approve).toHaveBeenCalledWith({
      input: { questions: [], answers: { Q: 'A' } },
    });
  });
});
