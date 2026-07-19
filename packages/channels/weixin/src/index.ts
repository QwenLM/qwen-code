export { WeixinChannel } from './WeixinAdapter.js';

import { WeixinChannel } from './WeixinAdapter.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'weixin',
  displayName: 'WeChat',
  management: {
    fields: [],
    auth: ['qr'],
  },
  createChannel: (name, config, bridge, options) =>
    new WeixinChannel(name, config, bridge, options),
};
