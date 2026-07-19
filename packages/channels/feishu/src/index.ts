export { FeishuChannel } from './FeishuAdapter.js';
export { downloadMedia } from './media.js';

import { FeishuChannel } from './FeishuAdapter.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'feishu',
  displayName: 'Feishu',
  requiredConfigFields: ['clientId', 'clientSecret'],
  management: {
    fields: [
      {
        key: 'clientId',
        label: 'App ID',
        kind: 'string',
        required: true,
        envResolvable: true,
      },
      {
        key: 'clientSecret',
        label: 'App Secret',
        kind: 'secret',
        required: true,
        envResolvable: true,
      },
    ],
    auth: ['credentials'],
  },
  createChannel: (name, config, bridge, options) =>
    new FeishuChannel(name, config, bridge, options),
};
