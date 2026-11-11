/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MessageType } from '../types.js';
import {
  appendMessageError,
  applyMessageError,
  applyMessageInterruption,
} from './messageNoticeProjection.js';

function createTarget() {
  const calls: unknown[] = [];
  const target: Parameters<typeof applyMessageInterruption>[1] = {
    addHistoryItem: (item) => {
      calls.push(['history', item]);
    },
    setIdle: () => {
      calls.push('idle');
    },
    clearAssistantText: () => {
      calls.push('text');
    },
    clearThinkingText: () => {
      calls.push('thinking');
    },
    clearThought: () => {
      calls.push('thought');
    },
    clearApprovals: () => {
      calls.push('approvals');
    },
    clearPendingHistory: () => {
      calls.push('pending');
    },
  };
  return { target, calls };
}

describe('message notice projection', () => {
  it('adds an error then clears active message state without clearing approvals or pending history', () => {
    const { target, calls } = createTarget();
    applyMessageError('failed', target);
    expect(calls).toEqual([
      ['history', { type: MessageType.ERROR, text: 'failed' }],
      'idle',
      'text',
      'thinking',
      'thought',
    ]);
  });

  it.each([
    { historyAvailable: false, message: 'cancelled' },
    { historyAvailable: true, message: 'cancelled' },
    { historyAvailable: false, message: '' },
  ])('retains interruption display priority and cleanup for %j', (options) => {
    const { target, calls } = createTarget();
    applyMessageInterruption({ ...options, permissionOnly: false }, target);
    const notice =
      !options.historyAvailable && options.message
        ? [['history', { type: MessageType.INFO, text: options.message }]]
        : [];
    expect(calls).toEqual([
      ...notice,
      'idle',
      'text',
      'thinking',
      'thought',
      'pending',
    ]);
  });

  it('only clears approvals for a permission interruption', () => {
    const { target, calls } = createTarget();
    applyMessageInterruption(
      {
        historyAvailable: false,
        message: 'permission cancelled',
        permissionOnly: true,
      },
      target,
    );
    expect(calls).toEqual([
      ['history', { type: MessageType.INFO, text: 'permission cancelled' }],
      'approvals',
    ]);
  });

  it('adds request failures without introducing message cleanup', () => {
    const { target, calls } = createTarget();
    appendMessageError('  send failed  ', target.addHistoryItem);
    expect(calls).toEqual([
      ['history', { type: MessageType.ERROR, text: '  send failed  ' }],
    ]);
  });

  it('does not clear state when adding the notice fails', () => {
    const { target, calls } = createTarget();
    target.addHistoryItem = () => {
      throw new Error('display failed');
    };
    expect(() => applyMessageError('failed', target)).toThrow('display failed');
    expect(calls).toEqual([]);
  });
});
