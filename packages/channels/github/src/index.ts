export { GithubChannel } from './GithubAdapter.js';

import { GithubChannel } from './GithubAdapter.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'github',
  displayName: 'GitHub',
  requiredConfigFields: ['token'],
  envResolvableConfigFields: ['baseUrl'],
  createChannel: (name, config, bridge, options) =>
    new GithubChannel(name, config, bridge, options),
};
