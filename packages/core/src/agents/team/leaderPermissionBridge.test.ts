/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerLeader,
  getLeader,
  unregisterLeader,
  forwardApproval,
  wrapConfirmWithBadge,
} from './leaderPermissionBridge.js';
import type {
  ForwardedApproval,
  LeaderApprovalCallbacks,
} from './leaderPermissionBridge.js';
import type { ToolCallConfirmationDetails } from '../../tools/tools.js';
import { ToolConfirmationOutcome } from '../../tools/tools.js';

function makeDetails(title = 'Confirm Edit'): ToolCallConfirmationDetails {
  return {
    type: 'info',
    title,
    prompt: 'Edit file.ts',
    onConfirm: async () => {},
  } as ToolCallConfirmationDetails;
}

describe('leaderPermissionBridge', () => {
  beforeEach(() => {
    unregisterLeader();
  });

  it('returns null when no leader is registered', () => {
    expect(getLeader()).toBeNull();
  });

  it('registers and returns leader callbacks', () => {
    const cb: LeaderApprovalCallbacks = {
      enqueueApproval: () => {},
    };
    registerLeader(cb);
    expect(getLeader()).toBe(cb);
  });

  it('unregisters leader', () => {
    registerLeader({ enqueueApproval: () => {} });
    unregisterLeader();
    expect(getLeader()).toBeNull();
  });

  it('forwards approval when leader is registered', () => {
    const received: ForwardedApproval[] = [];
    registerLeader({
      enqueueApproval: (a) => received.push(a),
    });

    const details = makeDetails();
    const ok = forwardApproval('worker-1', '#ff0000', details);

    expect(ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].teammateName).toBe('worker-1');
    expect(received[0].teammateColor).toBe('#ff0000');
    expect(received[0].details).toBe(details);
  });

  it('returns false when no leader is registered', () => {
    const ok = forwardApproval('worker-1', undefined, makeDetails());
    expect(ok).toBe(false);
  });
});

describe('wrapConfirmWithBadge', () => {
  it('prefixes title with teammate name', () => {
    const original = makeDetails('Confirm Edit');
    const wrapped = wrapConfirmWithBadge(original, 'alice', '#00ff00');
    expect(wrapped.title).toBe('[alice] Confirm Edit');
  });

  it('preserves onConfirm behavior', async () => {
    let called = false;
    const original = {
      type: 'info' as const,
      title: 'Test',
      prompt: 'test',
      onConfirm: async () => {
        called = true;
      },
    } as ToolCallConfirmationDetails;

    const wrapped = wrapConfirmWithBadge(original, 'bob');
    await wrapped.onConfirm(ToolConfirmationOutcome.ProceedOnce);
    expect(called).toBe(true);
  });
});
