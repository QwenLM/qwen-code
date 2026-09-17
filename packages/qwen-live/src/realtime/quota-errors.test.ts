/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  openQwenRealtimeSession,
  QwenRealtimeError,
} from './realtime-session.js';

const QUOTA_REASON =
  'Allocated quota exceeded, please increase your quota limit.';

class QuotaTestSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  private readonly handlers = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();

  send(): void {}

  close(): void {
    this.readyState = 3;
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  message(message: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(message), false);
  }
}

async function connect(socket: QuotaTestSocket) {
  const opening = openQwenRealtimeSession(
    {
      endpoint: 'https://example.invalid/compatible-mode/v1',
      apiKey: 'synthetic-test-key',
      model: 'qwen3.5-omni-plus-realtime',
      callEpoch: 1,
      instructions: 'test',
      tools: [],
    },
    {},
    { createWebSocket: () => socket },
  );
  socket.message({ type: 'session.created', event_id: 'created' });
  socket.message({
    type: 'session.updated',
    event_id: 'updated',
    session: { id: 'session' },
  });
  return opening;
}

describe('provider quota errors', () => {
  it.each(['insufficient_quota', 'quota_exceeded'])(
    'classifies %s separately from transient HTTP 429',
    (code) => {
      expect(
        new QwenRealtimeError('Quota unavailable.', code, true, {
          status: 429,
        }).kind,
      ).toBe('quota');
    },
  );

  it('preserves ordinary rate limiting as transient', () => {
    expect(
      new QwenRealtimeError(
        'Too many requests, retry later.',
        'rate_limit_exceeded',
        true,
        { status: 429 },
      ).kind,
    ).toBe('transient');
  });

  it.each([false, true])(
    'preserves the exact close-1007 quota reason with pending speech=%s',
    async (speechPending) => {
      const socket = new QuotaTestSocket();
      const session = await connect(socket);
      if (speechPending) {
        socket.message({
          type: 'input_audio_buffer.speech_started',
          event_id: 'speech',
          item_id: 'input',
        });
      }
      socket.emit('close', 1007, Buffer.from(QUOTA_REASON));

      const closed = await session.closed;
      expect(closed.error?.kind).toBe('quota');
      expect(closed.error?.message).toContain(QUOTA_REASON);
      expect(closed.error?.closeCode).toBe(1007);
      expect(closed.error?.code).not.toBe('unrecoverable_input');
    },
  );

  it('preserves an explicit quota error event while speech is pending', async () => {
    const socket = new QuotaTestSocket();
    const session = await connect(socket);
    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech',
      item_id: 'input',
    });
    socket.message({
      type: 'error',
      error: {
        code: 'insufficient_quota',
        status: 429,
        message: QUOTA_REASON,
      },
    });

    await expect(session.closed).resolves.toMatchObject({
      reason: 'error',
      error: {
        kind: 'quota',
        code: 'insufficient_quota',
        status: 429,
        message: QUOTA_REASON,
      },
    });
  });

  it('continues reporting lost accepted speech on ordinary transport closure', async () => {
    const socket = new QuotaTestSocket();
    const session = await connect(socket);
    socket.message({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech',
      item_id: 'input',
    });
    socket.emit('close', 1006, Buffer.from(''));

    await expect(session.closed).resolves.toMatchObject({
      reason: 'error',
      error: { kind: 'protocol', code: 'unrecoverable_input' },
    });
  });
});
