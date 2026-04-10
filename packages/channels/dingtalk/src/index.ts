export { DingtalkChannel } from './DingtalkAdapter.js';
export { downloadMedia } from './media.js';

import { DingtalkChannel } from './DingtalkAdapter.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'dingtalk',
  displayName: 'DingTalk',
  requiredConfigFields: ['clientId', 'clientSecret'],
  createChannel: (name, config, bridge, options) =>
    new DingtalkChannel(name, config, bridge, options),
};
