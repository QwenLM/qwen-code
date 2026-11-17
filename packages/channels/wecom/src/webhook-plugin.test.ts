/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type {
  ChannelAgentBridge,
  ChannelConfig,
} from '@qwen-code/channel-base';
import { describe, expect, it, vi } from 'vitest';
import { plugin, callbackPlugin, webhookPlugin } from './index.js';
import { WeComWebhookChannel } from './WeComWebhookChannel.js';

describe('WeCom webhook plugin', () => {
  it('declares an independent sending mode with secret configuration', () => {
    expect(webhookPlugin.channelType).toBe('wecom-webhook');
    expect(webhookPlugin.outboundOnly).toBe(true);
    expect(webhookPlugin.defaultDeliveryTarget).toEqual({
      type: 'chat',
      id: 'default',
      label: 'Configured group',
    });
    expect(webhookPlugin.requiredConfigFields).toEqual(['webhookUrl']);
    expect(webhookPlugin.envResolvableConfigFields).toBeUndefined();
    expect(webhookPlugin.management?.fields).toEqual([
      {
        key: 'webhookUrl',
        label: 'Webhook URL',
        kind: 'secret',
        required: true,
        envResolvable: true,
      },
    ]);
    expect(plugin.requiredConfigFields).toEqual(['botId', 'secret']);
    expect(plugin.channelType).toBe('wecom');
    expect(callbackPlugin.channelType).toBe('wecom-callback');
    expect(callbackPlugin.outboundOnly).not.toBe(true);
  });

  it('allows environment-backed values while validating literal endpoint configuration', () => {
    const validate = webhookPlugin.management!.validateConfig!;
    expect(
      validate({
        webhookUrl: '$WECOM_WEBHOOK',
      }),
    ).toBeUndefined();
    expect(
      validate({
        webhookUrl:
          'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=token',
      }),
    ).toBeUndefined();
    expect(validate({ webhookUrl: '' })).toMatch(/^WeCom webhook URL must/);
    expect(
      validate({ webhookUrl: 'https://other.test/private-token' }),
    ).toMatch(/^WeCom webhook URL must/);
    for (const webhookUrl of ['$INVALID-ENV', '$WECOM_WEBHOOK\n']) {
      expect(validate({ webhookUrl })).toMatch(/^WeCom webhook URL must/);
    }
  });

  it.each([true, false])(
    'creates a working webhook adapter with registerBridgeEvents=%s',
    async (registerBridgeEvents) => {
      const bridge = Object.assign(new EventEmitter(), {
        newSession: vi.fn(),
        prompt: vi.fn(),
        loadSession: vi.fn(),
      });
      const webhookUrl =
        'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=factory-token';
      const config: ChannelConfig & Record<string, unknown> = {
        type: 'wecom-webhook',
        token: '',
        privatePolicy: 'disabled',
        groupPolicy: 'disabled',
        allowedUsers: [],
        groups: {},
        sessionScope: 'user',
        cwd: process.cwd(),
        webhookUrl,
      };
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => Response.json({ errcode: 0 }));
      vi.stubGlobal('fetch', fetchMock);
      let channel: ReturnType<typeof webhookPlugin.createChannel> | undefined;
      try {
        channel = webhookPlugin.createChannel(
          'factory-robot',
          config,
          bridge as unknown as ChannelAgentBridge,
          { registerBridgeEvents },
        );
        expect(channel).toBeInstanceOf(WeComWebhookChannel);
        expect(bridge.listenerCount('backgroundResponse')).toBe(
          registerBridgeEvents ? 1 : 0,
        );
        await channel.connect();
        const { type, id } = webhookPlugin.defaultDeliveryTarget!;
        await channel.deliverProactive(
          { channelName: 'factory-robot', type, id },
          'Factory delivery',
        );
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, request] = fetchMock.mock.calls[0]!;
        expect(String(url)).toBe(webhookUrl);
        expect(JSON.parse(String(request?.body))).toEqual({
          msgtype: 'markdown_v2',
          markdown_v2: { content: 'Factory delivery' },
        });
        expect(bridge.newSession).not.toHaveBeenCalled();
        expect(bridge.prompt).not.toHaveBeenCalled();
      } finally {
        await channel?.disconnect();
        await channel?.waitForDisconnect();
        bridge.removeAllListeners();
        vi.unstubAllGlobals();
      }
    },
  );
});
