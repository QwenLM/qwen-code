/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OutputFormat,
  type ChatRecordingFailureEvent,
  type ChatRecordingFailureListener,
  type Config,
} from '@qwen-code/qwen-code-core';
import type { JsonOutputAdapterInterface } from '../nonInteractive/io/BaseJsonOutputAdapter.js';
import {
  createChatRecordingFailureSystemMessage,
  settleChatRecording,
  subscribeToHeadlessChatRecordingFailures,
} from './chat-recording-failure.js';

const { mockWriteStderrLine } = vi.hoisted(() => ({
  mockWriteStderrLine: vi.fn(),
}));

vi.mock('./stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
}));

describe('chat recording failure reporting', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the affected session id in both system-message locations', () => {
    const message = createChatRecordingFailureSystemMessage({
      sessionId: 'failed-session',
      error: new Error('private path details'),
    });

    expect(message).toMatchObject({
      type: 'system',
      subtype: 'session_recording_degraded',
      session_id: 'failed-session',
      parent_tool_use_id: null,
      data: {
        session_id: 'failed-session',
        reason: 'write_failed',
      },
    });
    expect(JSON.stringify(message)).not.toContain('private path details');
  });

  it('reports structured failures through the supplied adapter', () => {
    let listener: ChatRecordingFailureListener | undefined;
    const unsubscribe = vi.fn();
    const config = {
      getOutputFormat: () => OutputFormat.JSON,
      onChatRecordingFailure: (next: ChatRecordingFailureListener) => {
        listener = next;
        return unsubscribe;
      },
    } as unknown as Config;
    const adapter = {
      emitMessage: vi.fn(),
    } as unknown as JsonOutputAdapterInterface;

    const dispose = subscribeToHeadlessChatRecordingFailures(config, adapter);
    listener?.({
      sessionId: 'failed-session',
      error: new Error('disk full'),
    } satisfies ChatRecordingFailureEvent);

    expect(adapter.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        subtype: 'session_recording_degraded',
        session_id: 'failed-session',
      }),
    );
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('reports text failures to stderr without using the adapter', () => {
    let listener: ChatRecordingFailureListener | undefined;
    const config = {
      getOutputFormat: () => OutputFormat.TEXT,
      onChatRecordingFailure: (next: ChatRecordingFailureListener) => {
        listener = next;
        return vi.fn();
      },
    } as unknown as Config;
    const adapter = {
      emitMessage: vi.fn(),
    } as unknown as JsonOutputAdapterInterface;

    subscribeToHeadlessChatRecordingFailures(config, adapter);
    listener?.({
      sessionId: 'failed-session',
      error: new Error('disk full'),
    });

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringMatching(/^Warning: Session recording stopped/),
    );
    expect(adapter.emitMessage).not.toHaveBeenCalled();
  });

  it('finalizes before flushing and treats a rejected flush as settled', async () => {
    const order: string[] = [];
    const config = {
      getChatRecordingService: () => ({
        finalize: () => order.push('finalize'),
        flush: async () => {
          order.push('flush');
          throw new Error('disk full');
        },
      }),
    } as unknown as Config;

    await expect(settleChatRecording(config, { finalize: true })).resolves.toBe(
      'settled',
    );
    expect(order).toEqual(['finalize', 'flush']);
  });

  it('stops waiting after two seconds without cancelling the write', async () => {
    vi.useFakeTimers();
    const flush = vi.fn(() => new Promise<void>(() => {}));
    const config = {
      getChatRecordingService: () => ({ finalize: vi.fn(), flush }),
    } as unknown as Config;

    const result = settleChatRecording(config, { finalize: false });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toBe('timeout');
    expect(flush).toHaveBeenCalledOnce();
  });
});
