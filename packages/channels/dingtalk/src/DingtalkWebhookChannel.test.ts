/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelAgentBridge,
  ChannelConfig,
  SessionTarget,
} from '@qwen-code/channel-base';
import {
  DingtalkWebhookChannel,
  parseDingtalkWebhookConfig,
} from './DingtalkWebhookChannel.js';

const WEBHOOK_URL =
  'https://oapi.dingtalk.com/robot/send?access_token=private-token';
const SIGNING_SECRET = 'SEC-test-signing-secret';
const TARGET = { channelName: 'robot', type: 'chat' as const, id: 'default' };

class TestChannel extends DingtalkWebhookChannel {
  accepts(target: SessionTarget, source: 'delivery' | 'loop' | 'webhook') {
    if (source === 'delivery')
      return this.supportsProactiveDeliveryTarget(target);
    if (source === 'loop') return this.supportsProactiveTarget(target);
    return this.supportsProactiveWebhookTarget(target);
  }
}

const channels: DingtalkWebhookChannel[] = [];
const fetchMock = vi.fn<typeof fetch>();

function make(extra: Record<string, unknown> = {}) {
  const bridge = Object.assign(new EventEmitter(), {
    newSession: vi.fn(),
    prompt: vi.fn(),
    loadSession: vi.fn(),
  });
  const config: ChannelConfig & Record<string, unknown> = {
    type: 'dingtalk-webhook',
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

describe('DingTalk webhook configuration', () => {
  it.each([
    undefined,
    '',
    ` ${WEBHOOK_URL}`,
    `${WEBHOOK_URL}\n`,
    '$UNRESOLVED_URL',
    'https://oapi.dingtalk.com/robot/send',
    'https://oapi.dingtalk.com/robot/send?access_token=',
    'https://oapi.dingtalk.com/robot/send?access_token=%20',
    'https://oapi.dingtalk.com/robot/send?access_token=%09%20',
    'https://oapi.dingtalk.com/robot/send?access_token=a&access_token=b',
    'https://oapi.dingtalk.com/robot/send?access_token=a&sign=stale',
    'https://oapi.dingtalk.com/robot/send?access_token=a#fragment',
    'http://oapi.dingtalk.com/robot/send?access_token=private-token',
    'https://oapi.dingtalk.com.evil.test/robot/send?access_token=private-token',
    'https://oapi.dingtalk.com:444/robot/send?access_token=private-token',
    'https://user:password@oapi.dingtalk.com/robot/send?access_token=private-token',
    'https://oapi.dingtalk.com/other?access_token=private-token',
  ])(
    'rejects invalid endpoints without exposing their value (%s)',
    (webhookUrl) => {
      expect(() => parseDingtalkWebhookConfig({ webhookUrl })).toThrow(
        /^DingTalk webhook URL must be https:\/\/oapi\.dingtalk\.com\/robot\/send with one access_token parameter\.$/,
      );
    },
  );

  it.each(['', '   ', ' secret ', `${SIGNING_SECRET}\n`, 42, null])(
    'rejects an invalid optional signing secret',
    (signingSecret) => {
      expect(() =>
        parseDingtalkWebhookConfig({ webhookUrl: WEBHOOK_URL, signingSecret }),
      ).toThrow(
        'DingTalk signing secret must be a non-empty string without surrounding whitespace.',
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

describe('DingTalk webhook delivery', () => {
  it.each([
    {
      errcode: 0,
      text: '完成报告 😀\nsecond line',
      title: '完成报告 😀',
    },
    {
      errcode: '0',
      text: '## Daily report\n\n**Completed**\n> Summary\n[Details](https://example.com/report)',
      title: 'Daily report',
    },
  ])(
    'sends Markdown through the real proactive boundary ($errcode)',
    async ({ errcode, text, title }) => {
      const { channel, bridge } = make();
      fetchMock.mockResolvedValueOnce(Response.json({ errcode, errmsg: 'ok' }));
      await channel.connect();
      await channel.deliverProactive(TARGET, text);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, request] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe(WEBHOOK_URL);
      expect(request).toMatchObject({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { title, text },
        }),
      });
      expect(request?.signal).toBeInstanceOf(AbortSignal);
      expect(bridge.newSession).not.toHaveBeenCalled();
      expect(bridge.prompt).not.toHaveBeenCalled();
    },
  );

  it('signs each request with fresh millisecond timestamp and query encoding', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_123);
    const { channel } = make({ signingSecret: SIGNING_SECRET });
    await channel.connect();
    await channel.deliverProactive(TARGET, 'first');
    vi.setSystemTime(1_700_000_000_124);
    await channel.deliverProactive(TARGET, 'second');
    const first = new URL(String(fetchMock.mock.calls[0]![0]));
    const second = new URL(String(fetchMock.mock.calls[1]![0]));
    for (const url of [first, second]) {
      expect([...url.searchParams.keys()].sort()).toEqual([
        'access_token',
        'sign',
        'timestamp',
      ]);
      expect(url.searchParams.get('access_token')).toBe('private-token');
      expect(url.href).not.toContain(SIGNING_SECRET);
    }
    expect(first.searchParams.get('timestamp')).toBe('1700000000123');
    expect(first.searchParams.get('sign')).toBe(
      'C5cuHoQaMOGsCAIKR0GjupkFPEbOu7QC42oH2qVvkkc=',
    );
    expect(first.href).toContain('%3D');
    expect(second.searchParams.get('timestamp')).toBe('1700000000124');
    expect(second.searchParams.get('sign')).not.toBe(
      first.searchParams.get('sign'),
    );
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
    [310000, 'permanent'],
    ['410100', 'transient'],
    [-1, 'transient'],
  ])(
    'rejects business code %s without exposing provider text',
    async (errcode, disposition) => {
      const { channel } = make();
      fetchMock.mockResolvedValueOnce(
        Response.json({
          errcode,
          errmsg: `${WEBHOOK_URL} ${SIGNING_SECRET} message-body`,
        }),
      );
      await channel.connect();
      const result = channel.deliverProactive(TARGET, 'message-body');
      await expect(result).rejects.toMatchObject({
        disposition,
        message: `DingTalk webhook rejected the message (code ${errcode}).`,
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
      fetchMock.mockResolvedValueOnce(
        new Response(`${WEBHOOK_URL} ${SIGNING_SECRET}`, { status }),
      );
      await channel.connect();
      await expect(
        channel.deliverProactive(TARGET, 'message'),
      ).rejects.toMatchObject({
        disposition,
        message: `DingTalk webhook request failed (HTTP ${status}).`,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each([
    'not-json',
    'null',
    '[]',
    '{}',
    '{"errcode":false}',
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
      message: 'DingTalk webhook returned an invalid response.',
    });
  });

  it('bounds response reading and cancels an oversized body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const prefix = new TextEncoder().encode(
          `${WEBHOOK_URL} ${SIGNING_SECRET}`,
        );
        controller.enqueue(prefix);
        controller.enqueue(new Uint8Array(16_385 - prefix.byteLength));
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
        'DingTalk webhook request failed or returned an invalid response; delivery may have been accepted.',
    });
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not truncate outgoing text or expose a transport exception', async () => {
    const text = 'x'.repeat(25_000);
    fetchMock.mockRejectedValueOnce(
      new Error(`${WEBHOOK_URL} ${SIGNING_SECRET} ${text}`),
    );
    const { channel } = make();
    await channel.connect();
    const result = channel.deliverProactive(TARGET, text);
    await expect(result).rejects.toMatchObject({
      message:
        'DingTalk webhook request failed or returned an invalid response; delivery may have been accepted.',
    });
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).markdown.text,
    ).toBe(text);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('DingTalk webhook lifecycle', () => {
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
    await expect(connecting).rejects.toThrow('connection was cancelled');
    await expect(channel.sendMessage('default', 'text')).rejects.toThrow(
      'not ready',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires readiness and aborts an actual pending request at its timeout', async () => {
    vi.useFakeTimers();
    const { channel } = make();
    await expect(channel.sendMessage('default', 'text')).rejects.toThrow(
      'not ready',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await channel.connect();
    stall();
    const result = expect(
      channel.deliverProactive(TARGET, 'text'),
    ).rejects.toThrow('timed out; delivery may have been accepted');
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
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
