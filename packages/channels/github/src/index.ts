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
        description: 'Classic PAT with "notifications" scope',
      },
      {
        key: 'baseUrl',
        label: 'Base URL',
        kind: 'string',
        envResolvable: true,
        description:
          'GitHub Enterprise API root (e.g. https://ghe.example.com/api/v3). Leave empty for github.com',
      },
      {
        key: 'groupPolicy',
        label: 'Group Policy',
        kind: 'enum',
        required: true,
        description: 'Must be "Open" for notifications to flow',
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
        description: 'Use "Allowlist" with allowed users on public repos',
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
        description: 'GitHub usernames, used by Allowlist and Pairing policies',
      },
      {
        key: 'reasonFilter',
        label: 'Reason Filter',
        kind: 'string-list',
        description:
          'Optional. Comma-separated notification reasons to process. ' +
          'Valid values: mention, review_requested, assign, author, comment, ' +
          'ci_activity, manual, state_change, subscribed, team_mention, ' +
          'security_alert, approval_requested, invitation, ' +
          'member_feature_requested, security_advisory_credit. ' +
          'Leave empty to process all.',
      },
    ],
  },
  createChannel: (name, config, bridge, options) =>
    new GithubChannel(name, config, bridge, options),
};
