/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { LookupFunction } from 'node:net';
import type {
  ChannelAgentBridge,
  ChannelConfig,
  SessionTarget,
} from '@qwen-code/channel-base';
import {
  NetworkPolicyError,
  resolveNetworkTarget,
} from '@qwen-code/network-policy';
import undici from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenericWebhookChannel } from './generic-webhook-channel.js';
import { plugin } from './index.js';

vi.mock('@qwen-code/network-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/network-policy')>()),
  resolveNetworkTarget: vi.fn(),
}));

const URL_VALUE = 'https://receiver.example/private-url?key=secret-value';
const TARGET = { channelName: 'reports', type: 'chat' as const, id: 'default' };
const channels: GenericWebhookChannel[] = [];
const lookup: LookupFunction = (_hostname, _options, callback) =>
  callback(null, '93.184.216.34', 4);
const resolveMock = vi.mocked(resolveNetworkTarget);

class InspectableChannel extends GenericWebhookChannel {
  accepts(target: SessionTarget, kind: 'delivery' | 'loop' | 'webhook') {
    if (kind === 'delivery')
      return this.supportsProactiveDeliveryTarget(target);
    if (kind === 'loop') return this.supportsProactiveTarget(target);
    return this.supportsProactiveWebhookTarget(target);
  }
}

function make(extra: Record<string, unknown> = {}) {
  const bridge = Object.assign(new EventEmitter(), {
    newSession: vi.fn(),
    prompt: vi.fn(),
    loadSession: vi.fn(),
  });
  const config: ChannelConfig & Record<string, unknown> = {
    type: 'generic-webhook',
    token: '',
    privatePolicy: 'disabled',
    groupPolicy: 'disabled',
    allowedUsers: [],
    groups: {},
    sessionScope: 'user',
    cwd: process.cwd(),
    webhookUrl: URL_VALUE,
    ...extra,
  };
  const channel = new InspectableChannel(
    'reports',
    config,
    bridge as unknown as ChannelAgentBridge,
  );
  channels.push(channel);
  return { channel, bridge, config };
}

beforeEach(() => {
  resolveMock.mockReset();
  resolveMock.mockResolvedValue({
    url: new URL(URL_VALUE),
    lookup,
    address: '93.184.216.34',
    family: 4,
    curlResolve: 'receiver.example:443:93.184.216.34',
  });
  vi.spyOn(undici, 'fetch').mockResolvedValue(
    new undici.Response(null, { status: 204 }),
  );
});

afterEach(async () => {
  for (const channel of channels.splice(0)) {
    channel.disconnect();
    await channel.waitForDisconnect();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('generic webhook delivery', () => {
  it('connects without network access, preserves text and only sends optional Bearer authentication', async () => {
    const { channel, bridge } = make({ bearerToken: 'valid-token' });
    await channel.connect();
    expect(resolveMock).not.toHaveBeenCalled();
    expect(undici.fetch).not.toHaveBeenCalled();
    const text = '**完成 😀**\n| A | B |\n|---|---|\n| 1 | 2 |\n<@all>\n';
    await channel.deliverProactive(TARGET, text);
    expect(resolveMock).toHaveBeenCalledWith(
      URL_VALUE,
      'public',
      expect.any(AbortSignal),
    );
    expect(undici.fetch).toHaveBeenCalledOnce();
    const [url, request] = vi.mocked(undici.fetch).mock.calls[0]!;
    expect(String(url)).toBe(URL_VALUE);
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
    });
    expect(JSON.parse(String(request?.body))).toEqual({ version: 1, text });
    expect(bridge.newSession).not.toHaveBeenCalled();
    expect(bridge.prompt).not.toHaveBeenCalled();

    const anonymous = make().channel;
    await anonymous.connect();
    await anonymous.sendMessage('default', 'anonymous');
    expect(vi.mocked(undici.fetch).mock.lastCall?.[1]?.headers).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it.each([200, 201, 202, 204, 299])(
    'accepts HTTP %s without interpreting a body',
    async (status) => {
      const response = new undici.Response(
        status === 204 ? null : '{"code":1,"continue":true}',
        { status },
      );
      const json = vi.spyOn(response, 'json');
      vi.mocked(undici.fetch).mockResolvedValueOnce(response);
      const { channel } = make();
      await channel.connect();
      await expect(
        channel.deliverProactive(TARGET, 'result'),
      ).resolves.toBeUndefined();
      expect(json).not.toHaveBeenCalled();
    },
  );

  it('does not reverse acceptance when response cleanup fails', async () => {
    const response = new undici.Response('unused body', { status: 200 });
    vi.spyOn(response.body!, 'cancel').mockRejectedValue(
      new Error('private-url'),
    );
    vi.mocked(undici.fetch).mockResolvedValueOnce(response);
    const { channel } = make();
    await channel.connect();
    await expect(
      channel.sendMessage('default', 'result'),
    ).resolves.toBeUndefined();
  });

  it('bounds stalled cleanup by the total deadline without reversing acceptance', async () => {
    vi.useFakeTimers();
    const destroy = vi
      .spyOn(undici.Agent.prototype, 'destroy')
      .mockReturnValue(new Promise(() => {}));
    const { channel } = make();
    await channel.connect();
    let finished = false;
    const delivery = channel.sendMessage('default', 'result').then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(destroy).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await delivery;
    expect(finished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [400, 'permanent'],
    [401, 'permanent'],
    [408, 'transient'],
    [425, 'transient'],
    [429, 'transient'],
    [500, 'transient'],
    [503, 'transient'],
  ] as const)(
    'classifies HTTP %s without reading its body or retrying',
    async (status, disposition) => {
      vi.mocked(undici.fetch).mockResolvedValueOnce(
        new undici.Response(URL_VALUE, { status }),
      );
      const { channel } = make();
      await channel.connect();
      await expect(
        channel.sendMessage('default', 'result'),
      ).rejects.toMatchObject({
        disposition,
        message: `Generic webhook request failed (HTTP ${status}).`,
      });
      expect(undici.fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['controls', '\u0000'.repeat(100_000)],
    ['lone surrogates', '\ud800'.repeat(100_000)],
    ['Unicode', '完成😀'.repeat(25_000)],
  ])(
    'supports shared delivery-sized %s and counts the complete serialized UTF-8 body',
    async (_name, text) => {
      const { channel } = make();
      await channel.connect();
      await channel.sendMessage('default', text);
      const body = String(vi.mocked(undici.fetch).mock.lastCall?.[1]?.body);
      expect(JSON.parse(body)).toEqual({ version: 1, text });
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(655_360);
    },
  );

  it('accepts the exact serialized byte budget and rejects a larger request before DNS or fetch', async () => {
    const { channel } = make();
    await channel.connect();
    const text = 'x'.repeat(655_360 - 23);
    await channel.sendMessage('default', text);
    expect(
      Buffer.byteLength(
        String(vi.mocked(undici.fetch).mock.lastCall?.[1]?.body),
      ),
    ).toBe(655_360);
    resolveMock.mockClear();
    vi.mocked(undici.fetch).mockClear();
    await expect(
      channel.sendMessage('default', text + '中'),
    ).rejects.toMatchObject({
      disposition: 'permanent',
      message: 'Generic webhook request exceeds the 655,360-byte limit.',
    });
    expect(resolveMock).not.toHaveBeenCalled();
    expect(undici.fetch).not.toHaveBeenCalled();
  });

  it('only accepts its configured delivery target and requires readiness', async () => {
    const { channel } = make();
    await expect(channel.sendMessage('default', 'result')).rejects.toThrow(
      /not ready/,
    );
    await channel.connect();
    for (const target of [
      { ...TARGET, id: URL_VALUE },
      { ...TARGET, type: 'user' as const },
      { ...TARGET, channelName: 'other' },
    ]) {
      await expect(
        channel.deliverProactive(target, 'result'),
      ).rejects.toThrow();
    }
    const sessionTarget: SessionTarget = {
      channelName: 'reports',
      senderId: 'default',
      chatId: 'default',
      isGroup: true,
    };
    expect(channel.accepts(sessionTarget, 'delivery')).toBe(true);
    expect(
      channel.accepts({ ...sessionTarget, threadId: 'thread' }, 'delivery'),
    ).toBe(false);
    expect(channel.accepts(sessionTarget, 'loop')).toBe(false);
    expect(channel.accepts(sessionTarget, 'webhook')).toBe(false);
    await expect(channel.sendMessage('default', '  ')).rejects.toThrow();
    expect(undici.fetch).not.toHaveBeenCalled();
  });

  it('reports policy denial permanently and resolver failures transiently without sensitive diagnostics', async () => {
    const { channel } = make();
    await channel.connect();
    resolveMock.mockRejectedValueOnce(new NetworkPolicyError(URL_VALUE));
    await expect(
      channel.sendMessage('default', 'result'),
    ).rejects.toMatchObject({
      disposition: 'permanent',
      message:
        'Generic webhook destination is not permitted by its network policy.',
    });
    resolveMock.mockRejectedValueOnce(new Error(URL_VALUE));
    await expect(
      channel.sendMessage('default', 'result'),
    ).rejects.toMatchObject({
      disposition: 'transient',
      message:
        'Generic webhook request failed; delivery may have been accepted.',
    });
    expect(undici.fetch).not.toHaveBeenCalled();
  });

  it('includes DNS in the total deadline', async () => {
    vi.useFakeTimers();
    resolveMock.mockImplementationOnce(
      (_url, _policy, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), {
            once: true,
          });
        }),
    );
    const { channel } = make();
    await channel.connect();
    const delivery = channel.sendMessage('default', 'result');
    const assertion = expect(delivery).rejects.toMatchObject({
      disposition: 'transient',
      message:
        'Generic webhook request timed out; delivery may have been accepted.',
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(undici.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not resurrect a connect superseded by disconnect', async () => {
    const { channel } = make();
    const connecting = channel.connect();
    channel.disconnect();
    await expect(connecting).rejects.toThrow(/connection was cancelled/);
    await channel.waitForDisconnect();
    await expect(channel.sendMessage('default', 'result')).rejects.toThrow(
      /not ready/,
    );
    await channel.connect();
    await channel.sendMessage('default', 'result');
  });

  it.each([true, false])(
    'honors registerBridgeEvents=%s through the plugin factory',
    async (registerBridgeEvents) => {
      const { bridge, config } = make();
      bridge.removeAllListeners();
      const channel = plugin.createChannel(
        'reports',
        config,
        bridge as unknown as ChannelAgentBridge,
        { registerBridgeEvents },
      );
      channels.push(channel as GenericWebhookChannel);
      expect(bridge.listenerCount('backgroundResponse')).toBe(
        registerBridgeEvents ? 1 : 0,
      );
      await channel.connect();
      await channel.deliverProactive(TARGET, 'result');
    },
  );
});
