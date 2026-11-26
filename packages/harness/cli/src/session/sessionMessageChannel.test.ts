/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { SessionChange } from './sessionPort.js';
import { createSessionMessageChannel } from './sessionMessageChannel.js';

function createPort() {
  return {
    port: createSessionMessageChannel({
      pendingAssistantText: '',
      activityStatus: 'idle',
    }),
  };
}

function readState(port: ReturnType<typeof createPort>['port']) {
  let state: Extract<SessionChange, { type: 'snapshot' }>['state'] | undefined;
  const stop = port.observe((change) => {
    if (change.type === 'snapshot') state = change.state;
  });
  stop();
  return state!;
}

describe('session message channel', () => {
  it('delivers current message facts first without an observer attachment gap', () => {
    const { port } = createPort();
    port.applyEvent({
      type: 'assistant_stream',
      delta: { type: 'text_delta', text: 'before' },
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    const changes: SessionChange[] = [];
    port.observe((change) => {
      changes.push(change);
      if (change.type === 'snapshot') {
        port.applyEvent({
          type: 'assistant_stream',
          delta: { type: 'text_delta', text: ' during' },
          source: { delivery: 'live', hasDisplayHistory: false },
        });
      }
    });
    expect(changes).toEqual([
      {
        type: 'snapshot',
        reason: 'observe',
        state: {
          pendingAssistantText: 'before',
          pendingThinkingText: '',
          activityStatus: 'running',
          isSending: false,
        },
      },
      {
        type: 'assistant_stream',
        delta: { type: 'text_delta', text: ' during' },
        source: { delivery: 'live', hasDisplayHistory: false },
      },
    ]);
    expect(readState(port).pendingAssistantText).toBe('before during');
  });

  it('keeps reentrant delivery ordered for all observers', () => {
    const { port } = createPort();
    const first: string[] = [];
    const second: string[] = [];
    port.observe((change) => {
      if (change.type !== 'status') return;
      first.push(change.activityStatus);
      if (change.activityStatus === 'running')
        port.applyEvent({
          type: 'status',
          activityStatus: 'idle',
          transition: true,
        });
    });
    port.observe((change) => {
      if (change.type === 'status') second.push(change.activityStatus);
    });
    port.applyEvent({
      type: 'status',
      activityStatus: 'running',
      transition: true,
    });
    expect(first).toEqual(['running', 'idle']);
    expect(second).toEqual(first);
  });

  it('does not redeliver earlier queued changes to observers added during publication', () => {
    const { port } = createPort();
    const added: SessionChange[] = [];
    port.observe((change) => {
      if (change.type === 'status' && change.activityStatus === 'running') {
        port.applyEvent({
          type: 'status',
          activityStatus: 'idle',
          transition: true,
        });
        port.observe((next) => added.push(next));
      }
    });
    port.applyEvent({
      type: 'status',
      activityStatus: 'running',
      transition: true,
    });
    expect(added).toEqual([
      {
        type: 'snapshot',
        reason: 'observe',
        state: {
          pendingAssistantText: '',
          pendingThinkingText: '',
          activityStatus: 'idle',
          isSending: false,
        },
      },
    ]);
  });

  it('cancels only one observation and keeps later observers independent', () => {
    const { port } = createPort();
    const removed = vi.fn();
    const retained = vi.fn();
    const stop = port.observe(removed);
    port.observe(retained);
    removed.mockClear();
    retained.mockClear();
    stop();
    stop();
    port.applyEvent({
      type: 'status',
      activityStatus: 'running',
      transition: false,
    });
    expect(removed).not.toHaveBeenCalled();
    expect(retained).toHaveBeenCalledOnce();
  });

  it('removes an observer whose initial snapshot callback throws', () => {
    const { port } = createPort();
    const failed = vi.fn(() => {
      throw new Error('initial failed');
    });
    expect(() => port.observe(failed)).toThrow('initial failed');
    expect(() =>
      port.applyEvent({
        type: 'status',
        activityStatus: 'running',
        transition: true,
      }),
    ).not.toThrow();
    expect(failed).toHaveBeenCalledOnce();
  });

  it('restores message facts without ending an in-flight send', () => {
    const { port } = createPort();
    port.applyEvent({ type: 'send_started', messageId: 'pending' });
    port.applyEvent({
      type: 'assistant_stream',
      delta: { type: 'thinking_delta', text: 'old thinking' },
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    port.restore({ pendingAssistantText: 'restored', activityStatus: 'idle' });
    expect(readState(port)).toEqual({
      pendingAssistantText: 'restored',
      pendingThinkingText: '',
      activityStatus: 'idle',
      isSending: true,
    });
    port.applyEvent({ type: 'send_finished', messageId: 'pending' });
    expect(readState(port).isSending).toBe(false);
  });

  it('preserves message cleanup differences between state snapshots, interrupts and connection close', () => {
    const { port } = createPort();
    port.applyEvent({
      type: 'assistant_stream',
      delta: { type: 'text_delta', text: 'body' },
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    port.applyEvent({
      type: 'assistant_stream',
      delta: { type: 'thinking_delta', text: 'thinking' },
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    port.applyEvent({
      type: 'status',
      activityStatus: 'idle',
      transition: false,
    });
    expect(readState(port)).toMatchObject({
      pendingAssistantText: 'body',
      pendingThinkingText: 'thinking',
    });
    port.applyEvent({
      type: 'interrupted',
      scope: 'permission',
      message: 'cancelled',
    });
    expect(readState(port).pendingAssistantText).toBe('body');
    port.applyEvent({ type: 'connection_closed' });
    expect(readState(port)).toMatchObject({
      pendingAssistantText: '',
      pendingThinkingText: 'thinking',
    });
    port.applyEvent({
      type: 'interrupted',
      scope: 'turn',
      message: 'cancelled',
    });
    expect(readState(port)).toMatchObject({
      pendingAssistantText: '',
      pendingThinkingText: '',
      activityStatus: 'idle',
    });
  });

  it('keeps separate session message states isolated', () => {
    const first = createPort();
    const second = createPort();
    first.port.applyEvent({
      type: 'assistant_stream',
      delta: { type: 'text_delta', text: 'first' },
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    expect(readState(first.port).pendingAssistantText).toBe('first');
    expect(readState(second.port).pendingAssistantText).toBe('');
  });
});
