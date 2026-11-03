import type { ChannelPlugin } from '@qwen-code/channel-base';
import { GithubChannel, validateBoundSessionConfig } from './GithubAdapter.js';

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
        description:
          'Must be "Open", "Allowlist", or "Pairing" for notifications to flow',
        default: 'open',
        options: [
          { value: 'open', label: 'Open' },
          { value: 'allowlist', label: 'Allowlist' },
          { value: 'pairing', label: 'Pairing' },
          { value: 'disabled', label: 'Disabled' },
        ],
      },
      {
        key: 'reasonFilter',
        label: 'Reason Filter',
        kind: 'string-list',
        description:
          'Optional. Only notifications with a selected reason are processed. ' +
          'Leave every reason unselected to process all of them.',
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
      {
        key: 'deliverToBoundSessions',
        label: 'Deliver To PR-Bound Sessions',
        kind: 'boolean',
        description:
          'Deliver events for PRs bound to a live session into that session as a prompt, instead of a channel-owned session. Requires a daemon-managed channel.',
        default: 'false',
      },
      {
        key: 'prWatchEvents',
        label: 'PR Watch Events',
        kind: 'string-list',
        description:
          'Optional. State transitions to watch for bound PRs (requires Deliver To PR-Bound Sessions). Leave empty to disable.',
        options: [
          { value: 'ci_failure', label: 'ci_failure' },
          { value: 'merge_conflict', label: 'merge_conflict' },
          { value: 'head_change', label: 'head_change' },
          { value: 'state_change', label: 'state_change' },
        ],
      },
    ],
    validateConfig: (config) => {
      const token =
        typeof config['token'] === 'string' ? config['token'].trim() : '';
      if (!token && config['useLocalGh'] !== true) {
        return 'Channel requires a token or local GitHub CLI authentication (useLocalGh).';
      }
      return validateBoundSessionConfig(config, 'github');
    },
  },
  createChannel: (name, config, bridge, options) =>
    new GithubChannel(name, config, bridge, options),
};
