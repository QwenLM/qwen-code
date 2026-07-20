export { GitlabChannel } from './GitlabAdapter.js';

import { GitlabChannel } from './GitlabAdapter.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'gitlab',
  displayName: 'GitLab',
  requiredConfigFields: ['token'],
  envResolvableConfigFields: ['baseUrl'],
  createChannel: (name, config, bridge, options) =>
    new GitlabChannel(name, config, bridge, options),
};
