import type { ChannelPlugin } from '@qwen-code/channel-base';
import { GithubChannel } from './GithubAdapter.js';

export const plugin: ChannelPlugin = {
  channelType: 'github',
  displayName: 'GitHub',
  requiredConfigFields: ['token'],
  envResolvableConfigFields: ['baseUrl'],
  createChannel: (name, config, bridge, options) =>
    new GithubChannel(name, config, bridge, options),
};
