/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelAgentBridge,
  ChannelConfig,
  SessionTarget,
} from '@qwen-code/channel-base';
import {
  WeComWebhookChannel,
  parseWeComWebhookConfig,
} from './WeComWebhookChannel.js';

const WEBHOOK_URL =
  'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=private-token';
const TARGET = { channelName: 'robot', type: 'chat' as const, id: 'default' };

class TestChannel extends WeComWebhookChannel {
  accepts(target: SessionTarget, source: 'delivery' | 'loop' | 'webhook') {
    if (source === 'delivery')
      return this.supportsProactiveDeliveryTarget(target);
    if (source === 'loop') return this.supportsProactiveTarget(target);
    return this.supportsProactiveWebhookTarget(target);
  }
}

const channels: WeComWebhookChannel[] = [];
const fetchMock = vi.fn<typeof fetch>();
const realFetch = globalThis.fetch;

function make(extra: Record<string, unknown> = {}) {
  const bridge = Object.assign(new EventEmitter(), {
    newSession: vi.fn(),
    prompt: vi.fn(),
    loadSession: vi.fn(),
  });
  const config: ChannelConfig & Record<string, unknown> = {
    type: 'wecom-webhook',
    token: '',
    privatePolicy: 'disabled',
    groupPolicy: 'disabled',
    allowedUsers: [],
    groups: {},
    sessionScope: 'user',
    cwd: process.cwd(),
    webhookUrl: WEBHOOK_URL,
    ...extra,
  };
  const channel = new TestChannel(
    'robot',
    config,
    bridge as unknown as ChannelAgentBridge,
  );
  channels.push(channel);
  return { channel, bridge };
}

function expectedPayload(content: string) {
  return { msgtype: 'markdown_v2', markdown_v2: { content } };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json({ errcode: 0 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  for (const channel of channels.splice(0)) {
    channel.disconnect();
    await channel.waitForDisconnect();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WeCom webhook configuration', () => {
  it.each([
    undefined,
    '',
    42,
    ' ' + WEBHOOK_URL,
    WEBHOOK_URL + '\n',
    '$UNRESOLVED_URL',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=%20',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret+key',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=%70rivate-token',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=token%0A',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=token&key=other',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=token&other=value',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=token&',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?%6bey=token',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/./send?key=token',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/extra/../send?key=token',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/%73end?key=token',
    'https://qyapi.wei\nxin.qq.com/cgi-bin/webhook/send?key=token',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook\\send?key=token',
    WEBHOOK_URL + '#',
    WEBHOOK_URL + '#fragment',
    'http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=token',
    'https://qyapi.weixin.qq.com.evil.test/cgi-bin/webhook/send?key=token',
    'https://qyapi.weixin.qq.com:444/cgi-bin/webhook/send?key=token',
    'https://user:password@qyapi.weixin.qq.com/cgi-bin/webhook/send?key=token',
    'https://qyapi.weixin.qq.com/cgi-bin/message/send?key=token',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send/?key=token',
  ])(
    'rejects invalid endpoints without exposing their value (%s)',
    (webhookUrl) => {
      expect(() => parseWeComWebhookConfig({ webhookUrl })).toThrow(
        'WeCom webhook URL must be https://qyapi.weixin.qq.com/cgi-bin/webhook/send with one URL-safe key parameter.',
      );
    },
  );

  it('accepts URL-unreserved keys without requiring an undocumented UUID shape', () => {
    const webhookUrl =
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=Token_123.~-';
    expect(parseWeComWebhookConfig({ webhookUrl }).webhookUrl.href).toBe(
      webhookUrl,
    );
  });

  it('rejects an untrusted endpoint while connecting and stays unready', async () => {
    const { channel } = make({
      webhookUrl:
        'https://qyapi.weixin.qq.com.evil.test/cgi-bin/webhook/send?key=private-token',
    });
    const connecting = channel.connect();
    await expect(connecting).rejects.toThrow(
      'WeCom webhook URL must be https://qyapi.weixin.qq.com/cgi-bin/webhook/send with one URL-safe key parameter.',
    );
    await expect(connecting).rejects.toHaveProperty(
      'message',
      expect.not.stringContaining('private-token'),
    );
    await expect(channel.sendMessage('default', 'text')).rejects.toMatchObject({
      disposition: 'permanent',
      message: 'WeCom webhook Channel is not ready.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not verify remote credentials or create a session while connecting', async () => {
    const { channel, bridge } = make();
    await channel.connect();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bridge.newSession).not.toHaveBeenCalled();
    expect(bridge.prompt).not.toHaveBeenCalled();
  });
});

describe('WeCom webhook delivery', () => {
  it.each([
    '完成报告 😀\nsecond line',
    '## Daily report\n\n**Completed**\n> Summary\n[Details](https://example.com/report)',
    '中'.repeat(1_000),
  ])('sends Markdown V2 through the proactive boundary', async (text) => {
    const { channel, bridge } = make();
    await channel.connect();
    await channel.deliverProactive(TARGET, text);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(WEBHOOK_URL);
    expect(request).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'error',
    });
    expect(JSON.parse(String(request?.body))).toEqual(expectedPayload(text));
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(bridge.newSession).not.toHaveBeenCalled();
    expect(bridge.prompt).not.toHaveBeenCalled();
  });

  it('preserves Markdown and mention-like input without adding mention fields', async () => {
    const { channel } = make();
    const text = [
      '**Result** <@all> <@user-id> <at id=all></at> @all',
      '- First item',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      'After table',
      '```ts',
      'const message = "完成 😀";',
      '```',
    ].join('\n');
    await channel.connect();
    await channel.deliverProactive(TARGET, text);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual(
      expectedPayload(text),
    );
  });

  it.each([
    ['ASCII', 'a'.repeat(4_096)],
    ['Chinese', '中'.repeat(1_365) + 'a'],
    ['emoji', '😀'.repeat(1_024)],
    ['JSON quotes', '"'.repeat(4_096)],
    ['JSON backslashes', '\\'.repeat(4_096)],
  ])('enforces the content byte boundary for %s', async (_label, text) => {
    expect(Buffer.byteLength(text, 'utf8')).toBe(4_096);
    const { channel } = make();
    await channel.connect();
    await channel.deliverProactive(TARGET, text);
    expect(fetchMock).toHaveBeenCalledOnce();
    const sent = String(fetchMock.mock.calls[0]![1]?.body);
    expect(Buffer.byteLength(sent, 'utf8')).toBeGreaterThan(4_096);
    expect(JSON.parse(sent)).toEqual(expectedPayload(text));

    fetchMock.mockClear();
    await expect(
      channel.deliverProactive(TARGET, text + 'x'),
    ).rejects.toMatchObject({
      disposition: 'permanent',
      message: 'WeCom webhook content exceeds the 4096-byte limit.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts only its exact logical group target and excludes execution targets', async () => {
    const { channel } = make();
    await channel.connect();
    for (const target of [
      { ...TARGET, channelName: 'other' },
      { ...TARGET, type: 'user' as const },
      { ...TARGET, id: 'another' },
      { ...TARGET, id: WEBHOOK_URL },
    ]) {
      await expect(
        channel.deliverProactive(target, 'message'),
      ).rejects.toThrow();
    }
    const target: SessionTarget = {
      channelName: 'robot',
      senderId: 'default',
      chatId: 'default',
      isGroup: true,
    };
    expect(channel.accepts(target, 'delivery')).toBe(true);
    expect(channel.accepts({ ...target, threadId: 'thread' }, 'delivery')).toBe(
      false,
    );
    expect(channel.accepts(target, 'loop')).toBe(false);
    expect(channel.accepts(target, 'webhook')).toBe(false);
    await expect(channel.sendMessage('another', 'text')).rejects.toThrow();
    await expect(channel.sendMessage('default', ' ')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [93000, 'permanent'],
    [93001, 'permanent'],
    [93004, 'permanent'],
    [40058, 'permanent'],
    [-1, 'transient'],
    [45009, 'transient'],
    [45033, 'transient'],
  ])(
    'rejects business code %s without exposing provider text',
    async (code, disposition) => {
      const { channel } = make();
      fetchMock.mockResolvedValueOnce(
        Response.json({
          errcode: code,
          errmsg: `${WEBHOOK_URL} message-body`,
          code: 0,
        }),
      );
      await channel.connect();
      const result = channel.deliverProactive(TARGET, 'message-body');
      await expect(result).rejects.toMatchObject({
        disposition,
        message: `WeCom webhook rejected the message (code ${code}).`,
      });
      await expect(result).rejects.not.toHaveProperty('cause');
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [400, 'permanent'],
    [403, 'permanent'],
    [408, 'transient'],
    [425, 'transient'],
    [429, 'transient'],
    [503, 'transient'],
  ] as const)(
    'reports HTTP %s without a response body or retries',
    async (status, disposition) => {
      const { channel } = make();
      const response = new Response(WEBHOOK_URL, {
        status,
      });
      const cancel = vi.spyOn(response.body!, 'cancel');
      fetchMock.mockResolvedValueOnce(response);
      await channel.connect();
      await expect(
        channel.deliverProactive(TARGET, 'message'),
      ).rejects.toMatchObject({
        disposition,
        message: `WeCom webhook request failed (HTTP ${status}).`,
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('rejects a real redirect without following it or exposing its destination', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url!);
      response.writeHead(302, {
        location: '/redirect-target?key=private-token',
      });
      response.end(WEBHOOK_URL);
    });
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
      fetchMock.mockImplementationOnce((_url, options) =>
        realFetch(endpoint, options),
      );
      const { channel } = make();
      await channel.connect();
      const result = channel.deliverProactive(TARGET, 'message');
      await expect(result).rejects.toMatchObject({
        disposition: 'transient',
        message:
          'WeCom webhook request failed or returned an invalid response; delivery may have been accepted.',
      });
      await expect(result).rejects.not.toHaveProperty('cause');
      expect(fetchMock.mock.calls[0]![1]?.redirect).toBe('error');
      expect(requests).toEqual(['/hook']);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    'not-json',
    'null',
    '[]',
    '{}',
    '{"errcode":false}',
    '{"errcode":"0"}',
    '{"code":0}',
    '{"errcode":9007199254740992}',
    '{"errcode":1e309}',
    '{"errcode":0.5}',
    '{"errcode":"0-secret"}',
  ])('rejects malformed success responses (%s)', async (body) => {
    const { channel } = make();
    fetchMock.mockResolvedValueOnce(new Response(body));
    await channel.connect();
    await expect(
      channel.deliverProactive(TARGET, 'message'),
    ).rejects.toMatchObject({
      disposition: 'transient',
      message: 'WeCom webhook returned an invalid response.',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('accepts numeric success at the response byte limit', async () => {
    const { channel } = make();
    const body = JSON.stringify({ errcode: 0 });
    fetchMock.mockResolvedValueOnce(
      new Response(body + ' '.repeat(16_384 - Buffer.byteLength(body))),
    );
    await channel.connect();
    await channel.deliverProactive(TARGET, 'message');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('bounds response reading in bytes and cancels an oversized body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ errcode: 0, errmsg: '中'.repeat(5_500) }),
          ),
        );
      },
      cancel,
    });
    fetchMock.mockResolvedValueOnce(new Response(body));
    const { channel } = make();
    await channel.connect();
    const result = channel.deliverProactive(TARGET, 'message');
    await expect(result).rejects.toMatchObject({
      disposition: 'transient',
      message:
        'WeCom webhook request failed or returned an invalid response; delivery may have been accepted.',
    });
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('bounds the cumulative response size across individually small chunks', async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ errcode: 0 }) + ' '.repeat(3 * 8_192),
    );
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 8_192) {
          controller.enqueue(bytes.slice(offset, offset + 8_192));
        }
      },
      pull(controller) {
        controller.close();
      },
      cancel,
    });
    fetchMock.mockResolvedValueOnce(new Response(body));
    const { channel } = make();
    await channel.connect();
    await expect(
      channel.deliverProactive(TARGET, 'message'),
    ).rejects.toMatchObject({
      disposition: 'transient',
      message:
        'WeCom webhook request failed or returned an invalid response; delivery may have been accepted.',
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not truncate outgoing text or expose a transport exception', async () => {
    const text = 'x'.repeat(4_096);
    fetchMock.mockRejectedValueOnce(new Error(`${WEBHOOK_URL} ${text}`));
    const { channel } = make();
    await channel.connect();
    const result = channel.deliverProactive(TARGET, text);
    await expect(result).rejects.toMatchObject({
      message:
        'WeCom webhook request failed or returned an invalid response; delivery may have been accepted.',
    });
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).markdown_v2.content,
    ).toBe(text);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('WeCom webhook lifecycle', () => {
  function stall() {
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error(WEBHOOK_URL)),
            { once: true },
          );
        }),
    );
  }

  it('does not become ready after disconnect interrupts startup', async () => {
    const { channel } = make();
    const connecting = channel.connect();
    channel.disconnect();
    await expect(connecting).rejects.toMatchObject({
      disposition: 'permanent',
      message: 'WeCom webhook connection was cancelled.',
    });
    await expect(channel.sendMessage('default', 'text')).rejects.toMatchObject({
      disposition: 'permanent',
      message: 'WeCom webhook Channel is not ready.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires readiness and aborts an actual pending request at its timeout', async () => {
    vi.useFakeTimers();
    const { channel } = make();
    await expect(channel.sendMessage('default', 'text')).rejects.toMatchObject({
      disposition: 'permanent',
      message: 'WeCom webhook Channel is not ready.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await channel.connect();
    stall();
    const pending = channel.deliverProactive(TARGET, 'text');
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(14_999);
    const signal = fetchMock.mock.calls[0]![1]?.signal;
    expect(signal?.aborted).toBe(false);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      disposition: 'transient',
      message:
        'WeCom webhook request timed out; delivery may have been accepted.',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    'only cancels and drains the pending request after another settles (success=%s)',
    async (success) => {
      const { channel } = make();
      fetchMock.mockResolvedValueOnce(
        Response.json({ errcode: success ? 0 : 93000 }),
      );
      let release!: () => void;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            release = () => reject(new Error(WEBHOOK_URL));
          }),
      );
      await channel.connect();
      const first = channel.sendMessage('default', 'first');
      const second = expect(
        channel.sendMessage('default', 'second'),
      ).rejects.toThrow('cancelled');
      try {
        if (success) {
          await first;
        } else {
          await expect(first).rejects.toThrow('code 93000');
        }
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const firstSignal = fetchMock.mock.calls[0]![1]?.signal;
        const secondSignal = fetchMock.mock.calls[1]![1]?.signal;
        expect(firstSignal?.aborted).toBe(false);
        expect(secondSignal?.aborted).toBe(false);

        channel.disconnect();
        let drained = false;
        const drain = channel.waitForDisconnect().then(() => {
          drained = true;
        });
        expect(firstSignal?.aborted).toBe(false);
        expect(secondSignal?.aborted).toBe(true);
        await new Promise(setImmediate);
        expect(drained).toBe(false);
        release();
        await second;
        await drain;
        expect(drained).toBe(true);
      } finally {
        release();
        await Promise.allSettled([first, second]);
      }
    },
  );

  it('keeps reconnect pending until the previous lifecycle has drained', async () => {
    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((_resolve, reject) => {
          release = () => reject(new Error(WEBHOOK_URL));
        }),
    );
    const { channel } = make();
    await channel.connect();
    const pending = expect(
      channel.sendMessage('default', 'before disconnect'),
    ).rejects.toMatchObject({
      disposition: 'transient',
      message:
        'WeCom webhook request cancelled; delivery may have been accepted.',
    });
    channel.disconnect();
    let connected = false;
    const reconnect = channel.connect().then(() => {
      connected = true;
    });
    try {
      await new Promise(setImmediate);
      expect(connected).toBe(false);
      await expect(
        channel.sendMessage('default', 'during drain'),
      ).rejects.toMatchObject({
        disposition: 'permanent',
        message: 'WeCom webhook Channel is not ready.',
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      release();
      await Promise.all([pending, reconnect]);
    }
    expect(connected).toBe(true);
    await channel.sendMessage('default', 'after drain');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels and drains concurrent sends on disconnect, then can reconnect', async () => {
    const { channel } = make();
    await channel.connect();
    const releases: Array<() => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((_resolve, reject) => {
          releases.push(() => reject(new Error(WEBHOOK_URL)));
        }),
    );
    const first = expect(
      channel.deliverProactive(TARGET, 'first'),
    ).rejects.toThrow('cancelled');
    const second = expect(
      channel.deliverProactive(TARGET, 'second'),
    ).rejects.toThrow('cancelled');
    channel.disconnect();
    let drained = false;
    const drain = channel.waitForDisconnect().then(() => {
      drained = true;
    });
    try {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(
        fetchMock.mock.calls.every(([, options]) => options?.signal?.aborted),
      ).toBe(true);
      await new Promise(setImmediate);
      expect(drained).toBe(false);
      releases[0]!();
      await first;
      await new Promise(setImmediate);
      expect(drained).toBe(false);
    } finally {
      for (const release of releases) release();
      await Promise.all([first, second, drain]);
    }
    expect(drained).toBe(true);
    await expect(channel.sendMessage('default', 'text')).rejects.toThrow(
      'not ready',
    );
    fetchMock.mockResolvedValueOnce(Response.json({ errcode: 0 }));
    await channel.connect();
    await channel.deliverProactive(TARGET, 'after reconnect');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
