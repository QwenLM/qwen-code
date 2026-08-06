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
      {
        key: 'action_prompt_template',
        label: 'Action Templates',
        kind: 'record',
        required: true,
        description:
          'Only actions with a template are processed; others are skipped. ' +
          'Template variables: %project%, %project_url%, %author%, %target_type%, %iid%, %title%, %description%, %todo_id%. ' +
          'Use %% for a literal %. ' +
          'Example for "mentioned": Project: %project% | Author: %author% | Title: %title%',
        options: [
          {
            value: 'mentioned',
            label: 'Mentioned — @bot in a comment or description',
          },
          {
            value: 'directly_addressed',
            label: 'Directly Addressed — comment starts with @bot',
          },
          {
            value: 'assigned',
            label: 'Assigned — bot assigned to an issue or MR',
          },
          {
            value: 'review_requested',
            label: 'Review Requested — bot requested as MR reviewer',
          },
          {
            value: 'approval_required',
            label: 'Approval Required — MR needs bot approval',
          },
          {
            value: 'marked',
            label: "Marked — someone stars bot's comment/issue/MR",
          },
          {
            value: 'build_failed',
            label: 'Build Failed — CI/CD pipeline fails on bot branch/MR',
          },
          {
            value: 'unmergeable',
            label: 'Unmergeable — MR becomes unmergeable (conflicts)',
          },
          {
            value: 'merge_train_removed',
            label: 'Merge Train Removed — MR removed from merge train',
          },
        ],
      },
    ],
  },
  createChannel: (name, config, bridge, options) =>
    new GitlabChannel(name, config, bridge, options),
};
