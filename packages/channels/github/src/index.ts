import type { ChannelPlugin } from '@qwen-code/channel-base';
import { GithubChannel } from './GithubAdapter.js';

export { GithubChannel };

export const plugin: ChannelPlugin = {
  channelType: 'github',
  displayName: 'GitHub',
  requiredConfigFields: ['token'],
  envResolvableConfigFields: ['baseUrl'],
  defaultSessionScope: 'chat_thread',
  createChannel: (name, config, bridge, options) =>
    new GithubChannel(name, config, bridge, options),
};
