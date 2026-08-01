import type { ChannelPlugin } from '@qwen-code/channel-base';
import { GitlabChannel } from './GitlabAdapter.js';

export { GitlabChannel };

export const plugin: ChannelPlugin = {
  channelType: 'gitlab',
  displayName: 'GitLab',
  requiredConfigFields: ['token'],
  envResolvableConfigFields: ['baseUrl'],
  defaultSessionScope: 'chat_thread',
  management: {
    fields: [
      {
        key: 'token',
        label: 'Personal Access Token',
        kind: 'secret',
        required: true,
        envResolvable: true,
      },
      {
        key: 'baseUrl',
        label: 'Base URL',
        kind: 'string',
        envResolvable: true,
      },
    ],
  },
  createChannel: (name, config, bridge, options) =>
    new GitlabChannel(name, config, bridge, options),
};
