/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChannelPlugin } from '@qwen-code/channel-base';
import {
  DINGTALK_WEBHOOK_DELIVERY_TARGET_ID,
  DingtalkWebhookChannel,
  parseDingtalkWebhookConfig,
} from './DingtalkWebhookChannel.js';

export const webhookPlugin: ChannelPlugin = {
  channelType: 'dingtalk-webhook',
  displayName: 'DingTalk Webhook',
  requiredConfigFields: ['webhookUrl'],
  envResolvableConfigFields: ['signingSecret'],
  outboundOnly: true,
  defaultDeliveryTarget: {
    type: 'chat',
    id: DINGTALK_WEBHOOK_DELIVERY_TARGET_ID,
    label: 'Configured group',
  },
  management: {
    fields: [
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
    ],
    validateConfig: (config) => {
      try {
        const webhookUrl = config['webhookUrl'];
        parseDingtalkWebhookConfig({
          ...config,
          webhookUrl:
            typeof webhookUrl === 'string' &&
            /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(webhookUrl)
              ? 'https://oapi.dingtalk.com/robot/send?access_token=environment'
              : webhookUrl,
        });
        return undefined;
      } catch (error) {
        return error instanceof Error
          ? error.message
          : 'Invalid DingTalk webhook configuration.';
      }
    },
  },
  createChannel: (name, config, bridge, options) =>
    new DingtalkWebhookChannel(name, config, bridge, options),
};
