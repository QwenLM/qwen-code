import type { ChannelPlugin } from '@qwen-code/channel-base';
import { GithubChannel } from './GithubAdapter.js';

export { GithubChannel };

export const plugin: ChannelPlugin = {
  channelType: 'github',
  displayName: 'GitHub',
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
    new GithubChannel(name, config, bridge, options),
};
