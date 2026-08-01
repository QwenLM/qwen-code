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
        description: 'PAT with "read_api" + "api" scopes',
      },
      {
        key: 'baseUrl',
        label: 'Base URL',
        kind: 'string',
        envResolvable: true,
        description:
          'Self-hosted instance URL (e.g. https://gitlab.example.com). Leave empty for gitlab.com',
      },
      {
        key: 'groupPolicy',
        label: 'Group Policy',
        kind: 'enum',
        required: true,
        description: 'Must be "Open" or "Allowlist" for todos to be processed',
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
        description: 'Use "Allowlist" with allowed users on public projects',
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
        description: 'GitLab usernames, used by Allowlist and Pairing policies',
      },
    ],
  },
  createChannel: (name, config, bridge, options) =>
    new GitlabChannel(name, config, bridge, options),
};
