export { WeComChannel } from './WeComAdapter.js';
export { WeComCallbackChannel } from './wecom-callback-adapter.js';
export { callbackPlugin } from './callback-plugin.js';

import { WeComChannel } from './WeComAdapter.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'wecom',
  displayName: 'WeCom',
  requiredConfigFields: ['botId', 'secret'],
  envResolvableConfigFields: ['wsUrl'],
  management: {
    fields: [
      {
        key: 'botId',
        label: 'Bot ID',
        kind: 'string',
        required: true,
        envResolvable: true,
      },
      {
        key: 'secret',
        label: 'Bot Secret',
        kind: 'secret',
        required: true,
        envResolvable: true,
      },
      {
        key: 'wsUrl',
        label: 'WebSocket URL',
        kind: 'string',
        envResolvable: true,
      },
    ],
  },
  createChannel: (name, config, bridge, options) =>
    new WeComChannel(name, config, bridge, options),
};
