export { DingtalkChannel } from './DingtalkAdapter.js';
export { downloadMedia } from './media.js';

import { DingtalkChannel } from './DingtalkAdapter.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'dingtalk',
  displayName: 'DingTalk',
  requiredConfigFields: ['clientId', 'clientSecret'],
  management: {
    fields: [
      {
        key: 'clientId',
        label: 'Client ID',
        kind: 'string',
        required: true,
        envResolvable: true,
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        kind: 'secret',
        required: true,
        envResolvable: true,
      },
    ],
    auth: ['credentials'],
  },
  createChannel: (name, config, bridge, options) =>
    new DingtalkChannel(name, config, bridge, options),
};
