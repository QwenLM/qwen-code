import {
  MAX_POLL_INTERVAL_MS,
  PR_BINDING_ROLES,
} from '@qwen-code/channel-base';
import type { ChannelPlugin } from '@qwen-code/channel-base';
import {
  GithubChannel,
  validateBoundSessionConfig,
  DEFAULT_PR_WATCH_LIMIT,
  MAX_PR_WATCH_LIMIT,
  DEFAULT_PR_WATCH_BUDGET_RESERVE,
  MAX_PR_WATCH_BUDGET_RESERVE,
  validateRepoFilterConfig,
  PR_NOTIFICATION_REASONS,
  PR_WATCH_EVENTS,
  REPO_FILTER_MODES,
} from './GithubAdapter.js';

/**
 * One-line meaning of each unqualified boundSessionActions key, shown by
 * management UIs next to the key and in the add picker. Role-qualified
 * keys reuse their base event's description; the role's job is named by
 * the picker group header instead.
 */
const BOUND_ACTION_DESCRIPTIONS: Record<string, string> = {
  default: 'Fallback template for any event without a more specific key',
  'watch:ci_failure': 'CI checks turn red on a head commit',
  'watch:merge_conflict': 'The PR develops a merge conflict',
  'watch:head_change': 'The PR’s head commit changes',
  'watch:state_change': 'The PR is merged or closed',
  mention: 'You are @mentioned in a comment',
  review_requested: 'A review is requested from you',
  assign: 'You are assigned to the PR',
  author: 'Activity on a PR you authored',
  comment: 'A new comment on a subscribed PR',
  ci_activity: 'CI activity on a subscribed PR',
  manual: 'You subscribed to the PR manually',
  state_change: 'The PR is closed or merged',
  subscribed: 'Activity on a PR you subscribed to',
  team_mention: 'A team you belong to is @mentioned',
  security_alert: 'A security alert on the repository',
  approval_requested: 'Approval is requested from you',
  invitation: 'You are invited to collaborate',
  member_feature_requested: 'A member feature request notification',
  security_advisory_credit: 'You are credited in a security advisory',
};

/**
 * The boundSessionActions key options offered by management UIs: the
 * fallback, every event class, and each role-qualified spelling — built
 * from the same constants the validator enforces so the three cannot
 * drift (the PR_WATCH_EVENTS pattern, R2-18). `group` buckets the picker
 * by binding role; `description` explains each key.
 */
const BOUND_ACTION_BASE_OPTIONS = [
  'default',
  ...PR_WATCH_EVENTS.map((event) => `watch:${event}`),
  ...PR_NOTIFICATION_REASONS,
].map((value) => ({
  value,
  label: value,
  description: BOUND_ACTION_DESCRIPTIONS[value],
}));

const BOUND_ACTION_KEY_OPTIONS = [
  ...BOUND_ACTION_BASE_OPTIONS.map((option) => ({ ...option, group: 'any' })),
  ...PR_BINDING_ROLES.flatMap((role) =>
    BOUND_ACTION_BASE_OPTIONS.map((option) => ({
      value: `${role}:${option.value}`,
      label: `${role}:${option.value}`,
      description: option.description,
      group: role,
    })),
  ),
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
          "How often to poll the notifications API, in ms. Kept between 1 and 86400000 (one day): a smaller positive value is raised to 1. Leave empty for 60000. A steady-state poll is raised to the endpoint's X-Poll-Interval when that is larger, which paces the PR watch too; at the 60000 default the header is also 60s, so nothing changes",
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
        key: 'repoFilterMode',
        label: 'Repository Filter',
        kind: 'enum',
        default: 'off',
        description:
          'Filter incoming notifications by repository: allowlist processes only the listed repositories, blocklist processes all except the listed ones. Notifications about PRs bound to a session are filtered too; only their PR state watch events bypass the filter.',
        // Built from the adapter's exported vocabulary so the UI options
        // cannot drift from the validator (the PR_WATCH_EVENTS pattern).
        options: REPO_FILTER_MODES.map((value) => ({ value, label: value })),
      },
      {
        key: 'repoFilter',
        label: 'Filtered Repositories',
        kind: 'string-list',
        description:
          'Comma-separated owner/repo repository names used by the repository filter. Requires Repository Filter to be set to allowlist or blocklist.',
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
        key: 'prCommentWatch',
        label: 'PR Comment Watch',
        kind: 'boolean',
        description:
          'Poll conversation and inline review comments on bound PRs and deliver each new one to every bound session that did not post it (including comments by the same GitHub account used by another session/agent). Requires Deliver To PR-Bound Sessions. Enabled by default; set false to disable.',
        default: 'true',
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
        key: 'prWatchLimit',
        label: 'PR Watch Limit',
        kind: 'number',
        exclusiveMinimum: 0,
        maximum: MAX_PR_WATCH_LIMIT,
        default: String(DEFAULT_PR_WATCH_LIMIT),
        description:
          'Maximum open bound PRs watched per poll (requires Deliver To PR-Bound Sessions and PR Watch Events). Open PRs keep the full budget; merged/closed bindings drain in an additional slice (20% of the limit, at least one) outside it, so they never crowd out open PRs. Each watched PR still issues about one pulls.get per poll, but an unchanged PR answers 304 and costs no primary rate limit, so the state watch is near-free while PRs are quiet. What still counts is the default-on comment watch (~60 requests/hour per PR) and the periodic CI re-checks, so size the budget against those rather than the state watch. An over-budget configuration makes every watch pass abort on rate limits. Raise Poll Interval when raising this. Leave empty for the default.',
      },
      {
        key: 'prWatchBudgetReserve',
        label: 'PR Watch Budget Reserve',
        kind: 'number',
        exclusiveMinimum: -1,
        maximum: MAX_PR_WATCH_BUDGET_RESERVE,
        default: String(DEFAULT_PR_WATCH_BUDGET_RESERVE),
        description:
          'REST requests held back for the interactive notification lane (requires Deliver To PR-Bound Sessions and PR Watch Events). When the last known remaining budget is at or below this, the PR state watch is skipped for that poll — and stopped mid-pass if a pass spends down to it — so a human mention is not starved by background polling; detection resumes once the budget recovers or its window resets. The default (200) is ~4% of a 5000/hour PAT budget. Set 0 to disable the gate. Leave empty for the default.',
      },
      {
        key: 'boundSessionActions',
        label: 'Bound Session Actions',
        kind: 'record',
        description:
          'Optional. Instruction templates delivered to PR-bound sessions. Pick an event key below; a role prefix (review:, verify:, fix:) targets that binding role only. Requires Deliver To PR-Bound Sessions. Each role with a matching key gets its own delivery; roles without one skip the event. Variables: %repo%, %pr%, %url%, %title%, %event%, %sender%, %role%; %% for a literal %. Leave empty for the default generic prompt.',
        options: BOUND_ACTION_KEY_OPTIONS,
      },
    ],
    validateConfig: (config) => {
      const token =
        typeof config['token'] === 'string' ? config['token'].trim() : '';
      if (!token && config['useLocalGh'] !== true) {
        return 'Channel requires a token or local GitHub CLI authentication (useLocalGh).';
      }
      return (
        validateBoundSessionConfig(config, 'github') ??
        validateRepoFilterConfig(config, 'github')
      );
    },
  },
  createChannel: (name, config, bridge, options) =>
    new GithubChannel(name, config, bridge, options),
};
