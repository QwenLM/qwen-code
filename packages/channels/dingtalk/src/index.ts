export { DingtalkChannel } from './DingtalkAdapter.js';
export { downloadMedia } from './media.js';

import { DingtalkChannel } from './DingtalkAdapter.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';
import { DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM } from './interactive-card-types.js';

export const plugin: ChannelPlugin = {
  channelType: 'dingtalk',
  displayName: 'DingTalk',
  requiredConfigFields: ['clientId', 'clientSecret'],
  management: {
    fields: [
      {
        key: 'clientId',
        label: 'Client ID',
        kind: 'string',
        required: true,
        envResolvable: true,
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        kind: 'secret',
        required: true,
        envResolvable: true,
      },
      {
        key: 'interactiveCards',
        label: 'Interactive Cards',
        kind: 'object',
        properties: [
          {
            key: 'enabled',
            label: 'Enabled',
            kind: 'boolean',
          },
          {
            key: 'statusCard',
            label: 'Status Card',
            kind: 'object',
            properties: [
              {
                key: 'enabled',
                label: 'Enabled',
                kind: 'boolean',
              },
            ],
          },
          {
            key: 'questionCard',
            label: 'Question Card',
            kind: 'object',
            properties: [
              {
                key: 'enabled',
                label: 'Enabled',
                kind: 'boolean',
              },
              {
                key: 'timeoutMs',
                label: 'Timeout (ms)',
                kind: 'number',
                exclusiveMinimum:
                  DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM,
              },
            ],
          },
          {
            key: 'permissionCard',
            label: 'Permission Card',
            kind: 'object',
            properties: [
              {
                key: 'enabled',
                label: 'Enabled',
                kind: 'boolean',
              },
              {
                key: 'timeoutMs',
                label: 'Timeout (ms)',
                kind: 'number',
                exclusiveMinimum:
                  DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM,
              },
            ],
          },
        ],
      },
    ],
  },
  createChannel: (name, config, bridge, options) =>
    new DingtalkChannel(name, config, bridge, options),
};
