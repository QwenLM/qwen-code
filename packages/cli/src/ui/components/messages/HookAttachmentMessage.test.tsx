/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { Box } from 'ink';
import {
  buildHookAttachmentHistoryItem,
  isStopHookEvent,
} from './HookAttachmentMessage.js';
import { renderWithProviders } from '../../../test-utils/render.js';
import { createMockSettings } from '../../../test-utils/settings.js';
import { makeFakeConfig } from '@qwen-code/core';
import {
  HookNonBlockingErrorAttachment,
  HookErrorDuringExecutionAttachment,
  HookBlockingErrorAttachment,
  HookStoppedContinuationAttachment,
  HookSystemMessageAttachment,
  HookPermissionDecisionAttachment,
} from '@qwen-code/core';

const config = makeFakeConfig();
const settings = createMockSettings();

const renderItem = async (item: ReturnType<typeof buildHookAttachmentHistoryItem>) => {
  if (!item) throw new Error('expected item');
  const { lastFrame, unmount } = await renderWithProviders(
    <Box>{item.content}</Box>,
    { config, settings },
  );
  const out = lastFrame() ?? '';
  unmount();
  return out;
};

describe('buildHookAttachmentHistoryItem — hook_non_blocking_error', () => {
  const base: HookNonBlockingErrorAttachment =
    new HookNonBlockingErrorAttachment({
      type: 'hook_non_blocking_error',
      hookName: 'PreToolUse:Bash',
      stderr: 'Failed with non-blocking status code: boom',
      stdout: '',
      exitCode: 1,
      toolUseID: 't',
      hookEvent: 'PreToolUse',
      command: 'echo',
    });

  it('renders title + body line each with its own ⎿ connector', async () => {
    const item = buildHookAttachmentHistoryItem(base);
    const out = await renderItem(item);
    // Two connectors: one for the error title, one for the body line.
    const connectorCount = (out.match(/⎿/g) ?? []).length;
    expect(connectorCount).toBe(2);
    expect(out).toContain('PreToolUse:Bash hook error');
    expect(out).toContain('Failed with non-blocking status code: boom');
  });

  it('falls back to stdout when stderr is empty', async () => {
    const item = buildHookAttachmentHistoryItem(
      new HookNonBlockingErrorAttachment({
        ...base,
        stderr: '',
        stdout: 'fallback body',
      }),
    );
    const out = await renderItem(item);
    expect(out).toContain('fallback body');
  });

  it('emits a single connector when body is empty', async () => {
    const item = buildHookAttachmentHistoryItem(
      new HookNonBlockingErrorAttachment({
        ...base,
        stderr: '',
        stdout: '',
      }),
    );
    const out = await renderItem(item);
    const connectorCount = (out.match(/⎿/g) ?? []).length;
    expect(connectorCount).toBe(1);
    expect(out).toContain('PreToolUse:Bash hook error');
    expect(out).not.toContain('Failed with');
  });

  it('clamps multi-line stderr to first newline block', async () => {
    const item = buildHookAttachmentHistoryItem(
      new HookNonBlockingErrorAttachment({
        ...base,
        stderr: 'first line\nsecond line should not appear',
      }),
    );
    const out = await renderItem(item);
    expect(out).toContain('first line');
    expect(out).not.toContain('second line should not appear');
  });

  it('truncates body longer than 200 chars with ellipsis', async () => {
    const longLine = 'x'.repeat(220);
    const item = buildHookAttachmentHistoryItem(
      new HookNonBlockingErrorAttachment({ ...base, stderr: longLine }),
    );
    const out = await renderItem(item);
    expect(out).toContain('\u2026');
    expect(out).not.toContain(longLine);
  });

  it('returns null for Stop event (suppressed)', () => {
    const item = buildHookAttachmentHistoryItem(
      new HookNonBlockingErrorAttachment({
        ...base,
        hookEvent: 'Stop',
      }),
    );
    expect(item).toBeNull();
  });

  it('returns null for SubagentStop event (suppressed)', () => {
    const item = buildHookAttachmentHistoryItem(
      new HookNonBlockingErrorAttachment({
        ...base,
        hookEvent: 'SubagentStop',
      }),
    );
    expect(item).toBeNull();
  });
});

describe('buildHookAttachmentHistoryItem — hook_error_during_execution', () => {
  const att: HookErrorDuringExecutionAttachment =
    new HookErrorDuringExecutionAttachment({
      type: 'hook_error_during_execution',
      content: 'callback exploded',
      hookName: 'PreToolUse:Bash',
      toolUseID: 't',
      hookEvent: 'PreToolUse',
    });

  it('renders single dim warning line, no body', async () => {
    const item = buildHookAttachmentHistoryItem(att);
    const out = await renderItem(item);
    expect(out).toContain('⎿');
    expect(out).toContain('PreToolUse:Bash hook warning');
    // The internal error content (`callback exploded`) is not displayed —
    // matches CC's hook_error_during_execution renderer.
    expect(out).not.toContain('callback exploded');
  });

  it('returns null for Stop event', () => {
    const item = buildHookAttachmentHistoryItem(
      new HookErrorDuringExecutionAttachment({
        ...att,
        hookEvent: 'Stop',
      }),
    );
    expect(item).toBeNull();
  });
});

describe('isStopHookEvent', () => {
  it('matches Stop and SubagentStop', () => {
    expect(isStopHookEvent('Stop')).toBe(true);
    expect(isStopHookEvent('SubagentStop')).toBe(true);
    expect(isStopHookEvent('PreToolUse')).toBe(false);
  });
});

describe('buildHookAttachmentHistoryItem — hook_blocking_error', () => {
  const att: HookBlockingErrorAttachment = new HookBlockingErrorAttachment({
    type: 'hook_blocking_error',
    blockingError: { blockingError: 'denied by policy', command: 'rm -rf /' },
    hookName: 'PreToolUse:Bash',
    toolUseID: 't',
    hookEvent: 'PreToolUse',
  });

  it('renders title + body each with its own ⎿ connector', async () => {
    const item = buildHookAttachmentHistoryItem(att);
    const out = await renderItem(item);
    const connectorCount = (out.match(/⎿/g) ?? []).length;
    expect(connectorCount).toBe(2);
    expect(out).toContain('PreToolUse:Bash hook returned blocking error');
    expect(out).toContain('denied by policy');
  });

  it('omits body and emits a single connector when blockingError is empty', async () => {
    const item = buildHookAttachmentHistoryItem(
      new HookBlockingErrorAttachment({
        ...att,
        blockingError: { blockingError: '   ', command: 'x' },
      }),
    );
    const out = await renderItem(item);
    const connectorCount = (out.match(/⎿/g) ?? []).length;
    expect(connectorCount).toBe(1);
    expect(out).toContain('hook returned blocking error');
    expect(out).not.toContain('denied by policy');
  });

  it('returns null for Stop event', () => {
    const item = buildHookAttachmentHistoryItem(
      new HookBlockingErrorAttachment({
        ...att,
        hookEvent: 'Stop',
      }),
    );
    expect(item).toBeNull();
  });
});

describe('buildHookAttachmentHistoryItem — hook_stopped_continuation', () => {
  const att: HookStoppedContinuationAttachment =
    new HookStoppedContinuationAttachment({
      type: 'hook_stopped_continuation',
      message: 'must finish task',
      hookName: 'Stop',
      toolUseID: 't',
      hookEvent: 'PostToolUse',
    });

  it('renders single warning line with hookName + message', async () => {
    const item = buildHookAttachmentHistoryItem(att);
    const out = await renderItem(item);
    expect(out).toContain('⎿');
    expect(out).toContain('Stop hook stopped continuation: must finish task');
  });

  it('returns null for Stop event', () => {
    const item = buildHookAttachmentHistoryItem(
      new HookStoppedContinuationAttachment({
        ...att,
        hookEvent: 'Stop',
      }),
    );
    expect(item).toBeNull();
  });
});

describe('buildHookAttachmentHistoryItem — hook_system_message', () => {
  it('renders "{hookName} says: {content}" line', async () => {
    const att: HookSystemMessageAttachment = new HookSystemMessageAttachment({
      type: 'hook_system_message',
      content: 'be careful',
      hookName: 'PreToolUse:Bash',
      toolUseID: 't',
      hookEvent: 'PreToolUse',
    });
    const item = buildHookAttachmentHistoryItem(att);
    const out = await renderItem(item);
    expect(out).toContain('⎿');
    expect(out).toContain('PreToolUse:Bash says: be careful');
  });
});

describe('buildHookAttachmentHistoryItem — hook_permission_decision', () => {
  it('renders "Allowed by {hookEvent} hook"', async () => {
    const att: HookPermissionDecisionAttachment =
      new HookPermissionDecisionAttachment({
        type: 'hook_permission_decision',
        decision: 'allow',
        toolUseID: 't',
        hookEvent: 'PreToolUse',
      });
    const item = buildHookAttachmentHistoryItem(att);
    const out = await renderItem(item);
    expect(out).toContain('Allowed by PreToolUse hook');
  });

  it('renders "Denied by {hookEvent} hook" for deny', async () => {
    const att: HookPermissionDecisionAttachment =
      new HookPermissionDecisionAttachment({
        type: 'hook_permission_decision',
        decision: 'deny',
        toolUseID: 't',
        hookEvent: 'PreToolUse',
      });
    const item = buildHookAttachmentHistoryItem(att);
    const out = await renderItem(item);
    expect(out).toContain('Denied by PreToolUse hook');
  });
});
