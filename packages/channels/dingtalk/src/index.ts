export { DingtalkChannel } from './DingtalkAdapter.js';
export { DingtalkWebhookChannel } from './DingtalkWebhookChannel.js';
export { webhookPlugin } from './webhook-plugin.js';
export { downloadMedia } from './media.js';
export {
  ManagedDingtalkAdapter,
  dingtalkSettings,
} from './managed-dingtalk-adapter.js';
export type {
  DingtalkReplyContext,
  DingtalkSettings,
  ManagedDingtalkAdapterDeps,
  ManagedDingtalkAdapterOptions,
} from './managed-dingtalk-adapter.js';
export { createManagedDingtalkDeps } from './managed-dingtalk-deps.js';

import { DingtalkChannel } from './DingtalkAdapter.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';
import { DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM } from './interactive-card-types.js';

export const plugin: ChannelPlugin = {
  channelType: 'dingtalk',
  displayName: 'DingTalk',
  requiredConfigFields: ['clientId', 'clientSecret'],
  // The runtime resolves env references from this list (plus the known
  // credential fields); the settings store keys on management.fields[].
  // envResolvable. Both must name cardTemplateId or a $VAR template id reaches
  // the card API unresolved and every reply is terminally rejected (R2-3).
  envResolvableConfigFields: ['cardTemplateId'],
  supportsOutputMode: true,
  management: {
    fields: [
      {
        key: 'clientId',
        label: 'Client ID',
        kind: 'string',
        required: true,
        envResolvable: true,
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        kind: 'secret',
        required: true,
        envResolvable: true,
      },
      {
        key: 'cardTemplateId',
        label: 'Card Template ID',
        kind: 'string',
        envResolvable: true,
        description:
          'Operator-authored DingTalk card template id. When set, the managed ' +
          'path (managed-dingtalk) renders each reply as one interactive card ' +
          'instead of text messages; absent keeps the text path.',
      },
      {
        key: 'interactiveCards',
        label: 'Interactive Cards',
        kind: 'object',
        properties: [
          {
            key: 'enabled',
            label: 'Enabled',
            kind: 'boolean',
          },
          {
            key: 'statusCard',
            label: 'Status Card',
            kind: 'object',
            properties: [
              {
                key: 'enabled',
                label: 'Enabled',
                kind: 'boolean',
              },
              {
                key: 'showModel',
                label: 'Show Model',
                kind: 'boolean',
                description:
                  'Show the active session model in the status card footer; defaults to enabled',
              },
              {
                key: 'showReasoningEffort',
                label: 'Show Reasoning Effort',
                kind: 'boolean',
                description:
                  'Show the active session reasoning effort in the status card footer when available; defaults to enabled',
              },
            ],
          },
          {
            key: 'questionCard',
            label: 'Question Card',
            kind: 'object',
            properties: [
              {
                key: 'enabled',
                label: 'Enabled',
                kind: 'boolean',
              },
              {
                key: 'timeoutMs',
                label: 'Timeout (ms)',
                kind: 'number',
                exclusiveMinimum:
                  DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM,
              },
            ],
          },
          {
            key: 'permissionCard',
            label: 'Permission Card',
            kind: 'object',
            properties: [
              {
                key: 'enabled',
                label: 'Enabled',
                kind: 'boolean',
              },
              {
                key: 'timeoutMs',
                label: 'Timeout (ms)',
                kind: 'number',
                exclusiveMinimum:
                  DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM,
              },
            ],
          },
        ],
      },
    ],
  },
  createChannel: (name, config, bridge, options) =>
    new DingtalkChannel(name, config, bridge, options),
};
