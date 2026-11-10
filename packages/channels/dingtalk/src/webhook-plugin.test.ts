/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { plugin, webhookPlugin } from './index.js';

describe('DingTalk webhook plugin', () => {
  it('declares an independent sending mode with secret configuration', () => {
    expect(webhookPlugin.channelType).toBe('dingtalk-webhook');
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
    expect(plugin.channelType).toBe('dingtalk');
  });

  it('allows environment-backed values while validating literal endpoint configuration', () => {
    const validate = webhookPlugin.management!.validateConfig!;
    expect(
      validate({
        webhookUrl: '$DINGTALK_WEBHOOK',
        signingSecret: '$DINGTALK_SIGNING_SECRET',
      }),
    ).toBeUndefined();
    expect(
      validate({
        webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=token',
      }),
    ).toBeUndefined();
    expect(validate({ webhookUrl: '' })).toMatch(/^DingTalk webhook URL must/);
    expect(
      validate({ webhookUrl: 'https://other.test/private-token' }),
    ).toMatch(/^DingTalk webhook URL must/);
    expect(
      validate({ webhookUrl: '$DINGTALK_WEBHOOK', signingSecret: '' }),
    ).toBe('DingTalk signing secret must be a non-empty string.');
  });
});
