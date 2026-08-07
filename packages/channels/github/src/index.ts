import type { ChannelPlugin } from '@qwen-code/channel-base';
import { GithubChannel } from './GithubAdapter.js';

export { GithubChannel };

export const plugin: ChannelPlugin = {
  channelType: 'github',
  displayName: 'GitHub',
  envResolvableConfigFields: ['baseUrl'],
  defaultSessionScope: 'chat_thread',
  management: {
    fields: [
      {
        key: 'token',
        label: 'Personal Access Token',
        kind: 'secret',
        envResolvable: true,
        description:
          'Optional classic PAT with "notifications" scope. Overrides local gh authentication',
      },
      {
        key: 'useLocalGh',
        label: 'Use Local GitHub CLI Authentication',
        kind: 'boolean',
        description:
          'Reuse the daemon host GitHub CLI login when no token is configured',
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
        default: 'open',
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
          'Leave empty to process all.',
        options: [
          { value: 'mention', label: 'mention' },
          { value: 'review_requested', label: 'review_requested' },
          { value: 'assign', label: 'assign' },
          { value: 'author', label: 'author' },
          { value: 'comment', label: 'comment' },
          { value: 'ci_activity', label: 'ci_activity' },
          { value: 'manual', label: 'manual' },
          { value: 'state_change', label: 'state_change' },
          { value: 'subscribed', label: 'subscribed' },
          { value: 'team_mention', label: 'team_mention' },
          { value: 'security_alert', label: 'security_alert' },
          { value: 'approval_requested', label: 'approval_requested' },
          { value: 'invitation', label: 'invitation' },
          {
            value: 'member_feature_requested',
            label: 'member_feature_requested',
          },
          {
            value: 'security_advisory_credit',
            label: 'security_advisory_credit',
          },
        ],
      },
    ],
    validateConfig: (config) => {
      const token =
        typeof config['token'] === 'string' ? config['token'].trim() : '';
      if (!token && config['useLocalGh'] !== true) {
        return 'Channel requires a token or local GitHub CLI authentication (useLocalGh).';
      }
      return undefined;
    },
  },
  createChannel: (name, config, bridge, options) =>
    new GithubChannel(name, config, bridge, options),
};
