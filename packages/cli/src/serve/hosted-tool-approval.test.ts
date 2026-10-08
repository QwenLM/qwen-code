/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOSTED_APPROVAL_TIMEOUT_MS,
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
  hostedActionAllowed,
  hostedApprovalAsks,
  hostedApprovalDefinition,
  parseHostedApprovalSettings,
} from './hosted-tool-approval.js';

describe('Hosted tool approval settings', () => {
  it('defaults to yolo and accepts only the modes a tool turn can ask in', () => {
    expect(parseHostedApprovalSettings(undefined, undefined)).toEqual({
      mode: 'yolo',
      timeoutMs: HOSTED_APPROVAL_TIMEOUT_MS,
    });
    expect(HOSTED_APPROVAL_TIMEOUT_MS).toBe(600_000);
    expect(parseHostedApprovalSettings('default', 1_000)).toEqual({
      mode: 'default',
      timeoutMs: 1_000,
    });
    expect(parseHostedApprovalSettings('auto-edit', 86_400_000)).toEqual({
      mode: 'auto-edit',
      timeoutMs: 86_400_000,
    });
    for (const mode of ['plan', 'auto', 'YOLO', 'auto_edit', 1, null])
      expect(parseHostedApprovalSettings(mode, undefined)).toBeUndefined();
    for (const timeout of [999, 86_400_001, 1_000.5, '1000', null]) {
      expect(parseHostedApprovalSettings('default', timeout)).toBeUndefined();
      expect(parseHostedApprovalSettings('yolo', timeout)).toEqual({
        mode: 'yolo',
        timeoutMs: HOSTED_APPROVAL_TIMEOUT_MS,
      });
    }
  });

  it('asks before the tools each mode does not pre-approve', () => {
    const asked = (mode: 'yolo' | 'default' | 'auto-edit', search = false) =>
      ['read_file', 'write_file', 'edit', 'run_shell_command', 'glob'].filter(
        (tool) => hostedApprovalAsks({ mode, timeoutMs: 1_000 }, tool, search),
      );
    expect(asked('yolo')).toEqual([]);
    // `glob` is asked outside the `/2` search profiles, including for an
    // MCP-declared tool of that name; only a search profile pre-approves it.
    expect(asked('default')).toEqual([
      'write_file',
      'edit',
      'run_shell_command',
      'glob',
    ]);
    expect(asked('default', true)).toEqual([
      'write_file',
      'edit',
      'run_shell_command',
    ]);
    expect(asked('auto-edit')).toEqual(['run_shell_command', 'glob']);
    expect(asked('auto-edit', true)).toEqual(['run_shell_command']);
    expect(asked('yolo', true)).toEqual([]);
    for (const mode of ['default', 'auto-edit'] as const)
      expect(hostedApprovalAsks({ mode, timeoutMs: 1_000 }, 'new_tool')).toBe(
        true,
      );
    expect(
      hostedApprovalAsks({ mode: 'yolo', timeoutMs: 1_000 }, 'new_tool'),
    ).toBe(false);
  });

  it('pins only a mode that asks in the Session definition', () => {
    expect(
      hostedApprovalDefinition({ mode: 'yolo', timeoutMs: 5_000 }),
    ).toEqual({});
    expect(
      hostedApprovalDefinition({ mode: 'auto-edit', timeoutMs: 5_000 }),
    ).toEqual({ approvalMode: 'auto-edit', approvalTimeoutMs: 5_000 });
  });
});

describe('Hosted approval decisions', () => {
  it('recognises allow under the policy revision the Action recorded', () => {
    const decision = (optionId: string, policyRevision: string) =>
      createHash('sha256')
        .update(
          JSON.stringify({ v: 1, optionId, inputRevision: 1, policyRevision }),
        )
        .digest('hex');
    const action = (digest: string) => ({
      requestId: 'tool_approval_1',
      kind: 'permission',
      source: 'tool_call',
      inputRevision: 1,
      optionsRef: null,
      state: 'decided' as const,
      decisionRef: {
        resourceId: 'r',
        kind: 'managed-action-decision',
        schemaVersion: 1,
        byteLength: 1,
        digest,
      },
    });
    const next = 'hosted-tool-approval/2';
    expect(hostedActionAllowed(action(decision('allow', next)), next)).toBe(
      true,
    );
    expect(
      hostedActionAllowed(
        action(decision('allow', next)),
        HOSTED_TOOL_APPROVAL_POLICY,
      ),
    ).toBe(false);
    expect(hostedActionAllowed(action(decision('deny', next)), next)).toBe(
      false,
    );
  });
});

describe('Hosted approval waiters', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('wakes on an answer, an abort or the expiry, and not before', async () => {
    vi.useFakeTimers();
    const waiters = new HostedApprovalWaiters();
    const settled: string[] = [];
    const controller = new AbortController();
    const expiresAt = Date.now() + 5_000;
    const answered = waiters
      .wait('a', expiresAt, new AbortController().signal, () => false)
      .then(() => settled.push('a'));
    const aborted = waiters
      .wait('b', expiresAt, controller.signal, () => false)
      .then(() => settled.push('b'));
    const expired = waiters
      .wait('c', expiresAt, new AbortController().signal, () => false)
      .then(() => settled.push('c'));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toEqual([]);
    waiters.notify('a');
    await answered;
    controller.abort();
    await aborted;
    expect(settled).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(1);
    await expired;
    expect(settled).toEqual(['a', 'b', 'c']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('notices a final Action or a stopped Session on its next check', async () => {
    vi.useFakeTimers();
    const waiters = new HostedApprovalWaiters();
    let final = false;
    let settled = false;
    const waiting = waiters
      .wait('a', Date.now() + 60_000, new AbortController().signal, () => final)
      .then(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    final = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not wait once the signal has aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    let settled = false;
    const waiting = new HostedApprovalWaiters()
      .wait('a', Date.now() + 5_000, controller.signal, () => false)
      .then(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not wait for an Action that is already final', async () => {
    vi.useFakeTimers();
    const waiters = new HostedApprovalWaiters();
    await waiters.wait(
      'a',
      Date.now() + 5_000,
      new AbortController().signal,
      () => true,
    );
    expect(vi.getTimerCount()).toBe(0);
    waiters.notify('a');
  });
});
