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
import { plugin, webhookPlugin } from './index.js';
import { FeishuWebhookChannel } from './FeishuWebhookChannel.js';

describe('Feishu webhook plugin', () => {
  it('declares an independent sending mode with secret configuration', () => {
    expect(webhookPlugin.channelType).toBe('feishu-webhook');
    expect(webhookPlugin.outboundOnly).toBe(true);
    expect(webhookPlugin.defaultDeliveryTarget).toEqual({
      type: 'chat',
      id: 'default',
      label: 'Configured group',
    });
    expect(webhookPlugin.requiredConfigFields).toEqual(['webhookUrl']);
    expect(webhookPlugin.envResolvableConfigFields).toContain('signingSecret');
    expect(webhookPlugin.management?.fields).toEqual([
      {
        key: 'webhookUrl',
        label: 'Webhook URL',
        kind: 'secret',
        required: true,
        envResolvable: true,
      },
      {
        key: 'signingSecret',
        label: 'Signing Secret',
        kind: 'secret',
        envResolvable: true,
      },
    ]);
    expect(plugin.requiredConfigFields).toEqual(['clientId', 'clientSecret']);
    expect(plugin.channelType).toBe('feishu');
  });

  it('allows environment-backed values while validating literal endpoint configuration', () => {
    const validate = webhookPlugin.management!.validateConfig!;
    expect(
      validate({
        webhookUrl: '$FEISHU_WEBHOOK',
        signingSecret: '$FEISHU_SIGNING_SECRET',
      }),
    ).toBeUndefined();
    expect(
      validate({
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/token',
      }),
    ).toBeUndefined();
    expect(validate({ webhookUrl: '' })).toMatch(/^Feishu webhook URL must/);
    expect(
      validate({ webhookUrl: 'https://other.test/private-token' }),
    ).toMatch(/^Feishu webhook URL must/);
    expect(validate({ webhookUrl: '$FEISHU_WEBHOOK', signingSecret: '' })).toBe(
      'Feishu signing secret must be a non-empty string without surrounding whitespace.',
    );
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
        'https://open.feishu.cn/open-apis/bot/v2/hook/factory-token';
      const config: ChannelConfig & Record<string, unknown> = {
        type: 'feishu-webhook',
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
        .mockImplementation(async () => Response.json({ code: 0 }));
      vi.stubGlobal('fetch', fetchMock);
      let channel: ReturnType<typeof webhookPlugin.createChannel> | undefined;
      try {
        channel = webhookPlugin.createChannel(
          'factory-robot',
          config,
          bridge as unknown as ChannelAgentBridge,
          { registerBridgeEvents },
        );
        expect(channel).toBeInstanceOf(FeishuWebhookChannel);
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
          msg_type: 'interactive',
          card: {
            schema: '2.0',
            body: {
              elements: [{ tag: 'markdown', content: 'Factory delivery' }],
            },
          },
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
