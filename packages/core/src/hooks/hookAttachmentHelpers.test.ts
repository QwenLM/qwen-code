/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { hookResultsToAttachments } from './hookAttachmentHelpers.js';
import {
  HookEventName,
  HookType,
  type HookExecutionResult,
} from './types.js';

const baseCommand = (
  command = 'echo hello',
): HookExecutionResult['hookConfig'] => ({
  type: HookType.Command,
  command,
});

describe('hookResultsToAttachments — hookName composition', () => {
  it('uses bare event name when matchQuery is absent', () => {
    const results: HookExecutionResult[] = [
      {
        hookConfig: baseCommand(),
        eventName: HookEventName.UserPromptSubmit,
        success: false,
        exitCode: 1,
        stderr: 'boom',
        stdout: '',
        duration: 5,
      },
    ];
    const [att] = hookResultsToAttachments(
      results,
      HookEventName.UserPromptSubmit,
    );
    expect((att as { hookName: string }).hookName).toBe('UserPromptSubmit');
  });

  it('uses event:matchQuery when matchQuery is provided', () => {
    const results: HookExecutionResult[] = [
      {
        hookConfig: baseCommand(),
        eventName: HookEventName.PreToolUse,
        success: false,
        exitCode: 1,
        stderr: 'denied',
        stdout: '',
        duration: 5,
      },
    ];
    const [att] = hookResultsToAttachments(
      results,
      HookEventName.PreToolUse,
      { toolUseID: 'tool-1', matchQuery: 'Bash' },
    );
    expect((att as { hookName: string }).hookName).toBe('PreToolUse:Bash');
  });

  it('handles SessionStart:source style matchQuery', () => {
    const results: HookExecutionResult[] = [
      {
        hookConfig: baseCommand(),
        eventName: HookEventName.SessionStart,
        success: false,
        exitCode: 1,
        stderr: 'env not set',
        stdout: '',
        duration: 5,
      },
    ];
    const [att] = hookResultsToAttachments(
      results,
      HookEventName.SessionStart,
      { matchQuery: 'startup' },
    );
    expect((att as { hookName: string }).hookName).toBe('SessionStart:startup');
  });
});

describe('hookResultsToAttachments — display stderr wrapping', () => {
  it('wraps Command non-zero exit stderr with "Failed with non-blocking status code:"', () => {
    const results: HookExecutionResult[] = [
      {
        hookConfig: baseCommand(),
        eventName: HookEventName.PreToolUse,
        success: false,
        exitCode: 1,
        stderr: 'permission denied',
        stdout: '',
        duration: 5,
      },
    ];
    const [att] = hookResultsToAttachments(
      results,
      HookEventName.PreToolUse,
      { toolUseID: 't', matchQuery: 'Bash' },
    );
    expect(att.type).toBe('hook_non_blocking_error');
    if (att.type !== 'hook_non_blocking_error') return;
    expect(att.stderr).toBe(
      'Failed with non-blocking status code: permission denied',
    );
    expect(att.stdout).toBe('');
  });

  it('renders preflight failure (exitCode 1) as hook_non_blocking_error with the stderr message', () => {
    const results: HookExecutionResult[] = [
      {
        hookConfig: baseCommand('${QWEN_PLUGIN_ROOT}/missing.sh'),
        eventName: HookEventName.PreToolUse,
        success: false,
        exitCode: 1,
        stderr: 'Plugin directory does not exist: /tmp/missing',
        stdout: '',
        error: new Error('preflight failure'),
        duration: 1,
      },
    ];
    const [att] = hookResultsToAttachments(
      results,
      HookEventName.PreToolUse,
      { matchQuery: 'Bash' },
    );
    expect(att.type).toBe('hook_non_blocking_error');
    if (att.type !== 'hook_non_blocking_error') return;
    expect(att.stderr).toContain('Plugin directory does not exist');
  });

  it('skips exitCode 2 (EXIT_CODE_BLOCK) — handled upstream as blocking error', () => {
    const results: HookExecutionResult[] = [
      {
        hookConfig: baseCommand(),
        eventName: HookEventName.PreToolUse,
        success: false,
        exitCode: 2,
        stderr: 'blocked',
        stdout: '',
        duration: 1,
      },
    ];
    const attachments = hookResultsToAttachments(
      results,
      HookEventName.PreToolUse,
      { matchQuery: 'Bash' },
    );
    expect(attachments).toHaveLength(0);
  });

  it('substitutes "No stderr output" when raw stderr is empty', () => {
    const results: HookExecutionResult[] = [
      {
        hookConfig: baseCommand(),
        eventName: HookEventName.PreToolUse,
        success: false,
        exitCode: 1,
        stderr: '',
        stdout: '',
        duration: 5,
      },
    ];
    const [att] = hookResultsToAttachments(
      results,
      HookEventName.PreToolUse,
      { matchQuery: 'Bash' },
    );
    if (att.type !== 'hook_non_blocking_error') {
      throw new Error('expected non_blocking_error');
    }
    expect(att.stderr).toBe(
      'Failed with non-blocking status code: No stderr output',
    );
  });

  it('uses "Failed to run:" when failureKind=spawn for Command hooks', () => {
    const results: HookExecutionResult[] = [
      {
        hookConfig: baseCommand('does-not-exist'),
        eventName: HookEventName.PreToolUse,
        success: false,
        exitCode: 1,
        error: new Error('spawn ENOENT'),
        stderr: '',
        stdout: '',
        duration: 5,
        failureKind: 'spawn',
      },
    ];
    const [att] = hookResultsToAttachments(
      results,
      HookEventName.PreToolUse,
      { matchQuery: 'Bash' },
    );
    if (att.type !== 'hook_non_blocking_error') {
      throw new Error('expected non_blocking_error');
    }
    expect(att.stderr).toBe('Failed to run: spawn ENOENT');
  });

  it('produces hook_cancelled when failureKind=cancelled', () => {
    const results: HookExecutionResult[] = [
      {
        hookConfig: baseCommand(),
        eventName: HookEventName.PreToolUse,
        success: false,
        error: new Error('Hook cancelled'),
        stderr: '',
        stdout: '',
        duration: 5,
        failureKind: 'cancelled',
      },
    ];
    const [att] = hookResultsToAttachments(
      results,
      HookEventName.PreToolUse,
      { matchQuery: 'Bash' },
    );
    expect(att.type).toBe('hook_cancelled');
  });

  it('keeps raw stderr (no shell prefix) for HTTP runtime errors', () => {
    const results: HookExecutionResult[] = [
      {
        hookConfig: { type: HookType.Http, url: 'https://example.com/h' },
        eventName: HookEventName.PreToolUse,
        success: false,
        error: new Error('connection refused'),
        duration: 5,
      },
    ];
    const [att] = hookResultsToAttachments(
      results,
      HookEventName.PreToolUse,
      { matchQuery: 'Bash' },
    );
    if (att.type !== 'hook_non_blocking_error') {
      throw new Error('expected non_blocking_error');
    }
    expect(att.stderr).toBe('connection refused');
  });

  it('keeps raw stderr (no shell prefix) for Agent runtime errors', () => {
    const results: HookExecutionResult[] = [
      {
        hookConfig: {
          type: HookType.Agent,
          prompt: 'is this safe?',
        },
        eventName: HookEventName.PreToolUse,
        success: false,
        error: new Error('agent crashed'),
        duration: 5,
      },
    ];
    const [att] = hookResultsToAttachments(
      results,
      HookEventName.PreToolUse,
      { matchQuery: 'Bash' },
    );
    if (att.type !== 'hook_non_blocking_error') {
      throw new Error('expected non_blocking_error');
    }
    expect(att.stderr).toBe('agent crashed');
  });

  it('routes Runtime hook errors to hook_error_during_execution', () => {
    const results: HookExecutionResult[] = [
      {
        hookConfig: {
          type: HookType.Runtime,
          name: 'guardrail',
          action: async () => {},
        },
        eventName: HookEventName.PreToolUse,
        success: false,
        error: new Error('callback threw'),
        duration: 5,
      },
    ];
    const [att] = hookResultsToAttachments(
      results,
      HookEventName.PreToolUse,
      { matchQuery: 'Bash' },
    );
    expect(att.type).toBe('hook_error_during_execution');
    if (att.type !== 'hook_error_during_execution') return;
    expect(att.content).toBe('callback threw');
    expect(att.hookName).toBe('PreToolUse:Bash');
  });
});
