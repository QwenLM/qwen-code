/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChannelPlugin } from '@qwen-code/channel-base';
import { DwsChannel } from './dws-channel.js';

export { DwsChannel };
export { DwsClient, DwsCommandError, parseDwsImEvent } from './dws-client.js';
export type {
  DwsCommandOutcome,
  DwsClientLike,
  DwsClientOptions,
  DwsIdentity,
  DwsImMessage,
  DwsImSource,
  DwsImTarget,
  DwsMessageHistoryPage,
  DwsTodoTask,
} from './dws-client.js';
export {
  DwsEventProcessError,
  startDwsEventProcess,
} from './dws-event-stream.js';
export type {
  DwsEventProcessStarter,
  DwsEventSubscription,
} from './dws-event-stream.js';

export const plugin: ChannelPlugin = {
  channelType: 'dws',
  displayName: 'DingTalk Workspace',
  envResolvableConfigFields: ['profile'],
  defaultSessionScope: 'chat_thread',
  management: {
    fields: [
      {
        key: 'profile',
        label: 'DWS profile',
        kind: 'string',
        envResolvable: true,
        description:
          'Exact profile name or corpId from dws profile list. Leave empty to pin the active profile at startup',
      },
      {
        key: 'groupPolicy',
        label: 'Group Policy',
        kind: 'enum',
        required: true,
        default: 'pairing',
        description:
          'Controls which DingTalk group conversations may start tasks',
        options: [
          { value: 'pairing', label: 'Pairing' },
          { value: 'allowlist', label: 'Allowlist' },
          { value: 'open', label: 'Open' },
          { value: 'disabled', label: 'Disabled' },
        ],
      },
      {
        key: 'senderPolicy',
        label: 'Sender Policy',
        kind: 'enum',
        required: true,
        default: 'pairing',
        description:
          'Controls which DingTalk users may start direct-message, document-notification, native-todo, and non-paired group tasks',
        options: [
          { value: 'pairing', label: 'Pairing' },
          { value: 'allowlist', label: 'Allowlist' },
          { value: 'open', label: 'Open' },
        ],
      },
      {
        key: 'allowedUsers',
        label: 'Allowed Users',
        kind: 'string-list',
        description: 'DingTalk IDs used by Allowlist and Pairing policies',
      },
      {
        key: 'watchTodos',
        label: 'Watch Native Todos',
        kind: 'boolean',
        description:
          'Poll pending todos assigned to this DWS account and run newly assigned or changed tasks',
      },
    ],
    validateConfig: (config) => {
      if (
        config['profile'] !== undefined &&
        (typeof config['profile'] !== 'string' ||
          !config['profile'].trim() ||
          config['profile'].includes(','))
      ) {
        return 'DWS profile must select exactly one login profile.';
      }
      if (
        config['approvalMode'] !== undefined &&
        config['approvalMode'] !== 'default' &&
        config['approvalMode'] !== 'plan' &&
        config['approvalMode'] !== 'yolo'
      ) {
        return 'DWS channels require approvalMode "default", "plan", or "yolo".';
      }
      if (
        config['watchTodos'] !== undefined &&
        typeof config['watchTodos'] !== 'boolean'
      ) {
        return 'DWS watchTodos must be a boolean.';
      }
      return undefined;
    },
  },
  createChannel: (name, config, bridge, options) =>
    new DwsChannel(name, config, bridge, options),
};
