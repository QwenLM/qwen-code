export { FeishuChannel } from './FeishuAdapter.js';
export { downloadMedia } from './media.js';

import { FeishuChannel } from './FeishuAdapter.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'feishu',
  displayName: 'Feishu',
  requiredConfigFields: ['clientId', 'clientSecret'],
  createChannel: (name, config, bridge, options) =>
    new FeishuChannel(name, config, bridge, options),
};
