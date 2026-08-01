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
      {
        key: 'groupPolicy',
        label: 'Group Policy',
        kind: 'enum',
        required: true,
        options: [
          { value: 'open', label: 'Open' },
          { value: 'allowlist', label: 'Allowlist' },
          { value: 'disabled', label: 'Disabled' },
        ],
      },
      {
        key: 'senderPolicy',
        label: 'Sender Policy',
        kind: 'enum',
        required: true,
        options: [
          { value: 'allowlist', label: 'Allowlist' },
          { value: 'pairing', label: 'Pairing' },
          { value: 'open', label: 'Open' },
        ],
      },
      {
        key: 'allowedUsers',
        label: 'Allowed Users',
        kind: 'string-list',
      },
    ],
  },
  createChannel: (name, config, bridge, options) =>
    new GitlabChannel(name, config, bridge, options),
};
