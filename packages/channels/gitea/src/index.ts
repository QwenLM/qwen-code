export { GiteaChannel } from './GiteaAdapter.js';

import { GiteaChannel } from './GiteaAdapter.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'gitea',
  displayName: 'Gitea',
  requiredConfigFields: ['token'],
  envResolvableConfigFields: ['baseUrl'],
  createChannel: (name, config, bridge, options) =>
    new GiteaChannel(name, config, bridge, options),
};
