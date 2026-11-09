export { WeixinChannel } from './WeixinAdapter.js';

import { WeixinChannel } from './WeixinAdapter.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'weixin',
  displayName: 'WeChat',
  envResolvableConfigFields: ['baseUrl'],
  management: {
    fields: [
      {
        key: 'baseUrl',
        label: 'API Base URL',
        kind: 'string',
        envResolvable: true,
        description:
          'Override the iLink Bot API root. Leave empty to use https://ilinkai.weixin.qq.com',
      },
      {
        // The iLink Bot only ever produces direct messages, so the other three
        // policies would configure a mode the adapter can never reach.
        key: 'groupPolicy',
        label: 'Group Policy',
        kind: 'enum',
        required: true,
        default: 'disabled',
        description: 'WeChat iLink Bot is direct-message only',
        options: [{ value: 'disabled', label: 'Disabled' }],
      },
    ],
  },
  createChannel: (name, config, bridge, options) =>
    new WeixinChannel(name, config, bridge, options),
};
