import type { ChannelPlugin } from '@qwen-code/channel-base';
import { GitlabChannel } from './GitlabAdapter.js';

export { GitlabChannel };

export const plugin: ChannelPlugin = {
  channelType: 'gitlab',
  displayName: 'GitLab',
  requiredConfigFields: ['token'],
  envResolvableConfigFields: ['baseUrl'],
  defaultSessionScope: 'chat_thread',
  createChannel: (name, config, bridge, options) =>
    new GitlabChannel(name, config, bridge, options),
};
