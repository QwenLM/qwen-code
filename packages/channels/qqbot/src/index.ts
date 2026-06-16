export { QQChannel } from './QQChannel.js';

import { QQChannel } from './QQChannel.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'qq',
  displayName: 'QQ',
  createChannel: (name, config, bridge, options) =>
    new QQChannel(name, config, bridge, options),
};
