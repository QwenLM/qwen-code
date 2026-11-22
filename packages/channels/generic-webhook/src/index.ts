/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChannelPlugin } from '@qwen-code/channel-base';
import { parseGenericWebhookConfig } from './config.js';
import {
  GENERIC_WEBHOOK_DELIVERY_TARGET_ID,
  GenericWebhookChannel,
} from './generic-webhook-channel.js';

export { GenericWebhookChannel } from './generic-webhook-channel.js';

export const plugin: ChannelPlugin = {
  channelType: 'generic-webhook',
  displayName: 'Generic Webhook',
  requiredConfigFields: ['webhookUrl'],
  envResolvableConfigFields: ['bearerToken'],
  outboundOnly: true,
  defaultDeliveryTarget: {
    type: 'chat',
    id: GENERIC_WEBHOOK_DELIVERY_TARGET_ID,
    label: 'Configured endpoint',
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
        key: 'bearerToken',
        label: 'Bearer token',
        kind: 'secret',
        envResolvable: true,
      },
      {
        key: 'allowPrivateNetwork',
        label: 'Allow local and private targets',
        kind: 'boolean',
        description:
          'Allow this configured receiver on local or private HTTP(S) addresses. Local refers to the machine running Qwen Code.',
      },
    ],
    validateConfig: (config) => {
      try {
        parseGenericWebhookConfig(config, true);
        return undefined;
      } catch (error) {
        return error instanceof Error
          ? error.message
          : 'Invalid generic webhook configuration.';
      }
    },
  },
  createChannel: (name, config, bridge, options) =>
    new GenericWebhookChannel(name, config, bridge, options),
};
