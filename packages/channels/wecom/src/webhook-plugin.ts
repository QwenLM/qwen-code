/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChannelPlugin } from '@qwen-code/channel-base';
import {
  WECOM_WEBHOOK_DELIVERY_TARGET_ID,
  WeComWebhookChannel,
  parseWeComWebhookConfig,
} from './WeComWebhookChannel.js';

export const webhookPlugin: ChannelPlugin = {
  channelType: 'wecom-webhook',
  displayName: 'WeCom Webhook',
  requiredConfigFields: ['webhookUrl'],
  outboundOnly: true,
  defaultDeliveryTarget: {
    type: 'chat',
    id: WECOM_WEBHOOK_DELIVERY_TARGET_ID,
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
    ],
    validateConfig: (config) => {
      try {
        const webhookUrl = config['webhookUrl'];
        parseWeComWebhookConfig({
          ...config,
          webhookUrl:
            typeof webhookUrl === 'string' &&
            webhookUrl === webhookUrl.trim() &&
            /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(webhookUrl)
              ? 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=environment'
              : webhookUrl,
        });
        return undefined;
      } catch (error) {
        return error instanceof Error
          ? error.message
          : 'Invalid WeCom webhook configuration.';
      }
    },
  },
  createChannel: (name, config, bridge, options) =>
    new WeComWebhookChannel(name, config, bridge, options),
};
