export { WeixinChannel } from './WeixinAdapter.js';

import { WeixinChannel } from './WeixinAdapter.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'weixin',
  displayName: 'WeChat',
  management: {
    fields: [
      // No `baseUrl` here on purpose. `connect()` replaces the configured root
      // with the one stored at login, and both login paths always store one, so
      // an editor field for it would promise an override that can never reach a
      // request. Exposing it needs the adapter's precedence fixed first.
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
