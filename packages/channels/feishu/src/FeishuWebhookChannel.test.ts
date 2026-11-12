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
  FeishuWebhookChannel,
  parseFeishuWebhookConfig,
} from './FeishuWebhookChannel.js';

const WEBHOOK_URL =
  'https://open.feishu.cn/open-apis/bot/v2/hook/private-token';
const SIGNING_SECRET = 'test-secret';
const TARGET = { channelName: 'robot', type: 'chat' as const, id: 'default' };

class TestChannel extends FeishuWebhookChannel {
  accepts(target: SessionTarget, source: 'delivery' | 'loop' | 'webhook') {
    if (source === 'delivery')
      return this.supportsProactiveDeliveryTarget(target);
    if (source === 'loop') return this.supportsProactiveTarget(target);
    return this.supportsProactiveWebhookTarget(target);
  }
}

const channels: FeishuWebhookChannel[] = [];
const fetchMock = vi.fn<typeof fetch>();
const realFetch = globalThis.fetch;

function make(extra: Record<string, unknown> = {}) {
  const bridge = Object.assign(new EventEmitter(), {
    newSession: vi.fn(),
    prompt: vi.fn(),
    loadSession: vi.fn(),
  });
  const config: ChannelConfig & Record<string, unknown> = {
    type: 'feishu-webhook',
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

function expectedPayload(
  content: string,
  signature?: { timestamp: string; sign: string },
) {
  return {
    msg_type: 'interactive',
    card: {
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content }] },
    },
    ...signature,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json({ code: 0 }));
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

describe('Feishu webhook configuration', () => {
  it.each([
    undefined,
    '',
    42,
    ' ' + WEBHOOK_URL,
    WEBHOOK_URL + '\n',
    '$UNRESOLVED_URL',
    'https://open.feishu.cn/open-apis/bot/v2/hook/',
    'https://open.feishu.cn/open-apis/bot/v2/hook/token/extra',
    'https://open.feishu.cn/open-apis/bot/v2/hook/token/',
    'https://open.feishu.cn/open-apis/bot/v2/hook/%20',
    'https://open.feishu.cn/open-apis/bot/v2/hook/%70rivate-token',
    'https://open.feishu.cn/open-apis/bot/v2/hook/token%2Fextra',
    'https://open.feishu.cn/open-apis/bot/v2/hook/token%0A',
    'https://open.feishu.cn/open-apis/bot/v2/hook/.',
    'https://open.feishu.cn/open-apis/bot/v2/hook/..',
    'https://open.fei\nshu.cn/open-apis/bot/v2/hook/private-token',
    'https://open.feishu.cn/open-apis/bot/v2/hook\\private-token',
    WEBHOOK_URL + '?',
    WEBHOOK_URL + '#',
    WEBHOOK_URL + '?timestamp=stale',
    WEBHOOK_URL + '#fragment',
    'http://open.feishu.cn/open-apis/bot/v2/hook/private-token',
    'https://open.feishu.cn.evil.test/open-apis/bot/v2/hook/private-token',
    'https://open.larksuite.com/open-apis/bot/v2/hook/private-token',
    'https://open.feishu.cn:444/open-apis/bot/v2/hook/private-token',
    'https://user:password@open.feishu.cn/open-apis/bot/v2/hook/private-token',
    'https://open.feishu.cn/open-apis/bot/hook/private-token',
    'https://open.feishu.cn/other/private-token',
  ])(
    'rejects invalid endpoints without exposing their value (%s)',
    (webhookUrl) => {
      expect(() => parseFeishuWebhookConfig({ webhookUrl })).toThrow(
        /^Feishu webhook URL must be https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/ with one URL-safe token path segment\.$/,
      );
    },
  );

  it('accepts a URL-safe token without requiring an undocumented UUID shape', () => {
    const webhookUrl =
      'https://open.feishu.cn/open-apis/bot/v2/hook/Token_123.~-';
    expect(parseFeishuWebhookConfig({ webhookUrl }).webhookUrl.href).toBe(
      webhookUrl,
    );
  });

  it.each(['', '   ', ' secret ', `${SIGNING_SECRET}\n`, 42, null])(
    'rejects an invalid optional signing secret',
    (signingSecret) => {
      expect(() =>
        parseFeishuWebhookConfig({ webhookUrl: WEBHOOK_URL, signingSecret }),
      ).toThrow(
        'Feishu signing secret must be a non-empty string without surrounding whitespace.',
      );
    },
  );

  it('does not verify remote credentials or create a session while connecting', async () => {
    const { channel, bridge } = make();
    await channel.connect();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bridge.newSession).not.toHaveBeenCalled();
    expect(bridge.prompt).not.toHaveBeenCalled();
  });
});

describe('Feishu webhook delivery', () => {
  it.each([
    '完成报告 😀\nsecond line',
    '## Daily report\n\n**Completed**\n> Summary\n[Details](https://example.com/report)',
    '中'.repeat(4_000),
  ])(
    'sends a static Markdown card through the proactive boundary',
    async (text) => {
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
    },
  );

  it('keeps tables and surrounding text in one request with literal mentions', async () => {
    const { channel } = make();
    const text = [
      '**Result** <at id=all></at>',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      'After table',
    ].join('\n');
    await channel.connect();
    await channel.deliverProactive(TARGET, text);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      msg_type: 'interactive',
      card: {
        schema: '2.0',
        body: {
          elements: [
            {
              tag: 'markdown',
              content: '**Result** &#60;at id=all&#62;&#60;/at&#62;',
            },
            { tag: 'markdown', content: '| A | B |\n| --- | --- |\n| 1 | 2 |' },
            { tag: 'markdown', content: 'After table' },
          ],
        },
      },
    });
  });

  it.each([
    {
      timestamp: '1599360473',
      secret: 'test-secret',
      sign: 'wSds2BzzFIIGf/WrhUO+NI1q/9j+FRJd3JNHKAq0NZY=',
    },
    {
      timestamp: '1700000000',
      secret: '飞书-secret',
      sign: 'lUmB8m+S7VOLIZHF9rQzsIijqKEqJb5ra9uO6rvwCfE=',
    },
  ])(
    'signs the body with the independent seconds-based vector $timestamp',
    async ({ timestamp, secret, sign }) => {
      vi.useFakeTimers();
      vi.setSystemTime(Number(timestamp) * 1_000 + 987);
      const { channel } = make({ signingSecret: secret });
      await channel.connect();
      await channel.deliverProactive(TARGET, 'message');
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, request] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe(WEBHOOK_URL);
      expect(JSON.parse(String(request?.body))).toEqual(
        expectedPayload('message', { timestamp, sign }),
      );
      expect(String(request?.body)).not.toContain(secret);
    },
  );

  it('refreshes the seconds timestamp and signature on each send', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_599_360_473_999);
    const { channel } = make({ signingSecret: SIGNING_SECRET });
    await channel.connect();
    await channel.deliverProactive(TARGET, 'first');
    vi.setSystemTime(1_599_360_474_000);
    await channel.deliverProactive(TARGET, 'second');
    const first = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    const second = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body));
    expect(first.timestamp).toBe('1599360473');
    expect(second.timestamp).toBe('1599360474');
    expect(second.sign).not.toBe(first.sign);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    'enforces the complete serialized 20,000-byte local boundary (signed=%s)',
    async (signed) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_599_360_473_987);
      const signature = signed
        ? {
            timestamp: '1599360473',
            sign: 'wSds2BzzFIIGf/WrhUO+NI1q/9j+FRJd3JNHKAq0NZY=',
          }
        : undefined;
      const inputPrefix = '# 完成 😀\n"quoted"\\path\n<at id=all></at>\n';
      const literalPrefix =
        '# 完成 😀\n"quoted"\\path\n&#60;at id=all&#62;&#60;/at&#62;\n';
      const prefixBytes = Buffer.byteLength(
        JSON.stringify(expectedPayload(literalPrefix, signature)),
        'utf8',
      );
      const padding = 'x'.repeat(20_000 - prefixBytes);
      const input = inputPrefix + padding;
      const expected = expectedPayload(literalPrefix + padding, signature);
      expect(Buffer.byteLength(JSON.stringify(expected), 'utf8')).toBe(20_000);
      const { channel } = make(signed ? { signingSecret: SIGNING_SECRET } : {});
      await channel.connect();
      await channel.deliverProactive(TARGET, input);
      expect(fetchMock).toHaveBeenCalledOnce();
      const sent = String(fetchMock.mock.calls[0]![1]?.body);
      expect(Buffer.byteLength(sent, 'utf8')).toBe(20_000);
      expect(JSON.parse(sent)).toEqual(expected);

      fetchMock.mockClear();
      await expect(
        channel.deliverProactive(TARGET, input + 'x'),
      ).rejects.toMatchObject({
        disposition: 'permanent',
        message: 'Feishu webhook request exceeds the local 20,000-byte limit.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

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
    [9499, 'permanent'],
    [19024, 'permanent'],
    [19022, 'permanent'],
    [19021, 'permanent'],
    [11232, 'transient'],
    [-1, 'permanent'],
  ])(
    'rejects business code %s without exposing provider text',
    async (code, disposition) => {
      const { channel } = make();
      fetchMock.mockResolvedValueOnce(
        Response.json({
          code,
          msg: `${WEBHOOK_URL} ${SIGNING_SECRET} message-body`,
          StatusCode: 0,
        }),
      );
      await channel.connect();
      const result = channel.deliverProactive(TARGET, 'message-body');
      await expect(result).rejects.toMatchObject({
        disposition,
        message: `Feishu webhook rejected the message (code ${code}).`,
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
      const response = new Response(`${WEBHOOK_URL} ${SIGNING_SECRET}`, {
        status,
      });
      const cancel = vi.spyOn(response.body!, 'cancel');
      fetchMock.mockResolvedValueOnce(response);
      await channel.connect();
      await expect(
        channel.deliverProactive(TARGET, 'message'),
      ).rejects.toMatchObject({
        disposition,
        message: `Feishu webhook request failed (HTTP ${status}).`,
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
        location: `/redirect-target?secret=${SIGNING_SECRET}`,
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
          'Feishu webhook request failed or returned an invalid response; delivery may have been accepted.',
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
    '{"code":false}',
    '{"code":"0"}',
    '{"StatusCode":0,"StatusMessage":"success"}',
    '{"code":9007199254740992}',
    '{"code":1e309}',
    '{"code":0.5}',
    '{"code":"0-secret"}',
  ])('rejects malformed success responses (%s)', async (body) => {
    const { channel } = make();
    fetchMock.mockResolvedValueOnce(new Response(body));
    await channel.connect();
    await expect(
      channel.deliverProactive(TARGET, 'message'),
    ).rejects.toMatchObject({
      disposition: 'transient',
      message: 'Feishu webhook returned an invalid response.',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('accepts numeric success at the response byte limit', async () => {
    const { channel } = make();
    const body = JSON.stringify({ code: 0, StatusCode: 0 });
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
            JSON.stringify({ code: 0, msg: '中'.repeat(5_500) }),
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
        'Feishu webhook request failed or returned an invalid response; delivery may have been accepted.',
    });
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('bounds the cumulative response size across individually small chunks', async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ code: 0 }) + ' '.repeat(3 * 8_192),
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
        'Feishu webhook request failed or returned an invalid response; delivery may have been accepted.',
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not truncate outgoing text or expose a transport exception', async () => {
    const text = 'x'.repeat(10_000);
    fetchMock.mockRejectedValueOnce(
      new Error(`${WEBHOOK_URL} ${SIGNING_SECRET} ${text}`),
    );
    const { channel } = make();
    await channel.connect();
    const result = channel.deliverProactive(TARGET, text);
    await expect(result).rejects.toMatchObject({
      message:
        'Feishu webhook request failed or returned an invalid response; delivery may have been accepted.',
    });
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).card.body
        .elements[0].content,
    ).toBe(text);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('Feishu webhook lifecycle', () => {
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
      message: 'Feishu webhook connection was cancelled.',
    });
    await expect(channel.sendMessage('default', 'text')).rejects.toMatchObject({
      disposition: 'permanent',
      message: 'Feishu webhook Channel is not ready.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires readiness and aborts an actual pending request at its timeout', async () => {
    vi.useFakeTimers();
    const { channel } = make();
    await expect(channel.sendMessage('default', 'text')).rejects.toMatchObject({
      disposition: 'permanent',
      message: 'Feishu webhook Channel is not ready.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await channel.connect();
    stall();
    const result = expect(
      channel.deliverProactive(TARGET, 'text'),
    ).rejects.toMatchObject({
      disposition: 'transient',
      message:
        'Feishu webhook request timed out; delivery may have been accepted.',
    });
    await Promise.all([result, vi.advanceTimersByTimeAsync(15_000)]);
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    'only cancels and drains the pending request after another settles (success=%s)',
    async (success) => {
      const { channel } = make();
      fetchMock.mockResolvedValueOnce(
        Response.json({ code: success ? 0 : 19024 }),
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
          await expect(first).rejects.toThrow('code 19024');
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
        'Feishu webhook request cancelled; delivery may have been accepted.',
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
        message: 'Feishu webhook Channel is not ready.',
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
    fetchMock.mockResolvedValueOnce(Response.json({ code: 0 }));
    await channel.connect();
    await channel.deliverProactive(TARGET, 'after reconnect');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
