export { WeixinChannel } from './WeixinAdapter.js';
export { authDriver } from './login.js';

import { WeixinChannel } from './WeixinAdapter.js';
import { authDriver } from './login.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'weixin',
  displayName: 'WeChat',
  management: {
    fields: [],
    auth: ['qr'],
  },
  authDriver,
  createChannel: (name, config, bridge, options) =>
    new WeixinChannel(name, config, bridge, options),
};
