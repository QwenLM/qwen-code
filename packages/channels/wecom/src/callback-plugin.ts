import type { ChannelPlugin } from '@qwen-code/channel-base';
import {
  parseCallbackConfig,
  WeComCallbackChannel,
} from './wecom-callback-adapter.js';

export const callbackPlugin: ChannelPlugin = {
  channelType: 'wecom-callback',
  displayName: 'WeCom Callback',
  requiredConfigFields: [
    'corpId',
    'agentId',
    'corpSecret',
    'token',
    'encodingAESKey',
  ],
  envResolvableConfigFields: ['webhookHost'],
  management: {
    fields: [
      {
        key: 'corpId',
        label: 'Corp ID',
        kind: 'string',
        required: true,
        envResolvable: true,
      },
      {
        key: 'agentId',
        label: 'Agent ID',
        kind: 'string',
        required: true,
        envResolvable: true,
      },
      {
        key: 'corpSecret',
        label: 'App Secret',
        kind: 'secret',
        required: true,
        envResolvable: true,
      },
      {
        key: 'token',
        label: 'Callback Token',
        kind: 'secret',
        required: true,
        envResolvable: true,
      },
      {
        key: 'encodingAESKey',
        label: 'EncodingAESKey',
        kind: 'secret',
        required: true,
        envResolvable: true,
      },
      {
        key: 'webhookHost',
        label: 'Webhook Host',
        kind: 'string',
        envResolvable: true,
        default: '127.0.0.1',
      },
      {
        key: 'webhookPort',
        label: 'Webhook Port',
        kind: 'number',
        default: '8645',
        exclusiveMinimum: 0,
      },
    ],
    validateConfig: (config) => {
      try {
        const probe = { ...config };
        for (const [field, placeholder] of Object.entries({
          agentId: '1',
          encodingAESKey: 'A'.repeat(43),
        })) {
          const value = probe[field];
          if (
            typeof value === 'string' &&
            /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)
          ) {
            // Environment values receive full validation when the channel starts.
            probe[field] = placeholder;
          }
        }
        parseCallbackConfig(probe);
        return undefined;
      } catch (error) {
        return error instanceof Error
          ? error.message
          : 'Invalid WeCom Callback configuration';
      }
    },
  },
  createChannel: (name, config, bridge, options) =>
    new WeComCallbackChannel(name, config, bridge, options),
};
