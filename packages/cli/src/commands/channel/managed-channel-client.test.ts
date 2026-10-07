/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  HttpManagedChannelControlPlane,
  ManagedChannelClientError,
} from './managed-channel-client.js';

function client(answers: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const answer = answers.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  ) as unknown as typeof fetch;
  return {
    calls,
    plane: new HttpManagedChannelControlPlane({
      baseUrl: 'http://127.0.0.1:4181/',
      tenantId: 'tenant-1',
      channelId: 'mail 1',
      actorId: 'owner',
      workspaceId: 'ws-1',
      cwdRelative: '.',
      fetch: fetchImpl,
    }),
  };
}

describe('HttpManagedChannelControlPlane', () => {
  it('addresses the trusted adapter surface with the tenant header', async () => {
    const { plane, calls } = client([
      { status: 200, body: {} },
      {
        status: 200,
        body: { inputId: 'chin-1', sessionId: 's-1', replayed: true },
      },
      {
        status: 200,
        body: {
          deliveries: [
            {
              deliveryId: 'd-1',
              replyContext: { to: 'alice@example.com' },
              segments: [{ ordinal: 0, segmentId: 'd-1:0', text: 'hi' }],
            },
          ],
        },
      },
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    await plane.register({
      platform: 'email',
      accountId: 'agent@example.com',
      accountGeneration: 2,
      policy: {
        adapter: 'email',
        senderPolicy: 'allowlist',
        allowedSenders: ['alice@example.com'],
        dispatchMode: 'followup',
      },
    });
    expect(calls[0]).toMatchObject({
      url: 'http://127.0.0.1:4181/internal/managed-channels/v1/channels/mail%201',
      init: { method: 'PUT' },
    });
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      platform: 'email',
      accountGeneration: 2,
      actorId: 'owner',
      workspaceId: 'ws-1',
      cwdRelative: '.',
    });
    expect(
      (calls[0]!.init.headers as Record<string, string>)['x-qwen-tenant-id'],
    ).toBe('tenant-1');
    const admitted = await plane.submitInbound({
      accountGeneration: 2,
      platformEventId: '1:2',
      semanticRevision: 1,
      scope: {
        kind: 'chat_thread',
        senderId: null,
        chatId: 'a',
        threadId: 't',
      },
      senderId: 'a',
      chatId: 'a',
      threadId: 't',
      subject: null,
      text: 'hello',
      attachments: [],
      replyContext: {
        to: 'a',
        parent: '<p>',
        references: ['<p>'],
        subject: '',
      },
    });
    expect(admitted).toEqual({
      inputId: 'chin-1',
      sessionId: 's-1',
      replayed: true,
    });
    expect(calls[1]!.url).toMatch(/\/inbound$/);
    const claimed = await plane.claimDeliveries(16);
    expect(claimed).toEqual([
      {
        deliveryId: 'd-1',
        replyContext: { to: 'alice@example.com' },
        segments: [{ ordinal: 0, segmentId: 'd-1:0', text: 'hi' }],
      },
    ]);
    expect(calls[2]!.url).toMatch(/\/deliveries:claim$/);
    await plane.receipt('d-1', {
      outcome: 'accepted',
      ordinal: 0,
      providerMessageId: '<m@x>',
      acceptedAt: 5,
    });
    expect(calls[3]!.url).toMatch(/\/deliveries\/d-1:receipt$/);
    expect(JSON.parse(calls[3]!.init.body as string)).toEqual({
      outcome: 'accepted',
      ordinal: 0,
      providerMessageId: '<m@x>',
      acceptedAt: 5,
    });
    await plane.receipt('d-1', { outcome: 'unknown' });
    expect(JSON.parse(calls[4]!.init.body as string)).toEqual({
      outcome: 'unknown',
    });
  });

  it('surfaces the server error code on a refusal', async () => {
    const { plane } = client([
      {
        status: 409,
        body: { error: { code: 'channel_generation_stale', message: 'stale' } },
      },
    ]);
    const refusal = await plane.disconnect().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ManagedChannelClientError);
    expect(refusal).toMatchObject({
      status: 409,
      code: 'channel_generation_stale',
    });
  });
});
