import type { ChannelPlugin } from '@qwen-code/channel-base';
import { MAX_POLL_INTERVAL_MS } from '@qwen-code/channel-base';
import { AoneChannel, validateAoneConfig } from './AoneAdapter.js';

export { AoneChannel } from './AoneAdapter.js';
export { validateAoneConfig } from './AoneAdapter.js';

export const plugin: ChannelPlugin = {
  channelType: 'aone',
  displayName: 'Aone',
  requiredConfigFields: ['repos', 'triggerPrefixes'],
  defaultSessionScope: 'chat_thread',
  management: {
    fields: [
      {
        key: 'repos',
        label: 'Repositories',
        kind: 'string-list',
        required: true,
        description:
          'Aone repository paths to watch (group/project, nested groups allowed). ' +
          'There is no notification inbox on Aone, so the watch list is explicit. ' +
          'Example: middleware/tddl5',
      },
      {
        key: 'triggerPrefixes',
        label: 'Trigger Prefixes',
        kind: 'string-list',
        required: true,
        description:
          'A CR comment triggers the agent when its body starts with any of these prefixes ' +
          '(case-insensitive). The matched prefix is stripped from the prompt. Example: qwen:',
      },
      {
        key: 'groupPolicy',
        label: 'Group Policy',
        kind: 'enum',
        required: true,
        description:
          'Every Aone inbound is group-shaped (repository traffic), so this gates dispatch. ' +
          '"Open" admits any watched repository; "Allowlist" requires the repository listed under groups; ' +
          '"Pairing" requires one-time group approval. Declared here (default open) because the shared ' +
          'injected field defaults to disabled, which would dispatch nothing.',
        default: 'open',
        options: [
          { value: 'open', label: 'Open' },
          { value: 'allowlist', label: 'Allowlist' },
          { value: 'pairing', label: 'Pairing' },
          { value: 'disabled', label: 'Disabled' },
        ],
      },
      {
        key: 'promptTemplate',
        label: 'Prompt Metadata Template',
        kind: 'string',
        multiline: true,
        description:
          'Metadata appended to the prompt (the comment body stays the message text). ' +
          'Variables: %repo%, %mr_id%, %mr_iid%, %author%, %comment_id%, %title%, %url%. ' +
          '%title%/%url% fetch the MR view (one call per MR per poll). Use %% for a literal %. ' +
          'Leave empty for the default template.',
      },
      {
        key: 'pollInterval',
        label: 'Poll Interval (ms)',
        kind: 'number',
        exclusiveMinimum: 0,
        maximum: MAX_POLL_INTERVAL_MS,
        default: '60000',
        description:
          "How often to poll each repository's comment event stream. Default 60000 (one minute).",
      },
    ],
    validateConfig: (config) => validateAoneConfig(config, 'aone'),
  },
  createChannel: (name, config, bridge, options) =>
    new AoneChannel(name, config, bridge, options),
};
