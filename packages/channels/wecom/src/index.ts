export { WeComChannel } from './WeComAdapter.js';

import { WeComChannel } from './WeComAdapter.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'wecom',
  displayName: 'WeCom',
  requiredConfigFields: ['botId', 'secret'],
  createChannel: (name, config, bridge, options) =>
    new WeComChannel(name, config, bridge, options),
};
