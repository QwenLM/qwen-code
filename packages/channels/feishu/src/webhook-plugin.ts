/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChannelPlugin } from '@qwen-code/channel-base';
import {
  FEISHU_WEBHOOK_DELIVERY_TARGET_ID,
  FeishuWebhookChannel,
  parseFeishuWebhookConfig,
} from './FeishuWebhookChannel.js';

export const webhookPlugin: ChannelPlugin = {
  channelType: 'feishu-webhook',
  displayName: 'Feishu Webhook',
  requiredConfigFields: ['webhookUrl'],
  envResolvableConfigFields: ['signingSecret'],
  outboundOnly: true,
  defaultDeliveryTarget: {
    type: 'chat',
    id: FEISHU_WEBHOOK_DELIVERY_TARGET_ID,
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
        parseFeishuWebhookConfig({
          ...config,
          webhookUrl:
            typeof webhookUrl === 'string' &&
            /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(webhookUrl)
              ? 'https://open.feishu.cn/open-apis/bot/v2/hook/environment'
              : webhookUrl,
        });
        return undefined;
      } catch (error) {
        return error instanceof Error
          ? error.message
          : 'Invalid Feishu webhook configuration.';
      }
    },
  },
  createChannel: (name, config, bridge, options) =>
    new FeishuWebhookChannel(name, config, bridge, options),
};
