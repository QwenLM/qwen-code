import {
  MAX_POLL_INTERVAL_MS,
  PR_BINDING_ROLES,
} from '@qwen-code/channel-base';
import type { ChannelPlugin } from '@qwen-code/channel-base';
import {
  GithubChannel,
  validateBoundSessionConfig,
  PR_NOTIFICATION_REASONS,
  PR_WATCH_EVENTS,
} from './GithubAdapter.js';

/**
 * The boundSessionActions key options offered by management UIs: the
 * fallback, every event class, and each role-qualified spelling — built
 * from the same constants the validator enforces so the three cannot
 * drift (the PR_WATCH_EVENTS pattern, R2-18).
 */
const BOUND_ACTION_KEY_OPTIONS = [
  { value: 'default', label: 'default — fallback for any unmatched event' },
  ...PR_WATCH_EVENTS.map((event) => ({
    value: `watch:${event}`,
    label: `watch:${event}`,
  })),
  ...PR_NOTIFICATION_REASONS.map((reason) => ({
    value: reason,
    label: reason,
  })),
  ...PR_BINDING_ROLES.flatMap((role) => [
    { value: `${role}:default`, label: `${role}:default` },
    ...PR_WATCH_EVENTS.map((event) => ({
      value: `${role}:watch:${event}`,
      label: `${role}:watch:${event}`,
    })),
    ...PR_NOTIFICATION_REASONS.map((reason) => ({
      value: `${role}:${reason}`,
      label: `${role}:${reason}`,
    })),
  ]),
];

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
        key: 'pollInterval',
        label: 'Poll Interval (ms)',
        kind: 'number',
        exclusiveMinimum: 0,
        maximum: MAX_POLL_INTERVAL_MS,
        default: '60000',
        description:
          'How often to poll the notifications API, in ms. Kept between 1 and 86400000 (one day): a smaller positive value is raised to 1. Leave empty for 60000',
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
        // Built from the adapter's exported vocabulary so the UI options
        // can never drift from the boundSessionActions key validator.
        options: PR_NOTIFICATION_REASONS.map((value) => ({
          value,
          label: value,
        })),
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
        // Built from the adapter's exported vocabulary so the UI options can
        // never drift from the validator/emit path (R2-18).
        options: PR_WATCH_EVENTS.map((value) => ({ value, label: value })),
      },
      {
        key: 'boundSessionActions',
        label: 'Bound Session Actions',
        kind: 'record',
        description:
          'Optional. Operator instruction templates delivered to PR-bound sessions, keyed by event class (watch:<type> or a notification reason), optionally role-qualified (review:, verify:, fix:). Requires Deliver To PR-Bound Sessions. With templates configured, each role gets its own delivery (one winner per role); a role with no matching key skips the event. Template variables: %repo%, %pr%, %url%, %title%, %event%, %sender%, %role%. Use %% for a literal %. Leave empty for the default generic prompt.',
        options: BOUND_ACTION_KEY_OPTIONS,
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
