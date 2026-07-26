/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  DiscordRestApi,
  INTERACTION_CALLBACK,
  EPHEMERAL_FLAG,
} from './restApi.js';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(
  responder: (c: Captured) => { status: number; json?: unknown },
) {
  const calls: Captured[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const captured: Captured = {
      url,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(captured);
    const { status, json } = responder(captured);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function api(impl: typeof fetch) {
  return new DiscordRestApi({
    botToken: 'bot-secret',
    applicationId: 'app_1',
    fetchImpl: impl,
    apiBase: 'https://discord.test/api/v10',
  });
}

describe('DiscordRestApi — createMessage', () => {
  it('POSTs content + components with Bot auth and returns the created id', async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      json: { id: 'm_42' },
    }));
    const r = await api(impl).createMessage('chan_1', 'hi', [
      { type: 1, components: [] },
    ]);
    expect(r.ok).toBe(true);
    expect((r.body as { id: string }).id).toBe('m_42');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(
      'https://discord.test/api/v10/channels/chan_1/messages',
    );
    expect(calls[0].headers['Authorization']).toBe('Bot bot-secret');
    expect((calls[0].body as { content: string }).content).toBe('hi');
    expect(
      (calls[0].body as { components: unknown[] }).components,
    ).toHaveLength(1);
  });

  it('omits components when none are given', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, json: {} }));
    await api(impl).createMessage('chan_1', 'no buttons');
    expect(calls[0].body).toEqual({
      content: 'no buttons',
      allowed_mentions: { parse: [] },
    });
  });

  it('suppresses all mention parsing (no @everyone/@here/role/user pings)', async () => {
    // Discord parses @everyone/@here/roles by DEFAULT when this field is
    // absent — relayed agent output containing "@everyone" would otherwise
    // ping the whole server using the bot's permissions.
    const { impl, calls } = fakeFetch(() => ({ status: 200, json: {} }));
    await api(impl).createMessage('chan_1', '@everyone hi @here <@&123>');
    expect(
      (calls[0].body as { allowed_mentions: { parse: string[] } })
        .allowed_mentions,
    ).toEqual({ parse: [] });
  });

  it('surfaces a 429 retry_after', async () => {
    const { impl } = fakeFetch(() => ({
      status: 429,
      json: { retry_after: 3.5 },
    }));
    const r = await api(impl).createMessage('chan_1', 'x');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.retryAfterSec).toBe(3.5);
  });

  it('returns status 0 on a network error (caller backs off)', async () => {
    const impl = (async () => {
      throw new Error('econn');
    }) as unknown as typeof fetch;
    const r = await api(impl).createMessage('chan_1', 'x');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
  });
});

describe('DiscordRestApi — editMessage', () => {
  it('PATCHes the channel message path with content + components', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, json: {} }));
    await api(impl).editMessage('chan_1', 'm_42', 'Resolved', [
      { type: 1, components: [] },
    ]);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe(
      'https://discord.test/api/v10/channels/chan_1/messages/m_42',
    );
    expect((calls[0].body as { content: string }).content).toBe('Resolved');
  });

  it('suppresses all mention parsing on edit too', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, json: {} }));
    await api(impl).editMessage('chan_1', 'm_42', '@everyone edited');
    expect(
      (calls[0].body as { allowed_mentions: { parse: string[] } })
        .allowed_mentions,
    ).toEqual({ parse: [] });
  });
});

describe('DiscordRestApi — createThread', () => {
  it('POSTs the message threads path and returns the thread id', async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 201,
      json: { id: 'thread_7' },
    }));
    const r = await api(impl).createThread('chan_1', 'm_42', 'qwen output');
    expect(r.ok).toBe(true);
    expect((r.body as { id: string }).id).toBe('thread_7');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(
      'https://discord.test/api/v10/channels/chan_1/messages/m_42/threads',
    );
    expect((calls[0].body as { name: string }).name).toBe('qwen output');
  });
});

describe('DiscordRestApi — interaction responses', () => {
  it('deferInteraction acks with a deferred ephemeral callback', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 204, json: undefined }));
    await api(impl).deferInteraction('int_1', 'tok_abc');
    expect(calls[0].url).toBe(
      'https://discord.test/api/v10/interactions/int_1/tok_abc/callback',
    );
    const body = calls[0].body as { type: number; data: { flags: number } };
    expect(body.type).toBe(INTERACTION_CALLBACK.deferredEphemeral);
    expect(body.data.flags).toBe(EPHEMERAL_FLAG);
  });

  it('replyEphemeral sends an immediate ephemeral message', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 204, json: undefined }));
    await api(impl).replyEphemeral('int_1', 'tok_abc', 'Channel bound');
    const body = calls[0].body as {
      type: number;
      data: { content: string; flags: number };
    };
    expect(body.type).toBe(INTERACTION_CALLBACK.channelMessage);
    expect(body.data.content).toBe('Channel bound');
    expect(body.data.flags).toBe(EPHEMERAL_FLAG);
  });

  it('editInteractionReply PATCHes the @original webhook message for this app', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, json: {} }));
    await api(impl).editInteractionReply('tok_abc', 'You voted approve');
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe(
      'https://discord.test/api/v10/webhooks/app_1/tok_abc/messages/@original',
    );
    expect((calls[0].body as { content: string }).content).toBe(
      'You voted approve',
    );
  });
});
